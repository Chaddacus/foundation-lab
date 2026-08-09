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
  return route.handler({ actor, params, body });
}

/** Strip identifiers and timestamps so two independently created projects can be compared. */
function shape(project: unknown): unknown {
  const { id, createdAt, updatedAt, ...rest } = project as Record<string, unknown>;
  return rest;
}

describe('create parity', () => {
  test('both adapters produce the same project from the same input', () => {
    const viaHttp = callRoute('POST', '/api/projects', {}, {
      name: 'Apollo', description: 'Lunar', customerId: 'cust-1',
    });
    const viaMcp = module_.callTool(actor, 'create_project', {
      name: 'Apollo', description: 'Lunar', customerId: 'cust-1',
    });

    assert.deepEqual(shape(viaHttp), shape(viaMcp));
    assert.deepEqual(shape(viaHttp), {
      name: 'Apollo', description: 'Lunar', customerId: 'cust-1', status: 'active',
    });
  });

  test('both adapters reject the same invalid input with the same error kind and fields', () => {
    const httpError = captureError(() => callRoute('POST', '/api/projects', {}, { name: '', customerId: '' }));
    const mcpError = captureError(() => module_.callTool(actor, 'create_project', { name: '', customerId: '' }));

    assert.equal(httpError.kind, 'validation');
    assert.equal(httpError.kind, mcpError.kind);
    assert.deepEqual(httpError.details, mcpError.details);
  });

  test('neither adapter invents a default for a required field', () => {
    assert.throws(() => callRoute('POST', '/api/projects', {}, { name: 'Apollo' }));
    assert.throws(() => module_.callTool(actor, 'create_project', { name: 'Apollo' }));
  });
});

describe('read parity', () => {
  test('both adapters return the same project for the same id', () => {
    const created = module_.capability.createProject(actor, { name: 'Apollo', customerId: 'cust-1' });

    assert.deepEqual(callRoute('GET', '/api/projects/:id', { id: created.id }), created);
    assert.deepEqual(module_.callTool(actor, 'get_project', { id: created.id }), created);
  });

  test('both adapters raise not_found for an unknown id', () => {
    assert.equal(captureError(() => callRoute('GET', '/api/projects/:id', { id: 'missing' })).kind, 'not_found');
    assert.equal(captureError(() => module_.callTool(actor, 'get_project', { id: 'missing' })).kind, 'not_found');
  });

  test('both adapters list the same projects', () => {
    module_.capability.createProject(actor, { name: 'Apollo', customerId: 'cust-1' });
    assert.deepEqual(callRoute('GET', '/api/projects'), module_.callTool(actor, 'list_projects'));
  });
});

describe('update parity', () => {
  test('both adapters apply the same partial update semantics', () => {
    const first = module_.capability.createProject(actor, { name: 'A', description: 'keep', customerId: 'c' });
    const second = module_.capability.createProject(actor, { name: 'B', description: 'keep', customerId: 'c' });

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
    module_.capability.createProject(actor, { name: 'Apollo', customerId: 'c' });
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
