/**
 * Authorization parity across adapters — contract tests.
 *
 * What this defends: authorization is enforced by the application at execution time, in the
 * service, so it MUST hold identically through MCP. A tool that bypassed the tenant check
 * would be an authorization hole reachable by any MCP client, and Standard 9 forbids
 * relying on tool descriptions or prompts to prevent it.
 *
 * Every case is run through the MCP dispatcher and the HTTP route and the outcomes compared,
 * so neither path can be hardened or weakened alone.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, type Application } from '../../src/spine/app.ts';
import { loadConfig } from '../../src/spine/config.ts';
import type { Actor } from '../../src/spine/actor.ts';
import type { AppError } from '../../src/spine/errors.ts';
import type { Route } from '../../src/spine/http.ts';

const PASSWORD = 'correct-horse-battery-staple';

let app: Application;
let ana: Actor;
let gil: Actor;
let acmeProjectId: string;
let acmeReleaseId: string;

beforeEach(() => {
  app = buildApp(loadConfig({
    FL_DATABASE_PATH: ':memory:',
    FL_OTLP_ENDPOINT: '',
    FL_SESSION_SECRET: 'test-secret-not-a-real-key',
  }));

  const provisioning = app.modules.customers.provisioning;
  const acme = provisioning.provisionCustomer('Acme');
  const globex = provisioning.provisionCustomer('Globex');
  provisioning.provisionUser(acme.id, 'ana@acme.test', PASSWORD);
  provisioning.provisionUser(globex.id, 'gil@globex.test', PASSWORD);

  ana = app.modules.customers.capability.login({ email: 'ana@acme.test', password: PASSWORD }).actor;
  gil = app.modules.customers.capability.login({ email: 'gil@globex.test', password: PASSWORD }).actor;

  acmeProjectId = app.modules.projects.capability.createProject(ana, { name: 'Acme Apollo' }).id;
  acmeReleaseId = app.modules.releases.capability.createRelease(ana, {
    projectId: acmeProjectId, version: '1.0.0', vcsRef: 'abc',
    artifactDigest: 'sha256:aa', environment: 'DEV',
  }).id;
});

function outcome(fn: () => unknown): unknown {
  try {
    const value = fn();
    return { ok: Array.isArray(value) ? `${value.length} records` : 'record' };
  } catch (error) {
    return { failed: (error as AppError).kind };
  }
}

function callRoute(module_: 'projects' | 'releases' | 'customers', operation: string, actor: Actor, params = {}, body?: unknown): unknown {
  const route = app.modules[module_].routes.find((candidate: Route) => candidate.operation === operation);
  assert.ok(route, `no route for ${operation}`);
  return route.handler({ actor, params, body, sessionId: null, setCookie: () => {} });
}

describe('cross-tenant access is refused identically through MCP and HTTP', () => {
  test('reading another tenant\'s project', () => {
    assert.deepEqual(
      outcome(() => app.modules.projects.callTool(gil, 'get_project', { id: acmeProjectId })),
      outcome(() => callRoute('projects', 'getProject', gil, { id: acmeProjectId })),
    );
    assert.deepEqual(
      outcome(() => app.modules.projects.callTool(gil, 'get_project', { id: acmeProjectId })),
      { failed: 'not_found' },
    );
  });

  test('updating another tenant\'s project', () => {
    assert.deepEqual(
      outcome(() => app.modules.projects.callTool(gil, 'update_project', { id: acmeProjectId, name: 'Seized' })),
      { failed: 'not_found' },
    );
    assert.equal(app.modules.projects.capability.getProject(ana, acmeProjectId).name, 'Acme Apollo');
  });

  test('listing projects returns only the caller\'s tenant through MCP', () => {
    const viaMcp = app.modules.projects.callTool(gil, 'list_projects') as unknown[];
    const viaHttp = callRoute('projects', 'listProjects', gil) as unknown[];
    assert.equal(viaMcp.length, 0);
    assert.deepEqual(viaMcp, viaHttp);
  });

  test('creating a project through MCP cannot set another tenant as owner', () => {
    const created = app.modules.projects.callTool(gil, 'create_project', {
      name: 'Via MCP', customerId: ana.customerId,
    }) as { customerId: string };
    assert.equal(created.customerId, gil.customerId);
  });

  test('reading and advancing another tenant\'s release', () => {
    assert.deepEqual(
      outcome(() => app.modules.releases.callTool(gil, 'get_release', { id: acmeReleaseId })),
      { failed: 'not_found' },
    );
    assert.deepEqual(
      outcome(() => app.modules.releases.callTool(gil, 'set_release_status', { id: acmeReleaseId, status: 'rolled_back' })),
      { failed: 'not_found' },
    );
    assert.equal(app.modules.releases.capability.getRelease(ana, acmeReleaseId).status, 'pending');
  });

  test('reading another tenant\'s customer record', () => {
    assert.deepEqual(
      outcome(() => app.modules.customers.callTool(ana, 'get_customer', { id: gil.customerId })),
      { failed: 'not_found' },
    );
  });

  test('listing users returns only the caller\'s tenant through MCP', () => {
    const users = app.modules.customers.callTool(gil, 'list_users') as { email: string }[];
    assert.deepEqual(users.map((user) => user.email), ['gil@globex.test']);
  });
});

describe('the MCP tool surface stays bounded', () => {
  const allTools = () => [
    ...app.modules.customers.tools,
    ...app.modules.projects.tools,
    ...app.modules.releases.tools,
  ];

  test('no tool exposes shell, SQL, admin, or credential capability', () => {
    const forbidden = ['exec', 'shell', 'sql', 'query', 'admin', 'eval', 'password', 'login', 'session', 'provision'];
    for (const tool of allTools()) {
      assert.ok(
        !forbidden.some((word) => tool.name.toLowerCase().includes(word)),
        `${tool.name} looks like an unbounded or credential capability`,
      );
    }
  });

  test('every tool declares a side-effect class', () => {
    for (const tool of allTools()) {
      assert.ok(['read', 'write'].includes(tool.sideEffect), `${tool.name} has no side-effect class`);
    }
  });

  test('tool names are unique across modules, so dispatch cannot be ambiguous', () => {
    const names = allTools().map((tool) => tool.name);
    assert.equal(new Set(names).size, names.length, `duplicate tool name: ${names.join(', ')}`);
  });

  test('no tool schema asks the client to supply the owning tenant', () => {
    // A tool schema is an instruction to an LLM client. `create_project` required
    // `customerId` for a whole slice after ownership moved to the session — telling a client
    // that choosing the tenant was its job, which is the authority signal Standard 9 says a
    // tool must not carry. The service ignored the value, so no test noticed.
    for (const tool of allTools()) {
      const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      const ownershipFields = ['customerId', 'customer_id', 'tenantId', 'ownerId'];

      for (const field of ownershipFields) {
        assert.ok(
          !(schema.properties && field in schema.properties),
          `${tool.name} accepts "${field}" — ownership comes from the session, not the client`,
        );
        assert.ok(
          !(schema.required ?? []).includes(field),
          `${tool.name} REQUIRES "${field}"`,
        );
      }
    }
  });

  test('no tool schema asks the client to supply server-owned lifecycle or identity fields', () => {
    for (const tool of allTools()) {
      const schema = tool.inputSchema as { properties?: Record<string, unknown> };
      for (const field of ['createdAt', 'updatedAt']) {
        assert.ok(
          !(schema.properties && field in schema.properties),
          `${tool.name} accepts "${field}", which the server owns`,
        );
      }
    }
  });

  test('provisioning is deliberately absent from every adapter', () => {
    // There is no admin role in slice 2, so no authenticated caller may create tenants or
    // accounts. Provisioning exists only on the module object, for the seed and tests.
    for (const tool of allTools()) {
      assert.ok(!/create_(customer|user)/.test(tool.name), `${tool.name} exposes provisioning`);
    }
    const operations = app.modules.customers.routes.map((route) => route.operation);
    assert.ok(!operations.includes('provisionCustomer'));
    assert.ok(!operations.includes('provisionUser'));
  });
});
