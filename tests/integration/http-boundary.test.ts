/**
 * Spine HTTP boundary — integration tests over a real server.
 *
 * What this defends: the translation layer only the spine owns — status mapping, the
 * fail-closed default for unexpected errors, actor resolution, body limits, and static
 * traversal refusal. These are properties of the boundary, not of the Projects module, so
 * they are asserted here and nowhere else.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp, type Application } from '../../src/spine/app.ts';
import { loadConfig } from '../../src/spine/config.ts';
import { translateError } from '../../src/spine/http.ts';
import { AppError } from '../../src/spine/errors.ts';
import { SESSION_COOKIE } from '../../src/spine/session.ts';

let app: Application;
let server: Server;
let baseUrl: string;

/**
 * LOCAL config with telemetry off and storage in memory: no exporter socket, no files.
 *
 * The configured port is irrelevant here — each test binds an ephemeral port directly, so
 * parallel test files never collide.
 */
function testConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    FL_DATABASE_PATH: ':memory:',
    FL_OTLP_ENDPOINT: '',
    FL_SESSION_SECRET: 'test-secret-not-a-real-key',
    ...overrides,
  });
}

/** Sign in and return the raw Cookie header value for an authenticated request. */
async function signIn(url: string, email: string, password: string): Promise<string> {
  const response = await fetch(`${url}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 201, 'sign-in failed');
  const setCookie = response.headers.getSetCookie()[0];
  return setCookie.split(';')[0];
}

/** Authenticated request helper: JSON content type plus the session cookie. */
function authed(cookie: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) },
  };
}

/**
 * A gateway that fails the test if anything calls a provider.
 *
 * The capability contract claims no automated test spends subscription capacity. That was
 * true only because authorization refused first — a property, not a structure. This makes
 * it structural: a regression that let a call through fails loudly instead of billing.
 */
const NEVER_CALLED = {
  provider: 'never-called',
  complete: async (): Promise<never> => {
    throw new Error('a test reached a real AI provider — tests must never spend subscription capacity');
  },
};

const PASSWORD = 'correct-horse-battery-staple';
let cookie: string;

before(async () => {
  app = buildApp(testConfig(), NEVER_CALLED);
  server = createServer(app.listener);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const provisioning = app.modules.customers.provisioning;
  const acme = provisioning.provisionCustomer('Acme');
  provisioning.provisionUser(acme.id, 'ana@acme.test', PASSWORD);
  cookie = await signIn(baseUrl, 'ana@acme.test', PASSWORD);
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  app.close();
});

describe('status mapping', () => {
  test('a created project responds 201 with the project as data', async () => {
    const response = await fetch(`${baseUrl}/api/projects`, authed(cookie, {
      method: 'POST',
      body: JSON.stringify({ name: 'Apollo' }),
    }));

    assert.equal(response.status, 201);
    const { data } = await response.json();
    assert.equal(data.name, 'Apollo');
    assert.equal(data.status, 'active');
  });

  test('a validation failure responds 400 and names the offending fields', async () => {
    const response = await fetch(`${baseUrl}/api/projects`, authed(cookie, {
      method: 'POST',
      body: JSON.stringify({ name: '', description: 'x'.repeat(2001) }),
    }));

    assert.equal(response.status, 400);
    const { error } = await response.json();
    assert.equal(error.kind, 'validation');
    assert.deepEqual(Object.keys(error.details).sort(), ['description', 'name']);
  });

  test('an unknown project responds 404', async () => {
    const response = await fetch(`${baseUrl}/api/projects/does-not-exist`, authed(cookie));
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.kind, 'not_found');
  });

  test('malformed JSON is a client error, not a crash', async () => {
    const response = await fetch(`${baseUrl}/api/projects`, authed(cookie, {
      method: 'POST',
      body: '{not json',
    }));
    assert.equal(response.status, 400);
  });

  test('an oversized body is refused by the body limit, not incidentally by field validation', async () => {
    // The payload is otherwise VALID — an over-long name would fail domain validation and
    // return 400 even with the body limit removed, so it proved nothing about the limit.
    const response = await fetch(`${baseUrl}/api/projects`, authed(cookie, {
      method: 'POST',
      body: JSON.stringify({ name: 'Apollo', description: 'x'.repeat(70_000) }),
    }));

    assert.equal(response.status, 400);
    const { error } = await response.json();
    assert.equal(error.message, 'That request is too large.');
  });
});

describe('archive over HTTP', () => {
  test('archiving is a POST that returns the transitioned project', async () => {
    const created = await (await fetch(`${baseUrl}/api/projects`, authed(cookie, {
      method: 'POST', body: JSON.stringify({ name: 'To archive' }),
    }))).json();

    const response = await fetch(`${baseUrl}/api/projects/${created.data.id}/archive`, authed(cookie, { method: 'POST' }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.status, 'archived');
  });

  test('archiving twice responds 409, so a client can tell which call took effect', async () => {
    const created = await (await fetch(`${baseUrl}/api/projects`, authed(cookie, {
      method: 'POST', body: JSON.stringify({ name: 'Twice archived' }),
    }))).json();

    await fetch(`${baseUrl}/api/projects/${created.data.id}/archive`, authed(cookie, { method: 'POST' }));
    const second = await fetch(`${baseUrl}/api/projects/${created.data.id}/archive`, authed(cookie, { method: 'POST' }));

    assert.equal(second.status, 409);
    assert.equal((await second.json()).error.kind, 'conflict');
  });

  test('editing an archived project responds 409', async () => {
    const created = await (await fetch(`${baseUrl}/api/projects`, authed(cookie, {
      method: 'POST', body: JSON.stringify({ name: 'Frozen' }),
    }))).json();
    await fetch(`${baseUrl}/api/projects/${created.data.id}/archive`, authed(cookie, { method: 'POST' }));

    const edit = await fetch(`${baseUrl}/api/projects/${created.data.id}`, authed(cookie, {
      method: 'PATCH', body: JSON.stringify({ name: 'Renamed' }),
    }));
    assert.equal(edit.status, 409);
  });

  test('archiving requires authentication like every other capability', async () => {
    const anonymous = await fetch(`${baseUrl}/api/projects/anything/archive`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
    });
    assert.equal(anonymous.status, 401);
  });

  test('archiving is subject to the CSRF content-type gate', async () => {
    const created = await (await fetch(`${baseUrl}/api/projects`, authed(cookie, {
      method: 'POST', body: JSON.stringify({ name: 'CSRF archive' }),
    }))).json();

    // A state-changing route reached by a cross-site form would be a way to archive
    // someone's project from another origin.
    const response = await fetch(`${baseUrl}/api/projects/${created.data.id}/archive`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', cookie, origin: 'http://evil.example' },
    });
    assert.equal(response.status, 400);
  });
});

describe('malformed requests cannot kill the process', () => {
  // Regression: URL construction and route matching ran OUTSIDE the error boundary, so
  // `curl '.../%'` threw URIError from the listener and exited the process. One
  // unauthenticated GET was a complete denial of service in every environment.

  test('a malformed percent-escape in a path is a 400, and the server keeps serving', async () => {
    const response = await fetch(`${baseUrl}/api/projects/%`, authed(cookie));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.kind, 'validation');

    assert.equal((await fetch(`${baseUrl}/api/projects`, authed(cookie))).status, 200, 'server died after a malformed path');
  });

  test('a malformed Host header is a 400, and the server keeps serving', async () => {
    // fetch() will not send an invalid Host, so the raw request goes over a socket.
    const { connect } = await import('node:net');
    const port = (server.address() as AddressInfo).port;

    const status = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write('GET /api/meta HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n');
      });
      let received = '';
      socket.on('data', (chunk) => { received += chunk.toString(); });
      socket.on('end', () => resolve(received.split('\r\n')[0]));
      socket.on('error', reject);
    });

    assert.match(status, /^HTTP\/1\.1 400/, `expected 400, got: ${status}`);
    assert.equal((await fetch(`${baseUrl}/api/projects`, authed(cookie))).status, 200, 'server died after a malformed Host');
  });

  test('malformed escapes across several shapes all stay non-fatal', async () => {
    for (const path of ['/%', '/api/projects/%zz', '/api/projects/%e0%a4%a', '/%c0%80']) {
      const response = await fetch(`${baseUrl}${path}`, authed(cookie));
      assert.ok(response.status < 500, `${path} produced ${response.status}`);
    }
    assert.equal((await fetch(`${baseUrl}/api/projects`, authed(cookie))).status, 200);
  });
});

describe('error boundary fails closed', () => {
  test('an unexpected error becomes a 500 that withholds the internal message', () => {
    const leaky = new Error('connection string user:hunter2@db.internal');
    const { status, payload } = translateError(leaky, 'trace-abc');

    assert.equal(status, 500);
    assert.equal(payload.error.kind, 'internal');
    assert.ok(!payload.error.message.includes('hunter2'));
    assert.equal(payload.error.reference, 'trace-abc');
  });

  test('a known application error keeps its user-facing message and reference', () => {
    const { status, payload } = translateError(AppError.notFound('No project exists with id x.'), 'trace-xyz');
    assert.equal(status, 404);
    assert.equal(payload.error.message, 'No project exists with id x.');
    assert.equal(payload.error.reference, 'trace-xyz');
  });

  test('a foreign error carrying a kind property cannot masquerade as an application error', () => {
    // Some libraries attach a `kind` field to their errors. Without a strict guard such an
    // error would be treated as user-facing and its internal message returned verbatim.
    const foreign = Object.assign(new Error('pg: password authentication failed for user admin'), {
      kind: 'validation',
    });
    const { status, payload } = translateError(foreign, 'trace-1');

    assert.equal(status, 500);
    assert.equal(payload.error.kind, 'internal');
    assert.ok(!payload.error.message.includes('password'));
  });

  test('an unsampled request yields no reference rather than the all-zero trace id', () => {
    // Regression: an uninstrumented request produced "00000000000000000000000000000000",
    // which reads as a real id and would send support chasing a trace that never existed.
    const { payload } = translateError(AppError.validation('bad'), '00000000000000000000000000000000');
    assert.equal(payload.error.reference, '');
  });

  test('a real trace id is passed through unchanged', () => {
    const { payload } = translateError(AppError.validation('bad'), '4bf92f3577b34da6a3ce929d0e0e4736');
    assert.equal(payload.error.reference, '4bf92f3577b34da6a3ce929d0e0e4736');
  });

  test('every error kind maps to a distinct, sensible status', () => {
    const statuses = (['validation', 'unauthorized', 'forbidden', 'not_found', 'conflict', 'dependency', 'internal'] as const)
      .map((kind) => translateError(new AppError(kind, 'm'), '').status);
    assert.deepEqual(statuses, [400, 401, 403, 404, 409, 503, 500]);
  });
});

describe('authentication at the boundary', () => {
  // FUNCTION boundary (Standard 8): an unauthenticated caller reaches no capability.

  test('every non-public route in the composed table refuses an unauthenticated caller', async () => {
    // DERIVED from the route table, not hand-listed. A hand-written list left five routes
    // uncovered, so marking any of them `public: true` passed the entire suite. Deriving it
    // means a new route is covered the moment it is registered.
    const protectedRoutes = app.routes.filter((route) => route.public !== true);
    assert.ok(protectedRoutes.length >= 8, `only ${protectedRoutes.length} protected routes discovered`);

    for (const route of protectedRoutes) {
      const path = route.pattern.replace(/:[a-zA-Z]+/g, 'placeholder-id');
      const init: RequestInit = route.method === 'GET'
        ? { method: 'GET' }
        : { method: route.method, headers: { 'content-type': 'application/json' }, body: '{}' };

      const response = await fetch(`${baseUrl}${path}`, init);
      assert.equal(response.status, 401, `${route.method} ${route.pattern} was reachable anonymously`);
    }
  });

  test('the public route set is exactly the three session routes', async () => {
    // Pinned deliberately: `public: true` is the one flag that turns off authentication, so
    // the set must be reviewed rather than grown by accident.
    const publicRoutes = app.routes
      .filter((route) => route.public === true)
      .map((route) => `${route.method} ${route.pattern}`)
      .sort();

    assert.deepEqual(publicRoutes, [
      'DELETE /api/session',
      'GET /api/session',
      'POST /api/session',
    ]);
  });

  test('login is the only unauthenticated capability, and it sets a hardened cookie', async () => {
    const response = await fetch(`${baseUrl}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ana@acme.test', password: PASSWORD }),
    });

    assert.equal(response.status, 201);
    const setCookie = response.headers.getSetCookie()[0];
    assert.match(setCookie, new RegExp(`^${SESSION_COOKIE}=`));
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);

    // The session id must never appear in a readable body.
    assert.ok(!JSON.stringify(await response.json()).includes(setCookie.split('=')[1].split(';')[0]));
  });

  test('a tampered cookie signature is refused without consulting the session store', async () => {
    const forged = `${SESSION_COOKIE}=someone-elses-session.deadbeefsignature`;
    const response = await fetch(`${baseUrl}/api/projects`, { headers: { cookie: forged } });
    assert.equal(response.status, 401);
  });

  test('a REAL session id with a wrong signature is refused', async () => {
    // The gap this closes: the previous forgery test used a fabricated session id, which
    // returns 401 whether or not the signature is verified — so deleting the HMAC check
    // entirely passed the whole suite. This presents a genuinely valid session id with a
    // wrong signature of the correct length, which only signature verification can reject.
    const real = decodeURIComponent(cookie.split('=').slice(1).join('='));
    const [sessionId, signature] = [real.slice(0, real.lastIndexOf('.')), real.slice(real.lastIndexOf('.') + 1)];

    // Same length, different bytes — so a length check alone cannot account for the refusal.
    const wrongSignature = signature.replace(/./, (character) => (character === 'A' ? 'B' : 'A'));
    assert.equal(wrongSignature.length, signature.length);
    assert.notEqual(wrongSignature, signature);

    const forged = `${SESSION_COOKIE}=${encodeURIComponent(`${sessionId}.${wrongSignature}`)}`;
    assert.equal((await fetch(`${baseUrl}/api/projects`, { headers: { cookie: forged } })).status, 401);

    // The same id WITH its real signature still works, proving the id itself was valid and
    // the refusal above came from the signature.
    assert.equal((await fetch(`${baseUrl}/api/projects`, authed(cookie))).status, 200);
  });

  test('an unsigned session id is refused, so knowing a real id is not enough', async () => {
    const real = cookie.split('=')[1];
    const idOnly = decodeURIComponent(real).split('.')[0];
    const response = await fetch(`${baseUrl}/api/projects`, {
      headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(idOnly)}` },
    });
    assert.equal(response.status, 401);
  });

  test('signing out invalidates the session for every subsequent request', async () => {
    const provisioning = app.modules.customers.provisioning;
    const temp = provisioning.provisionCustomer('Temp');
    provisioning.provisionUser(temp.id, 'temp@temp.test', PASSWORD);
    const tempCookie = await signIn(baseUrl, 'temp@temp.test', PASSWORD);

    assert.equal((await fetch(`${baseUrl}/api/projects`, authed(tempCookie))).status, 200);

    const signOut = await fetch(`${baseUrl}/api/session`, authed(tempCookie, { method: 'DELETE' }));
    assert.equal(signOut.status, 200);
    assert.match(signOut.headers.getSetCookie()[0], /Expires=Thu, 01 Jan 1970/);

    assert.equal((await fetch(`${baseUrl}/api/projects`, authed(tempCookie))).status, 401);
  });

  test('login does not reveal whether an email exists', async () => {
    const unknown = await fetch(`${baseUrl}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@nowhere.test', password: 'whatever' }),
    });
    const wrongPassword = await fetch(`${baseUrl}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ana@acme.test', password: 'wrong-password' }),
    });

    assert.equal(unknown.status, 401);
    assert.equal(wrongPassword.status, 401);
    assert.equal((await unknown.json()).error.message, (await wrongPassword.json()).error.message);
  });
});

describe('a malformed cookie is an unauthenticated request, not a server fault', () => {
  // Regression: `decodeURIComponent` on the attacker-controlled cookie header threw, and the
  // URIError fell through to the generic 500 branch — which also emitted an ERROR log. An
  // unauthenticated caller could drive the 5xx rate and log volume of every endpoint,
  // including public ones, with a one-character header.

  test('a malformed cookie escape yields 401 on a protected route, never 500', async () => {
    for (const value of ['%', '%zz', '%e0%a4%a', 'a%', '%%']) {
      const response = await fetch(`${baseUrl}/api/projects`, {
        headers: { cookie: `${SESSION_COOKIE}=${value}` },
      });
      assert.equal(response.status, 401, `cookie "${value}" produced ${response.status}`);
    }
  });

  test('a malformed cookie does not disturb a public route', async () => {
    const response = await fetch(`${baseUrl}/api/session`, {
      headers: { cookie: `${SESSION_COOKIE}=%` },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.authenticated, false);
  });

  test('a malformed cookie alongside other cookies is still non-fatal', async () => {
    const response = await fetch(`${baseUrl}/api/projects`, {
      headers: { cookie: `other=fine; ${SESSION_COOKIE}=%; another=also-fine` },
    });
    assert.equal(response.status, 401);
  });

  test('the server keeps serving after malformed cookies', async () => {
    assert.equal((await fetch(`${baseUrl}/api/projects`, authed(cookie))).status, 200);
  });
});

describe('the anonymous sentinel', () => {
  test('carries no tenant, which every authorization check relies on', async () => {
    // A one-word change to a non-empty customer id would silently make anonymous callers
    // members of a tenant. The invariant is load-bearing, so it is pinned.
    const { ANONYMOUS_CUSTOMER_ID } = await import('../../src/spine/http.ts');
    assert.equal(ANONYMOUS_CUSTOMER_ID, '');
  });
});

describe('CSRF defence', () => {
  test('a cross-site form content type cannot reach a state-changing route', async () => {
    // Regression from the slice-1 review: a cross-origin HTML form created a project. A
    // form can only send these three content types, and none of them is accepted now.
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
      const response = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': contentType, cookie, origin: 'http://evil.example' },
        body: JSON.stringify({ name: 'CSRF' }),
      });
      assert.equal(response.status, 400, `${contentType} was accepted on a write`);
    }
  });

  test('the legitimate JSON content type still works', async () => {
    const response = await fetch(`${baseUrl}/api/projects`, authed(cookie, {
      method: 'POST',
      body: JSON.stringify({ name: 'Legitimate' }),
    }));
    assert.equal(response.status, 201);
  });
});

describe('static serving', () => {
  test('serves the application shell at the root', async () => {
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await response.text(), /data-projects-root/);
  });

  test('serves module-owned UI from the module directory', async () => {
    const response = await fetch(`${baseUrl}/modules/projects/projects.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /javascript/);
  });

  test('refuses path traversal out of the web root', async () => {
    for (const path of ['/../package.json', '/..%2Fpackage.json', '/%2e%2e/package.json']) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.notEqual(response.status, 200, `${path} escaped the web root`);
    }
  });

  test('sends nosniff and a restrictive content policy with static assets', async () => {
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  });
});

describe('deployment identity', () => {
  test('reports the environment and revision actually serving the request', async () => {
    const { data } = await (await fetch(`${baseUrl}/api/meta`, authed(cookie))).json();
    assert.equal(data.environment, 'LOCAL');
    assert.equal(data.serviceName, 'foundation-lab');
    assert.ok(data.serviceVersion);
  });
});
