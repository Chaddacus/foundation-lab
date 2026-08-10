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

const PASSWORD = 'correct-horse-battery-staple';
let cookie: string;

before(async () => {
  app = buildApp(testConfig());
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

  test('every capability route refuses an unauthenticated caller', async () => {
    const protectedRequests: [string, RequestInit][] = [
      ['/api/projects', {}],
      ['/api/projects/anything', {}],
      ['/api/users', {}],
      ['/api/meta', {}],
      ['/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"x"}' }],
    ];

    for (const [path, init] of protectedRequests) {
      const response = await fetch(`${baseUrl}${path}`, init);
      assert.equal(response.status, 401, `${init.method ?? 'GET'} ${path} was reachable anonymously`);
    }
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
