/**
 * Actor identity and the authorization seam.
 *
 * Responsibility: resolve the caller of a request into an `Actor`, or refuse the request.
 *
 * Place in the system: spine. Identity is application-wide. Capability modules receive an
 * already-resolved `Actor` and decide authority over their OWN resources; they never parse
 * transport headers.
 *
 * SLICE 1 SCOPE — read this before trusting it. Authentication here is a development
 * header, and no module yet checks the actor against resource ownership. This file
 * establishes the seam and the fail-closed default. The real ownership check arrives with
 * the Customers module in slice 2 (SPEC §7, §10.1). Do not read slice 1 as having a tested
 * authorization model.
 */

import { AppError } from './errors.ts';
import type { Config } from './config.ts';

export interface Actor {
  readonly id: string;
  /** The customer this actor acts on behalf of. Slice 2 authorizes resources against it. */
  readonly customerId: string;
}

/** Header carrying the development actor id. Replaced by real authentication in slice 2. */
export const ACTOR_HEADER = 'x-foundation-lab-actor';

/**
 * Resolve an actor from request headers.
 *
 * Fails closed: an unresolvable caller raises `unauthorized` rather than defaulting to a
 * privileged identity. Outside LOCAL there is no development fallback at all, so shipping
 * this seam to DEV or SANDBOX unfinished refuses traffic instead of granting it.
 */
export function resolveActor(
  headers: Record<string, string | string[] | undefined>,
  config: Config,
): Actor {
  const raw = headers[ACTOR_HEADER];
  const actorId = Array.isArray(raw) ? raw[0] : raw;

  if (actorId !== undefined && actorId.trim() !== '') {
    return { id: actorId.trim(), customerId: `customer-of-${actorId.trim()}` };
  }

  if (config.environment === 'LOCAL') {
    return { id: 'local-developer', customerId: 'customer-local' };
  }

  throw new AppError(
    'unauthorized',
    'We could not identify who is making this request. Sign in and try again.',
  );
}
