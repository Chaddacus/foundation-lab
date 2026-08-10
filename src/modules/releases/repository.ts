/**
 * Releases — persistence abstraction.
 *
 * Responsibility: own the `releases` table and every statement touching it.
 *
 * Place in the system: internal to the Releases module. It stores `project_id` and
 * `customer_id` but never queries the projects or customers tables — those belong to other
 * modules (SPEC §3.2).
 *
 * Boundary: rows in, rows out. Every read is scoped by customer; as in Projects, there is
 * deliberately no unscoped list method.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from '../../spine/database.ts';
import type { Release, ReleaseEnvironment, ReleaseStatus } from './contract.ts';

export const migration: Migration = {
  module: 'releases',
  statements: [
    `CREATE TABLE IF NOT EXISTS releases (
       id              TEXT PRIMARY KEY,
       project_id      TEXT NOT NULL,
       customer_id     TEXT NOT NULL,
       version         TEXT NOT NULL,
       vcs_ref         TEXT NOT NULL,
       artifact_digest TEXT NOT NULL,
       environment     TEXT NOT NULL CHECK (environment IN ('DEV','SANDBOX')),
       status          TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','deployed','verified','rolled_back')),
       created_at      TEXT NOT NULL,
       updated_at      TEXT NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_releases_project ON releases (project_id)`,
    `CREATE INDEX IF NOT EXISTS idx_releases_customer ON releases (customer_id)`,
  ],
};

interface ReleaseRow {
  id: string;
  project_id: string;
  customer_id: string;
  version: string;
  vcs_ref: string;
  artifact_digest: string;
  environment: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export class ReleasesRepository {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  insert(release: Release): void {
    this.#db
      .prepare(
        `INSERT INTO releases
           (id, project_id, customer_id, version, vcs_ref, artifact_digest, environment, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        release.id, release.projectId, release.customerId, release.version, release.vcsRef,
        release.artifactDigest, release.environment, release.status, release.createdAt, release.updatedAt,
      );
  }

  findById(id: string): Release | null {
    const row = this.#db.prepare('SELECT * FROM releases WHERE id = ?').get(id) as ReleaseRow | undefined;
    return row === undefined ? null : toRelease(row);
  }

  /** Scoped by customer as well as project, so a project id alone cannot cross a tenant. */
  listByProject(projectId: string, customerId: string): readonly Release[] {
    const rows = this.#db
      .prepare('SELECT * FROM releases WHERE project_id = ? AND customer_id = ? ORDER BY created_at DESC, id DESC')
      .all(projectId, customerId) as ReleaseRow[];
    return rows.map(toRelease);
  }

  updateStatus(id: string, status: ReleaseStatus, updatedAt: string): void {
    this.#db.prepare('UPDATE releases SET status = ?, updated_at = ? WHERE id = ?').run(status, updatedAt, id);
  }
}

function toRelease(row: ReleaseRow): Release {
  return {
    id: row.id,
    projectId: row.project_id,
    customerId: row.customer_id,
    version: row.version,
    vcsRef: row.vcs_ref,
    artifactDigest: row.artifact_digest,
    environment: row.environment as ReleaseEnvironment,
    status: row.status as ReleaseStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
