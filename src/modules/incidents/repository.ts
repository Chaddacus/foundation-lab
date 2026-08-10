/**
 * Incidents — persistence abstraction.
 *
 * Responsibility: own the `incidents` table and every statement touching it.
 *
 * Place in the system: internal to the Incidents module (SPEC §3.2).
 *
 * As in the other modules there is deliberately NO unscoped list method: tenant scoping
 * cannot be forgotten at a call site because no unscoped option exists.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from '../../spine/database.ts';
import type { Incident, IncidentSeverity, IncidentStatus } from './contract.ts';

export const migration: Migration = {
  module: 'incidents',
  statements: [
    `CREATE TABLE IF NOT EXISTS incidents (
       id          TEXT PRIMARY KEY,
       customer_id TEXT NOT NULL,
       title       TEXT NOT NULL,
       report      TEXT NOT NULL,
       severity    TEXT NOT NULL CHECK (severity IN ('SEV-0','SEV-1','SEV-2','SEV-3')),
       status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','mitigated','resolved')),
       case_ref    TEXT,
       project_id  TEXT,
       created_at  TEXT NOT NULL,
       updated_at  TEXT NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_incidents_customer ON incidents (customer_id)`,
  ],
};

interface IncidentRow {
  id: string;
  customer_id: string;
  title: string;
  report: string;
  severity: string;
  status: string;
  case_ref: string | null;
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

export class IncidentsRepository {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  insert(incident: Incident): void {
    this.#db
      .prepare(
        `INSERT INTO incidents
           (id, customer_id, title, report, severity, status, case_ref, project_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        incident.id, incident.customerId, incident.title, incident.report, incident.severity,
        incident.status, incident.caseRef, incident.projectId, incident.createdAt, incident.updatedAt,
      );
  }

  findById(id: string): Incident | null {
    const row = this.#db.prepare('SELECT * FROM incidents WHERE id = ?').get(id) as IncidentRow | undefined;
    return row === undefined ? null : toIncident(row);
  }

  listByCustomer(customerId: string): readonly Incident[] {
    const rows = this.#db
      .prepare('SELECT * FROM incidents WHERE customer_id = ? ORDER BY created_at DESC, id DESC')
      .all(customerId) as unknown as IncidentRow[];
    return rows.map(toIncident);
  }

  update(id: string, fields: { severity: IncidentSeverity; status: IncidentStatus; caseRef: string | null; updatedAt: string }): void {
    this.#db
      .prepare('UPDATE incidents SET severity = ?, status = ?, case_ref = ?, updated_at = ? WHERE id = ?')
      .run(fields.severity, fields.status, fields.caseRef, fields.updatedAt, id);
  }
}

function toIncident(row: IncidentRow): Incident {
  return {
    id: row.id,
    customerId: row.customer_id,
    title: row.title,
    report: row.report,
    severity: row.severity as IncidentSeverity,
    status: row.status as IncidentStatus,
    caseRef: row.case_ref,
    projectId: row.project_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
