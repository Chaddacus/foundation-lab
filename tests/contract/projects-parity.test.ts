/**
 * API/MCP parity — contract tests.
 *
 * What this defends: SPEC §3.3 forbids duplicated business logic between the HTTP and MCP
 * adapters. That rule is only real if something fails when it breaks. These tests drive
 * BOTH adapters against the SAME service instance and assert identical outcomes.
 *
 * If someone adds a rule to one adapter — an extra default, a different validation, a
 * silent fallback — parity breaks here.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from '../../src/spine/database.ts';
import { createProjectsModule, type ProjectsModule } from '../../src/modules/projects/index.ts';
import { migration } from '../../src/modules/projects/repository.ts';
import type { Route } from '../../src/spine/http.ts';
import type { AppError } from '../../src/spine/errors.ts';
import type { Actor } from '../../src/spine/actor.ts';

const actor: Actor = { id: 'tester', customerId: 'cust-1' };

let module_: ProjectsModule;

beforeEach(() => {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db, [migration]);
  module_ = createProjectsModule(db);
});

/** Invoke an HTTP route by method and pattern, the way the spine's router would. */
function callRoute(method: Route['method'], pattern: string, params = {}, body?: unknown): unknown {
  const route = module_.routes.find((candidate) => candidate.method === method && candidate.pattern === pattern);
  assert.ok(route, `no route ${method} ${pattern}`);
  return route.handler({ actor, params, body, sessionId: null, setCookie: () => {} });
}

/** Strip identifiers and timestamps so two independently created projects can be compared. */
function shape(project: unknown): unknown {
  const { id, createdAt, updatedAt, ...rest } = project as Record<string, unknown>;
  return rest;
}

/**
 * Inputs chosen to DISCRIMINATE, not merely to exercise.
 *
 * The previous version hand-picked inputs that happened to hit the same outcome on both
 * paths, so an HTTP-only default (`name: input.name ?? 'Untitled'`) passed the whole suite.
 * These cases include nullish, absent, wrong-typed, whitespace, and extra-field inputs
 * precisely because those are where a one-sided default or coercion hides.
 */
const CREATE_CASES: readonly { label: string; input: unknown }[] = [
  { label: 'complete input', input: { name: 'Apollo', description: 'Lunar' } },
  { label: 'no description', input: { name: 'Apollo' } },
  { label: 'empty object', input: {} },
  { label: 'description only', input: { description: 'Lunar' } },
  { label: 'null name', input: { name: null } },
  { label: 'undefined name', input: { name: undefined } },
  { label: 'empty name', input: { name: '' } },
  { label: 'whitespace name', input: { name: '   ' } },
  { label: 'foreign customerId in body', input: { name: 'Apollo', customerId: 'other-tenant' } },
  { label: 'null customerId in body', input: { name: 'Apollo', customerId: null } },
  { label: 'wrong-typed name', input: { name: 42 } },
  { label: 'over-long name', input: { name: 'x'.repeat(121) } },
  { label: 'untrimmed values', input: { name: '  Apollo  ' } },
  { label: 'unexpected extra field', input: { name: 'Apollo', status: 'archived' } },
];

const UPDATE_CASES: readonly { label: string; input: unknown }[] = [
  { label: 'rename', input: { name: 'Renamed' } },
  { label: 'clear description', input: { description: '' } },
  { label: 'no recognised field', input: {} },
  { label: 'null name', input: { name: null } },
  { label: 'undefined name', input: { name: undefined } },
  { label: 'empty name', input: { name: '' } },
  { label: 'unexpected extra field', input: { customerId: 'someone-else', status: 'archived', name: 'Renamed' } },
];

/** Run a call and capture its outcome as a comparable value, whether it returned or threw. */
function outcome(fn: () => unknown): unknown {
  try {
    const value = fn() as Record<string, unknown>;
    if (value !== null && typeof value === 'object' && 'id' in value) return { ok: shape(value) };
    return { ok: value };
  } catch (error) {
    const appError = error as AppError;
    return { failed: { kind: appError.kind, message: appError.message, details: appError.details } };
  }
}

describe('adapter parity over a discriminating input corpus', () => {
  test('createProject behaves identically through HTTP and MCP for every case', () => {
    for (const { label, input } of CREATE_CASES) {
      const viaHttp = outcome(() => callRoute('POST', '/api/projects', {}, input));
      const viaMcp = outcome(() => module_.callTool(actor, 'create_project', input as Record<string, unknown>));
      assert.deepEqual(viaHttp, viaMcp, `create diverged between HTTP and MCP for: ${label}`);
    }
  });

  test('updateProject behaves identically through HTTP and MCP for every case', () => {
    for (const { label, input } of UPDATE_CASES) {
      const viaHttp = outcome(() => {
        const target = module_.capability.createProject(actor, { name: 'Base', description: 'keep' });
        return callRoute('PATCH', '/api/projects/:id', { id: target.id }, input);
      });
      const viaMcp = outcome(() => {
        const target = module_.capability.createProject(actor, { name: 'Base', description: 'keep' });
        return module_.callTool(actor, 'update_project', { id: target.id, ...(input as object) });
      });
      assert.deepEqual(viaHttp, viaMcp, `update diverged between HTTP and MCP for: ${label}`);
    }
  });

  test('getProject behaves identically through HTTP and MCP, present or absent', () => {
    const created = module_.capability.createProject(actor, { name: 'Apollo' });
    for (const id of [created.id, 'missing', '']) {
      assert.deepEqual(
        outcome(() => callRoute('GET', '/api/projects/:id', { id })),
        outcome(() => module_.callTool(actor, 'get_project', { id })),
        `get diverged for id "${id}"`,
      );
    }
  });
});

describe('capability coverage parity', () => {
  /**
   * Derived from the service's own methods rather than hand-listed, so a capability added
   * in a later slice fails this test until BOTH adapters expose it. A hand-written list
   * would silently stay stale — which is how an HTTP-only or MCP-only capability slips in.
   *
   * Read inside each test, not at suite-definition time, because the module is built per test.
   */
  const methodsOf = () => Object.getOwnPropertyNames(Object.getPrototypeOf(module_.capability))
    .filter((name) => name !== 'constructor');

  test('every capability method is reachable through both adapters', () => {
    const capabilityMethods = methodsOf();
    assert.ok(capabilityMethods.length > 0, 'no capability methods discovered');
    const httpOperations = new Set(module_.routes.map((route) => route.operation));
    // Tool names are snake_case of the method name: createProject -> create_project.
    const toolOperations = new Set(module_.tools.map((tool) =>
      tool.name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())));

    for (const method of capabilityMethods) {
      assert.ok(httpOperations.has(method), `capability ${method} has no HTTP route`);
      assert.ok(toolOperations.has(method), `capability ${method} has no MCP tool`);
    }
  });

  test('neither adapter exposes an operation the capability does not have', () => {
    const known = new Set(methodsOf());
    for (const route of module_.routes) {
      assert.ok(known.has(route.operation), `HTTP route ${route.operation} is not a capability method`);
    }
  });
});

describe('create parity', () => {
  test('both adapters produce the same project from the same input', () => {
    const viaHttp = callRoute('POST', '/api/projects', {}, {
      name: 'Apollo', description: 'Lunar',
    });
    const viaMcp = module_.callTool(actor, 'create_project', {
      name: 'Apollo', description: 'Lunar',
    });

    assert.deepEqual(shape(viaHttp), shape(viaMcp));
    assert.deepEqual(shape(viaHttp), {
      name: 'Apollo', description: 'Lunar', customerId: actor.customerId, status: 'active',
    });
  });

  test('both adapters reject the same invalid input with the same error kind and fields', () => {
    const httpError = captureError(() => callRoute('POST', '/api/projects', {}, { name: '' }));
    const mcpError = captureError(() => module_.callTool(actor, 'create_project', { name: '' }));

    assert.equal(httpError.kind, 'validation');
    assert.equal(httpError.kind, mcpError.kind);
    assert.deepEqual(httpError.details, mcpError.details);
  });

  test('neither adapter invents a default for a required field', () => {
    assert.throws(() => callRoute('POST', '/api/projects', {}, {}));
    assert.throws(() => module_.callTool(actor, 'create_project', {}));
  });
});

describe('read parity', () => {
  test('both adapters return the same project for the same id', () => {
    const created = module_.capability.createProject(actor, { name: 'Apollo' });

    assert.deepEqual(callRoute('GET', '/api/projects/:id', { id: created.id }), created);
    assert.deepEqual(module_.callTool(actor, 'get_project', { id: created.id }), created);
  });

  test('both adapters raise not_found for an unknown id', () => {
    assert.equal(captureError(() => callRoute('GET', '/api/projects/:id', { id: 'missing' })).kind, 'not_found');
    assert.equal(captureError(() => module_.callTool(actor, 'get_project', { id: 'missing' })).kind, 'not_found');
  });

  test('both adapters list the same projects', () => {
    module_.capability.createProject(actor, { name: 'Apollo' });
    assert.deepEqual(callRoute('GET', '/api/projects'), module_.callTool(actor, 'list_projects'));
  });
});

describe('update parity', () => {
  test('both adapters apply the same partial update semantics', () => {
    const first = module_.capability.createProject(actor, { name: 'A', description: 'keep' });
    const second = module_.capability.createProject(actor, { name: 'B', description: 'keep' });

    const viaHttp = callRoute('PATCH', '/api/projects/:id', { id: first.id }, { name: 'Renamed' });
    const viaMcp = module_.callTool(actor, 'update_project', { id: second.id, name: 'Renamed' });

    assert.equal((viaHttp as { name: string }).name, 'Renamed');
    assert.equal((viaHttp as { description: string }).description, 'keep');
    assert.deepEqual(shape(viaHttp), shape(viaMcp));
  });
});

describe('MCP tool surface', () => {
  test('every declared tool is dispatchable, so no tool is advertised but unimplemented', () => {
    for (const tool of module_.tools) {
      // A tool may legitimately succeed or reject its arguments. What it must never do is
      // fall through to the unknown-tool branch — that means it was advertised but not wired.
      try {
        module_.callTool(actor, tool.name, {});
      } catch (error) {
        assert.notEqual(
          (error as AppError).message,
          `Unknown tool "${tool.name}".`,
          `${tool.name} is declared but not dispatched`,
        );
      }
    }
  });

  test('every tool declares a side-effect class, as Standard 9 requires', () => {
    for (const tool of module_.tools) {
      assert.ok(['read', 'write'].includes(tool.sideEffect), `${tool.name} has no side-effect class`);
    }
  });

  test('read tools do not mutate state', () => {
    module_.capability.createProject(actor, { name: 'Apollo' });
    const before = module_.capability.listProjects(actor);

    for (const tool of module_.tools.filter((candidate) => candidate.sideEffect === 'read')) {
      try { module_.callTool(actor, tool.name, { id: before[0].id }); } catch { /* argument errors are not mutations */ }
    }

    assert.deepEqual(module_.capability.listProjects(actor), before);
  });

  test('an unknown tool name is refused rather than silently ignored', () => {
    assert.equal(captureError(() => module_.callTool(actor, 'drop_everything', {})).kind, 'validation');
  });

  test('the tool surface exposes no shell, SQL, or admin capability', () => {
    const forbidden = ['exec', 'shell', 'sql', 'query', 'admin', 'eval'];
    for (const tool of module_.tools) {
      assert.ok(
        !forbidden.some((word) => tool.name.toLowerCase().includes(word)),
        `${tool.name} looks like an unbounded capability`,
      );
    }
  });
});

function captureError(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    return error as AppError;
  }
  throw new assert.AssertionError({ message: 'expected the call to throw, but it succeeded' });
}
