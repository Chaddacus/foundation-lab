/**
 * Projects — persistence abstraction.
 *
 * Responsibility: own the `projects` table and every statement that touches it.
 *
 * Place in the system: internal to the Projects module. This is the ONLY code permitted to
 * read or write `projects` (SPEC §3.2). Other modules go through the capability contract.
 *
 * Boundary: rows in, rows out. No validation (that is `domain.ts`) and no orchestration
 * (that is `service.ts`).
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from '../../spine/database.ts';
import type { Project, ProjectStatus } from './contract.ts';

/**
 * The module's schema contribution, handed to the spine at startup.
 *
 * `status` is constrained by CHECK rather than by convention so an invalid lifecycle value
 * fails at the storage boundary even if a future code path forgets to validate.
 */
export const migration: Migration = {
  module: 'projects',
  statements: [
    `CREATE TABLE IF NOT EXISTS projects (
       id          TEXT PRIMARY KEY,
       name        TEXT NOT NULL,
       description TEXT NOT NULL DEFAULT '',
       customer_id TEXT NOT NULL,
       status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
       created_at  TEXT NOT NULL,
       updated_at  TEXT NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_projects_customer ON projects (customer_id)`,
  ],
};

/** Storage row shape. Snake_case stays inside this file; the contract speaks camelCase. */
interface ProjectRow {
  id: string;
  name: string;
  description: string;
  customer_id: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export class ProjectsRepository {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  insert(project: Project): void {
    this.#db
      .prepare(
        `INSERT INTO projects (id, name, description, customer_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        project.id,
        project.name,
        project.description,
        project.customerId,
        project.status,
        project.createdAt,
        project.updatedAt,
      );
  }

  /** Returns null when absent. Raising `not_found` is the service's decision, not storage's. */
  findById(id: string): Project | null {
    const row = this.#db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    return row === undefined ? null : toProject(row);
  }

  /**
   * List one customer's projects.
   *
   * There is deliberately NO unscoped "list all projects" method. An unscoped query is the
   * thing a later caller reaches for by accident, and its absence means tenant scoping
   * cannot be forgotten at the call site — it is the only option available.
   */
  listByCustomer(customerId: string): readonly Project[] {
    const rows = this.#db
      .prepare('SELECT * FROM projects WHERE customer_id = ? ORDER BY created_at DESC, id DESC')
      .all(customerId) as unknown as ProjectRow[];
    return rows.map(toProject);
  }

  /** Writes the already-validated fields. Callers pass a fully resolved row state. */
  update(id: string, fields: { name: string; description: string; updatedAt: string }): void {
    this.#db
      .prepare('UPDATE projects SET name = ?, description = ?, updated_at = ? WHERE id = ?')
      .run(fields.name, fields.description, fields.updatedAt, id);
  }
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    customerId: row.customer_id,
    status: row.status as ProjectStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
