/**
 * Incidents — capability implementation.
 *
 * Responsibility: implement `IncidentsCapability`, applying the domain rules and the tenant
 * boundary.
 *
 * Place in the system: internal to the Incidents module. Every authorization decision about
 * incidents is made here, so HTTP and MCP inherit it identically.
 *
 * Note for whoever adds AI later: severity and status of record change ONLY through
 * `updateIncident`. The triage capability has no path to them, deliberately — deterministic
 * software owns state (Standard 9).
 */

import { AppError } from '../../spine/errors.ts';
import type { Actor } from '../../spine/actor.ts';
import type {
  CreateIncidentInput,
  Incident,
  IncidentsCapability,
  UpdateIncidentInput,
} from './contract.ts';
import { normalizeCreate, normalizeUpdate } from './domain.ts';
import type { IncidentsRepository } from './repository.ts';

export interface ServiceClock {
  now(): string;
  newId(): string;
}

export const systemClock: ServiceClock = {
  now: () => new Date().toISOString(),
  newId: () => crypto.randomUUID(),
};

export class IncidentsService implements IncidentsCapability {
  readonly #repository: IncidentsRepository;
  readonly #clock: ServiceClock;

  constructor(repository: IncidentsRepository, clock: ServiceClock = systemClock) {
    this.#repository = repository;
    this.#clock = clock;
  }

  createIncident(actor: Actor, input: CreateIncidentInput): Incident {
    requireTenant(actor);
    const normalized = normalizeCreate(input);
    const timestamp = this.#clock.now();

    const incident: Incident = {
      id: this.#clock.newId(),
      customerId: actor.customerId,
      title: normalized.title,
      report: normalized.report,
      severity: normalized.severity,
      status: 'open',
      caseRef: normalized.caseRef,
      projectId: normalized.projectId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.#repository.insert(incident);
    return incident;
  }

  /** Another customer's incident is reported as not_found — see the slice-2 threat model. */
  getIncident(actor: Actor, id: string): Incident {
    requireTenant(actor);
    if (typeof id !== 'string' || id.trim() === '') {
      throw AppError.validation('An incident id is required.');
    }

    const incident = this.#repository.findById(id);
    if (incident === null || incident.customerId !== actor.customerId) {
      throw AppError.notFound(`No incident exists with id ${id}.`);
    }
    return incident;
  }

  listIncidents(actor: Actor): readonly Incident[] {
    requireTenant(actor);
    return this.#repository.listByCustomer(actor.customerId);
  }

  updateIncident(actor: Actor, id: string, input: UpdateIncidentInput): Incident {
    const existing = this.getIncident(actor, id);
    const changes = normalizeUpdate(input, existing.status);

    const updated: Incident = {
      ...existing,
      severity: changes.severity ?? existing.severity,
      status: changes.status ?? existing.status,
      caseRef: changes.caseRef === undefined ? existing.caseRef : changes.caseRef,
      updatedAt: this.#clock.now(),
    };

    this.#repository.update(id, {
      severity: updated.severity,
      status: updated.status,
      caseRef: updated.caseRef,
      updatedAt: updated.updatedAt,
    });

    return updated;
  }
}

function requireTenant(actor: Actor): void {
  if (actor?.customerId === undefined || actor.customerId === '') {
    throw new AppError('unauthorized', 'Sign in to continue.');
  }
}
