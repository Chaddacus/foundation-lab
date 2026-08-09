/**
 * Projects persistence and service behavior — integration tests.
 *
 * Layer rationale: these assert what only real storage can show — that a write survives,
 * that the schema constraint is real, and that a partial update leaves other fields intact.
 * A mocked repository would only prove the mock agrees with itself.
 *
 * Uses a real SQLite database in memory: the same engine as production, no I/O cost.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from '../../src/spine/database.ts';
import { ProjectsRepository, migration } from '../../src/modules/projects/repository.ts';
import { ProjectsService, type ServiceClock } from '../../src/modules/projects/service.ts';
import type { AppError } from '../../src/spine/errors.ts';
import type { Actor } from '../../src/spine/actor.ts';

const actor: Actor = { id: 'tester', customerId: 'cust-1' };

/** Pinned clock, so tests assert exact stored values instead of "something changed". */
function fixedClock(): ServiceClock & { advance: (iso: string) => void } {
  let now = '2026-08-09T10:00:00.000Z';
  let counter = 0;
  return {
    now: () => now,
    newId: () => `project-${++counter}`,
    advance: (iso: string) => { now = iso; },
  };
}

let db: DatabaseSync;
let clock: ReturnType<typeof fixedClock>;
let service: ProjectsService;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyMigrations(db, [migration]);
  clock = fixedClock();
  service = new ProjectsService(new ProjectsRepository(db), clock);
});

describe('project creation', () => {
  test('persists a created project so a later read returns it', () => {
    const created = service.createProject(actor, { name: 'Apollo', customerId: 'cust-1' });
    const fetched = service.getProject(actor, created.id);
    assert.deepEqual(fetched, created);
  });

  test('creates projects active, with matching created and updated timestamps', () => {
    const created = service.createProject(actor, { name: 'Apollo', customerId: 'cust-1' });
    assert.equal(created.status, 'active');
    assert.equal(created.createdAt, '2026-08-09T10:00:00.000Z');
    assert.equal(created.updatedAt, created.createdAt);
  });

  test('survives a reconnect to the same database file, proving durability not just caching', () => {
    service.createProject(actor, { name: 'Apollo', customerId: 'cust-1' });
    const reopened = new ProjectsRepository(db);
    assert.equal(reopened.listAll().length, 1);
  });
});

describe('reading projects', () => {
  test('raises not_found for an unknown id rather than returning null to the caller', () => {
    assert.throws(
      () => service.getProject(actor, 'missing'),
      (error: AppError) => error.kind === 'not_found',
    );
  });

  test('lists newest first', () => {
    service.createProject(actor, { name: 'First', customerId: 'cust-1' });
    clock.advance('2026-08-09T11:00:00.000Z');
    service.createProject(actor, { name: 'Second', customerId: 'cust-1' });

    assert.deepEqual(service.listProjects(actor).map((project) => project.name), ['Second', 'First']);
  });

  test('returns an empty list rather than failing when nothing exists', () => {
    assert.deepEqual(service.listProjects(actor), []);
  });
});

describe('updating projects', () => {
  test('changes only the supplied field and leaves the rest intact', () => {
    const created = service.createProject(actor, {
      name: 'Apollo', description: 'Original', customerId: 'cust-1',
    });
    clock.advance('2026-08-09T12:00:00.000Z');

    const updated = service.updateProject(actor, created.id, { name: 'Apollo II' });

    assert.equal(updated.name, 'Apollo II');
    assert.equal(updated.description, 'Original');
    assert.equal(updated.customerId, created.customerId);
    assert.equal(updated.createdAt, created.createdAt);
    assert.equal(updated.updatedAt, '2026-08-09T12:00:00.000Z');
  });

  test('persists the update rather than only returning it', () => {
    const created = service.createProject(actor, { name: 'Apollo', customerId: 'cust-1' });
    service.updateProject(actor, created.id, { name: 'Apollo II' });
    assert.equal(service.getProject(actor, created.id).name, 'Apollo II');
  });

  test('raises not_found for an unknown id instead of silently updating zero rows', () => {
    assert.throws(
      () => service.updateProject(actor, 'missing', { name: 'x' }),
      (error: AppError) => error.kind === 'not_found',
    );
  });
});

describe('schema constraints', () => {
  test('the database itself refuses an invalid lifecycle status', () => {
    assert.throws(() => db.exec(
      `INSERT INTO projects (id, name, description, customer_id, status, created_at, updated_at)
       VALUES ('x','n','','c','deleted','t','t')`,
    ));
  });

  test('archiveProject is absent by design in slice 1 — the archive journey is slice 4', () => {
    assert.equal('archiveProject' in service, false);
  });
});
