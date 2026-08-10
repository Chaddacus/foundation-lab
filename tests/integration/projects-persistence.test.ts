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
    const created = service.createProject(actor, { name: 'Apollo' });
    const fetched = service.getProject(actor, created.id);
    assert.deepEqual(fetched, created);
  });

  test('creates projects active, with matching created and updated timestamps', () => {
    const created = service.createProject(actor, { name: 'Apollo' });
    assert.equal(created.status, 'active');
    assert.equal(created.createdAt, '2026-08-09T10:00:00.000Z');
    assert.equal(created.updatedAt, created.createdAt);
  });

  test('survives closing and reopening the database file, which in-memory storage would not', async () => {
    // The earlier version wrapped the SAME open in-memory handle in a second repository and
    // called that durability. It proved only that two wrappers read one connection.
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const directory = await mkdtemp(join(tmpdir(), 'foundation-lab-durability-'));
    const file = join(directory, 'projects.sqlite');

    try {
      const first = new DatabaseSync(file);
      applyMigrations(first, [migration]);
      new ProjectsService(new ProjectsRepository(first), fixedClock())
        .createProject(actor, { name: 'Durable' });
      first.close();

      const second = new DatabaseSync(file);
      const rows = new ProjectsRepository(second).listByCustomer(actor.customerId);
      second.close();

      assert.equal(rows.length, 1);
      assert.equal(rows[0].name, 'Durable');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
    service.createProject(actor, { name: 'First' });
    clock.advance('2026-08-09T11:00:00.000Z');
    service.createProject(actor, { name: 'Second' });

    assert.deepEqual(service.listProjects(actor).map((project) => project.name), ['Second', 'First']);
  });

  test('returns an empty list rather than failing when nothing exists', () => {
    assert.deepEqual(service.listProjects(actor), []);
  });
});

describe('updating projects', () => {
  test('changes only the supplied field and leaves the rest intact', () => {
    const created = service.createProject(actor, {
      name: 'Apollo', description: 'Original',
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
    const created = service.createProject(actor, { name: 'Apollo' });
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

describe('archiving', () => {
  test('archiving changes the stored status and the updated timestamp', () => {
    const created = service.createProject(actor, { name: 'Apollo' });
    clock.advance('2026-08-10T09:00:00.000Z');

    const archived = service.archiveProject(actor, created.id);

    assert.equal(archived.status, 'archived');
    assert.equal(archived.updatedAt, '2026-08-10T09:00:00.000Z');
    assert.equal(service.getProject(actor, created.id).status, 'archived');
  });

  test('archiving preserves everything except status and timestamp', () => {
    const created = service.createProject(actor, { name: 'Apollo', description: 'Lunar' });
    const archived = service.archiveProject(actor, created.id);

    assert.equal(archived.name, created.name);
    assert.equal(archived.description, created.description);
    assert.equal(archived.customerId, created.customerId);
    assert.equal(archived.createdAt, created.createdAt);
  });

  test('archiving twice is refused and the second attempt changes nothing', () => {
    const created = service.createProject(actor, { name: 'Apollo' });
    service.archiveProject(actor, created.id);
    clock.advance('2026-08-10T10:00:00.000Z');

    assert.throws(
      () => service.archiveProject(actor, created.id),
      (error: AppError) => error.kind === 'conflict',
    );
    // The refused attempt must not have touched the record.
    assert.notEqual(service.getProject(actor, created.id).updatedAt, '2026-08-10T10:00:00.000Z');
  });

  test('an archived project cannot be edited', () => {
    const created = service.createProject(actor, { name: 'Apollo' });
    service.archiveProject(actor, created.id);

    assert.throws(
      () => service.updateProject(actor, created.id, { name: 'Renamed' }),
      (error: AppError) => error.kind === 'conflict',
    );
    assert.equal(service.getProject(actor, created.id).name, 'Apollo');
  });

  test('archiving an unknown id is not_found, not conflict', () => {
    assert.throws(
      () => service.archiveProject(actor, 'missing'),
      (error: AppError) => error.kind === 'not_found',
    );
  });

  test('archived projects still appear in the list', () => {
    // They remain the customer's records. Hiding them would make an archived project look
    // deleted, which it is not.
    const created = service.createProject(actor, { name: 'Apollo' });
    service.archiveProject(actor, created.id);

    assert.deepEqual(service.listProjects(actor).map((p) => p.status), ['archived']);
  });
});

describe('schema constraints', () => {
  test('the database itself refuses an invalid lifecycle status', () => {
    assert.throws(() => db.exec(
      `INSERT INTO projects (id, name, description, customer_id, status, created_at, updated_at)
       VALUES ('x','n','','c','deleted','t','t')`,
    ));
  });

  test('the database accepts the archived status the lifecycle now uses', () => {
    // The CHECK constraint has permitted 'archived' since slice 1, which is why adding the
    // capability was a behavior change rather than a migration.
    assert.doesNotThrow(() => db.exec(
      `INSERT INTO projects (id, name, description, customer_id, status, created_at, updated_at)
       VALUES ('x','n','','c','archived','t','t')`,
    ));
  });
});
