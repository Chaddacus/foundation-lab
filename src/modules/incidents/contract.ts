/**
 * Incidents — public capability contract.
 *
 * Responsibility: define an operational incident and the operations over it.
 *
 * Place in the system: the public surface of the Incidents module.
 *
 * Scope decision (approved 2026-08-10): incidents are stored by THIS module and carry a
 * reference to an Elastic Case rather than being read live from Kibana. The live Cases
 * wiring lands with the Phase 12 drills, where Cases-as-incident-truth is what gets
 * exercised. Storing a reference now means that wiring is an adapter change, not a
 * remodelling — and `caseRef` is deliberately nullable so an incident that has no Case yet
 * is representable rather than faked.
 */

import type { Actor } from '../../spine/actor.ts';

export type IncidentSeverity = 'SEV-0' | 'SEV-1' | 'SEV-2' | 'SEV-3';
export type IncidentStatus = 'open' | 'mitigated' | 'resolved';

export interface Incident {
  readonly id: string;
  readonly customerId: string;
  readonly title: string;
  /** Free text as reported. User content — CONFIDENTIAL, never logged or placed in telemetry. */
  readonly report: string;
  /**
   * Severity of record. Set by a person or a deterministic rule — NEVER by the AI triage
   * capability, which may only attach a suggestion (see `src/modules/triage/`).
   */
  readonly severity: IncidentSeverity;
  readonly status: IncidentStatus;
  /** Elastic Case identifier, when one exists. Null means "no Case yet", not "unknown". */
  readonly caseRef: string | null;
  /**
   * Optional project this incident concerns, validated through the Projects capability so a
   * caller cannot attach another tenant's project id.
   */
  readonly projectId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateIncidentInput {
  readonly title: string;
  readonly report: string;
  readonly severity: IncidentSeverity;
  readonly caseRef?: string | null;
  readonly projectId?: string | null;
}

export interface UpdateIncidentInput {
  readonly severity?: IncidentSeverity;
  readonly status?: IncidentStatus;
  readonly caseRef?: string | null;
}

export interface IncidentsCapability {
  createIncident(actor: Actor, input: CreateIncidentInput): Incident;
  getIncident(actor: Actor, id: string): Incident;
  listIncidents(actor: Actor): readonly Incident[];
  /** Severity and status of record change only through here — never as a side effect of triage. */
  updateIncident(actor: Actor, id: string, input: UpdateIncidentInput): Incident;
}
