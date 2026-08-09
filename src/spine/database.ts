/**
 * Database connection lifecycle.
 *
 * Responsibility: open one SQLite connection for the process and apply each module's
 * migrations at startup.
 *
 * Place in the system: spine. Opening the connection is bootstrap wiring. Schema CONTENT
 * is not spine business: each module supplies its own migration statements and the spine
 * only sequences them. That keeps table ownership with the module (SPEC §3.2) while the
 * connection stays a single shared resource.
 *
 * Boundary: no queries live here. A query in this file would be a module's business logic
 * leaking into the spine.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from './config.ts';

/**
 * A module's schema contribution.
 *
 * `statements` run in order, inside one transaction, and MUST be idempotent
 * (`CREATE TABLE IF NOT EXISTS` and equivalents) — startup applies them every boot.
 */
export interface Migration {
  readonly module: string;
  readonly statements: readonly string[];
}

/**
 * Open the database and enable the pragmas this application depends on.
 *
 * `foreign_keys` is OFF by default in SQLite; leaving it off would let referential rules
 * declared in a module's schema silently do nothing.
 */
export function openDatabase(config: Config): DatabaseSync {
  if (config.databasePath !== ':memory:') {
    mkdirSync(dirname(config.databasePath), { recursive: true });
  }

  const db = new DatabaseSync(config.databasePath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/**
 * Apply every module migration in one transaction.
 *
 * All-or-nothing on purpose: a half-migrated schema is harder to diagnose than a refused
 * startup, and the failure surfaces at boot rather than at the first request.
 */
export function applyMigrations(db: DatabaseSync, migrations: readonly Migration[]): void {
  db.exec('BEGIN');
  try {
    for (const migration of migrations) {
      for (const statement of migration.statements) {
        db.exec(statement);
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
