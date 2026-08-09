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
import { ACTOR_HEADER } from '../../src/spine/actor.ts';

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
  return loadConfig({ FL_DATABASE_PATH: ':memory:', FL_OTLP_ENDPOINT: '', ...overrides });
}

before(async () => {
  app = buildApp(testConfig());
  server = createServer(app.listener);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  app.close();
});

describe('status mapping', () => {
  test('a created project responds 201 with the project as data', async () => {
    const response = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Apollo', customerId: 'cust-1' }),
    });

    assert.equal(response.status, 201);
    const { data } = await response.json();
    assert.equal(data.name, 'Apollo');
    assert.equal(data.status, 'active');
  });

  test('a validation failure responds 400 and names the offending fields', async () => {
    const response = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '', customerId: '' }),
    });

    assert.equal(response.status, 400);
    const { error } = await response.json();
    assert.equal(error.kind, 'validation');
    assert.deepEqual(Object.keys(error.details).sort(), ['customerId', 'name']);
  });

  test('an unknown project responds 404', async () => {
    const response = await fetch(`${baseUrl}/api/projects/does-not-exist`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.kind, 'not_found');
  });

  test('malformed JSON is a client error, not a crash', async () => {
    const response = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(response.status, 400);
  });

  test('an oversized body is refused rather than buffered', async () => {
    const response = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x'.repeat(100_000), customerId: 'c' }),
    });
    assert.equal(response.status, 400);
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

describe('actor resolution', () => {
  test('LOCAL supplies a development actor so a fresh clone runs with no setup', async () => {
    assert.equal((await fetch(`${baseUrl}/api/projects`)).status, 200);
  });

  test('an explicit actor header is honoured over the development fallback', async () => {
    const response = await fetch(`${baseUrl}/api/projects`, { headers: { [ACTOR_HEADER]: 'alice' } });
    assert.equal(response.status, 200);
  });

  test('outside LOCAL an unidentified caller is refused, so an unfinished seam denies rather than grants', async () => {
    const devApp = buildApp(testConfig({ FL_ENV: 'DEV' }));
    const devServer = createServer(devApp.listener);
    await new Promise<void>((resolve) => devServer.listen(0, '127.0.0.1', resolve));
    const devUrl = `http://127.0.0.1:${(devServer.address() as AddressInfo).port}`;

    try {
      const anonymous = await fetch(`${devUrl}/api/projects`);
      assert.equal(anonymous.status, 401);
      assert.equal((await anonymous.json()).error.kind, 'unauthorized');

      const identified = await fetch(`${devUrl}/api/projects`, { headers: { [ACTOR_HEADER]: 'alice' } });
      assert.equal(identified.status, 200);
    } finally {
      await new Promise<void>((resolve) => devServer.close(() => resolve()));
      devApp.close();
    }
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
    const { data } = await (await fetch(`${baseUrl}/api/meta`)).json();
    assert.equal(data.environment, 'LOCAL');
    assert.equal(data.serviceName, 'foundation-lab');
    assert.ok(data.serviceVersion);
  });
});
