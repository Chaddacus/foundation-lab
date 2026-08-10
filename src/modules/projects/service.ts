/**
 * Projects — capability implementation.
 *
 * Responsibility: implement `ProjectsCapability` by combining the domain rules with the
 * repository, and own the non-deterministic inputs (clock, id generation).
 *
 * Place in the system: internal to the Projects module; the object the adapters call. This
 * is the ONE place project business logic lives — the HTTP and MCP adapters both delegate
 * here, which is how SPEC §3.3 forbids duplicated logic.
 *
 * Boundary: no transport concepts (status codes, tool schemas) and no SQL.
 */

import { AppError } from '../../spine/errors.ts';
import type { Actor } from '../../spine/actor.ts';
import type {
  CreateProjectInput,
  Project,
  ProjectsCapability,
  UpdateProjectInput,
} from './contract.ts';
import { assertArchivable, assertEditable, normalizeCreate, normalizeUpdate } from './domain.ts';
import type { ProjectsRepository } from './repository.ts';

/** Injected so tests can freeze time and ids, and assert on exact stored values. */
export interface ServiceClock {
  now(): string;
  newId(): string;
}

export const systemClock: ServiceClock = {
  now: () => new Date().toISOString(),
  newId: () => crypto.randomUUID(),
};

/**
 * Reject a missing or blank project id before it reaches storage.
 *
 * Lives in the service so every adapter inherits one answer. Schema validity in a tool
 * definition is not semantic correctness, and an HTTP path segment is unvalidated by
 * definition — neither can be trusted to have done this.
 */
/**
 * Refuse an actor with no tenant.
 *
 * The spine hands public routes an anonymous actor whose `customerId` is empty. Comparing
 * against it would already fail every ownership check, but an explicit refusal turns a
 * silently-empty result set into a visible authorization error.
 */
function requireTenant(actor: Actor): void {
  if (actor?.customerId === undefined || actor.customerId === '') {
    throw new AppError('unauthorized', 'Sign in to continue.');
  }
}

function requireProjectId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || id.trim() === '') {
    throw AppError.validation('A project id is required.');
  }
}

export class ProjectsService implements ProjectsCapability {
  readonly #repository: ProjectsRepository;
  readonly #clock: ServiceClock;

  constructor(repository: ProjectsRepository, clock: ServiceClock = systemClock) {
    this.#repository = repository;
    this.#clock = clock;
  }

  /**
   * Archive a project.
   *
   * Reads through `getProject`, so the tenant check is the same code the read path uses —
   * a cross-tenant id fails as `not_found` before anything is written, and there is no
   * second implementation to drift.
   */
  archiveProject(actor: Actor, id: string): Project {
    const existing = this.getProject(actor, id);
    assertArchivable(existing.status);

    const updatedAt = this.#clock.now();
    this.#repository.updateStatus(id, 'archived', updatedAt);

    return { ...existing, status: 'archived', updatedAt };
  }

  /**
   * Create a project owned by the caller's customer.
   *
   * Ownership comes from the SESSION, never from the request body. A client that sends
   * `customerId` cannot assign a project to another tenant — that is the mass-assignment
   * threat in the model, and it is closed here rather than by hoping adapters strip fields.
   *
   * New projects are always `active`; the archive transition is slice 4.
   */
  createProject(actor: Actor, input: CreateProjectInput): Project {
    requireTenant(actor);
    const normalized = normalizeCreate(input);
    const timestamp = this.#clock.now();

    const project: Project = {
      id: this.#clock.newId(),
      name: normalized.name,
      description: normalized.description,
      customerId: actor.customerId,
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.#repository.insert(project);
    return project;
  }

  /**
   * Raises `not_found` for an unknown id — the absence of a project is a client-visible fact.
   *
   * The id is validated HERE rather than in an adapter. When only the MCP adapter checked
   * it, the two adapters answered a blank id differently (`validation` vs `not_found`),
   * which is precisely the divergence SPEC §3.3 forbids.
   */
  getProject(actor: Actor, id: string): Project {
    requireTenant(actor);
    requireProjectId(id);

    const project = this.#repository.findById(id);

    // A project belonging to another customer is reported as NOT FOUND, identically to one
    // that does not exist. Returning `forbidden` would confirm the id is real, which is a
    // cross-tenant disclosure. This is deliberate — see the threat model. Do not "fix" it.
    if (project === null || project.customerId !== actor.customerId) {
      throw AppError.notFound(`No project exists with id ${id}.`);
    }
    return project;
  }

  /** Scoped by construction: the query takes the caller's customer, not a filter argument. */
  listProjects(actor: Actor): readonly Project[] {
    requireTenant(actor);
    return this.#repository.listByCustomer(actor.customerId);
  }

  /**
   * Apply a partial update.
   *
   * Reads the current project first so an unknown id fails as `not_found` rather than as a
   * silent zero-row UPDATE, and so absent fields keep their existing values.
   */
  updateProject(actor: Actor, id: string, input: UpdateProjectInput): Project {
    // Reads through `getProject`, so the tenant check is applied on the write path by the
    // same code that applies it on the read path — there is no second implementation to
    // drift. A cross-tenant id therefore fails as not_found before any mutation.
    const existing = this.getProject(actor, id);
    assertEditable(existing.status);
    const changes = normalizeUpdate(input);

    const updated: Project = {
      ...existing,
      name: changes.name ?? existing.name,
      description: changes.description ?? existing.description,
      updatedAt: this.#clock.now(),
    };

    this.#repository.update(id, {
      name: updated.name,
      description: updated.description,
      updatedAt: updated.updatedAt,
    });

    return updated;
  }
}
