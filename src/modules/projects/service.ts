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
import { normalizeCreate, normalizeUpdate } from './domain.ts';
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
   * Create a project owned by a customer.
   *
   * New projects are always `active`; slice 1 has no path to any other status.
   */
  createProject(actor: Actor, input: CreateProjectInput): Project {
    const normalized = normalizeCreate(input);
    const timestamp = this.#clock.now();

    const project: Project = {
      id: this.#clock.newId(),
      name: normalized.name,
      description: normalized.description,
      customerId: normalized.customerId,
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
    requireProjectId(id);
    const project = this.#repository.findById(id);
    if (project === null) {
      throw AppError.notFound(`No project exists with id ${id}.`);
    }
    return project;
  }

  listProjects(actor: Actor): readonly Project[] {
    return this.#repository.listAll();
  }

  /**
   * Apply a partial update.
   *
   * Reads the current project first so an unknown id fails as `not_found` rather than as a
   * silent zero-row UPDATE, and so absent fields keep their existing values.
   */
  updateProject(actor: Actor, id: string, input: UpdateProjectInput): Project {
    const existing = this.getProject(actor, id);
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
