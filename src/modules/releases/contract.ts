/**
 * Releases — public capability contract.
 *
 * Responsibility: define release candidates — what revision, what artifact, which
 * environment, what status — and the operations over them.
 *
 * Place in the system: the public surface of the Releases module.
 *
 * Boundary: a release belongs to a project, and a project belongs to a customer. Releases
 * does NOT read the projects table; it asks the Projects capability, which applies the
 * tenant check. That is what keeps the ownership rule in one place (SPEC §3.2).
 */

import type { Actor } from '../../spine/actor.ts';

/** Where a release has been deployed. Mirrors the deployment environments in SPEC §9. */
export type ReleaseEnvironment = 'DEV' | 'SANDBOX';

/**
 * Release lifecycle.
 *
 * `pending` → `deployed` → (`verified` | `rolled_back`). The transitions a slice implements
 * are enforced in the domain; the value space is declared here in full so later slices
 * change behavior rather than schema.
 */
export type ReleaseStatus = 'pending' | 'deployed' | 'verified' | 'rolled_back';

export interface Release {
  readonly id: string;
  readonly projectId: string;
  /** Denormalized for authorization: lets a tenant check run without a second lookup. */
  readonly customerId: string;
  readonly version: string;
  /** Source revision this candidate was built from — joins a release to its telemetry. */
  readonly vcsRef: string;
  /** Build-once artifact identity, the same value telemetry reports as `app.artifact.digest`. */
  readonly artifactDigest: string;
  readonly environment: ReleaseEnvironment;
  readonly status: ReleaseStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateReleaseInput {
  readonly projectId: string;
  readonly version: string;
  readonly vcsRef: string;
  readonly artifactDigest: string;
  readonly environment: ReleaseEnvironment;
}

export interface ReleasesCapability {
  createRelease(actor: Actor, input: CreateReleaseInput): Release;
  getRelease(actor: Actor, id: string): Release;
  /** Releases for one project the caller can see. */
  listReleasesForProject(actor: Actor, projectId: string): readonly Release[];
  /** Advance a release's lifecycle. Invalid transitions raise `conflict`. */
  setReleaseStatus(actor: Actor, id: string, status: ReleaseStatus): Release;
}
