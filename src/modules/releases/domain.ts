/**
 * Releases — domain rules.
 *
 * Responsibility: validate release input and decide which lifecycle transitions are legal.
 *
 * Place in the system: internal to the Releases module. Pure, so the rules are proven by
 * plain function calls rather than by driving a server.
 *
 * Boundary: no I/O, no clock, no authorization.
 */

import { AppError } from '../../spine/errors.ts';
import type { CreateReleaseInput, ReleaseEnvironment, ReleaseStatus } from './contract.ts';

export const ENVIRONMENTS: readonly ReleaseEnvironment[] = ['DEV', 'SANDBOX'];
export const VERSION_MAX_LENGTH = 60;

/**
 * Legal lifecycle transitions.
 *
 * `verified` and `rolled_back` are terminal: a release that was verified must not silently
 * return to `pending`, because release status is evidence about what is running, and
 * evidence that can be rewritten backwards is not evidence.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<ReleaseStatus, readonly ReleaseStatus[]>> = {
  pending: ['deployed', 'rolled_back'],
  deployed: ['verified', 'rolled_back'],
  verified: [],
  rolled_back: [],
};

export interface NormalizedRelease {
  readonly projectId: string;
  readonly version: string;
  readonly vcsRef: string;
  readonly artifactDigest: string;
  readonly environment: ReleaseEnvironment;
}

/** Validate a create request, collecting every field error before raising. */
export function normalizeCreate(input: CreateReleaseInput): NormalizedRelease {
  const details: Record<string, string> = {};

  const projectId = text(input?.projectId);
  if (projectId === '') details.projectId = 'Choose the project this release belongs to.';

  const version = text(input?.version);
  if (version === '') {
    details.version = 'Enter a version, for example 1.4.0.';
  } else if (version.length > VERSION_MAX_LENGTH) {
    details.version = `Use ${VERSION_MAX_LENGTH} characters or fewer.`;
  }

  const vcsRef = text(input?.vcsRef);
  if (vcsRef === '') details.vcsRef = 'Enter the source revision this was built from.';

  const artifactDigest = text(input?.artifactDigest);
  if (artifactDigest === '') details.artifactDigest = 'Enter the artifact digest.';

  const environment = text(input?.environment) as ReleaseEnvironment;
  if (!ENVIRONMENTS.includes(environment)) {
    details.environment = `Choose one of: ${ENVIRONMENTS.join(', ')}.`;
  }

  if (Object.keys(details).length > 0) {
    throw AppError.validation('That release could not be saved. Correct the fields below and try again.', details);
  }

  return { projectId, version, vcsRef, artifactDigest, environment };
}

/**
 * Check a lifecycle transition.
 *
 * Raises `conflict` rather than `validation`: the input is well formed, but the release is
 * not in a state where it applies. The distinction matters to a client deciding whether
 * retrying could ever help.
 */
export function assertTransitionAllowed(from: ReleaseStatus, to: ReleaseStatus): void {
  if (!(to in ALLOWED_TRANSITIONS)) {
    throw AppError.validation(`"${to}" is not a release status.`);
  }
  if (from === to) {
    throw AppError.conflict(`This release is already ${from}.`);
  }
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    const allowed = ALLOWED_TRANSITIONS[from];
    throw AppError.conflict(
      allowed.length === 0
        ? `A ${from} release cannot change status again.`
        : `A ${from} release can only become ${allowed.join(' or ')}.`,
    );
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
