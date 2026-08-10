/**
 * Releases — capability implementation.
 *
 * Responsibility: implement `ReleasesCapability` by combining the domain rules, the
 * repository, and the Projects capability.
 *
 * Place in the system: internal to the Releases module. Every authorization decision about
 * releases is made here, so HTTP and MCP inherit it identically.
 *
 * Cross-module dependency, stated plainly: Releases needs to know whether the caller may
 * see a project. It calls `ProjectsCapability.getProject`, which already applies the tenant
 * rule and raises `not_found` for another customer's project. Releases therefore does NOT
 * re-implement the tenant check for projects, and MUST NOT read the projects table (SPEC
 * §3.2). One rule, one owner.
 */

import { AppError } from '../../spine/errors.ts';
import type { Actor } from '../../spine/actor.ts';
import type { ProjectsCapability } from '../projects/contract.ts';
import type {
  CreateReleaseInput,
  Release,
  ReleaseStatus,
  ReleasesCapability,
} from './contract.ts';
import { assertTransitionAllowed, normalizeCreate } from './domain.ts';
import type { ReleasesRepository } from './repository.ts';

export interface ServiceClock {
  now(): string;
  newId(): string;
}

export const systemClock: ServiceClock = {
  now: () => new Date().toISOString(),
  newId: () => crypto.randomUUID(),
};

export class ReleasesService implements ReleasesCapability {
  readonly #repository: ReleasesRepository;
  readonly #projects: ProjectsCapability;
  readonly #clock: ServiceClock;

  constructor(repository: ReleasesRepository, projects: ProjectsCapability, clock: ServiceClock = systemClock) {
    this.#repository = repository;
    this.#projects = projects;
    this.#clock = clock;
  }

  /**
   * Create a release candidate for a project the caller can see.
   *
   * The project lookup is the authorization check: an unreachable project raises
   * `not_found` before anything is written, so a release cannot be attached to another
   * tenant's project. The customer is copied from the project, never from the request.
   */
  createRelease(actor: Actor, input: CreateReleaseInput): Release {
    const normalized = normalizeCreate(input);
    const project = this.#projects.getProject(actor, normalized.projectId);
    const timestamp = this.#clock.now();

    const release: Release = {
      id: this.#clock.newId(),
      projectId: project.id,
      customerId: project.customerId,
      version: normalized.version,
      vcsRef: normalized.vcsRef,
      artifactDigest: normalized.artifactDigest,
      environment: normalized.environment,
      status: 'pending',
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.#repository.insert(release);
    return release;
  }

  /** Another customer's release is reported as not_found, for the reason given in the threat model. */
  getRelease(actor: Actor, id: string): Release {
    requireTenant(actor);
    if (typeof id !== 'string' || id.trim() === '') {
      throw AppError.validation('A release id is required.');
    }

    const release = this.#repository.findById(id);
    if (release === null || release.customerId !== actor.customerId) {
      throw AppError.notFound(`No release exists with id ${id}.`);
    }
    return release;
  }

  /** Authorized by the project lookup, then scoped again in the query itself. */
  listReleasesForProject(actor: Actor, projectId: string): readonly Release[] {
    const project = this.#projects.getProject(actor, projectId);
    return this.#repository.listByProject(project.id, project.customerId);
  }

  setReleaseStatus(actor: Actor, id: string, status: ReleaseStatus): Release {
    const existing = this.getRelease(actor, id);
    assertTransitionAllowed(existing.status, status);

    const updatedAt = this.#clock.now();
    this.#repository.updateStatus(id, status, updatedAt);
    return { ...existing, status, updatedAt };
  }
}

function requireTenant(actor: Actor): void {
  if (actor?.customerId === undefined || actor.customerId === '') {
    throw new AppError('unauthorized', 'Sign in to continue.');
  }
}
