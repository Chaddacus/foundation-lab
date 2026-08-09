/**
 * Actor identity and the authorization seam.
 *
 * Responsibility: resolve the caller of a request into an `Actor`, or refuse the request.
 *
 * Place in the system: spine. Identity is application-wide. Capability modules receive an
 * already-resolved `Actor` and decide authority over their OWN resources; they never parse
 * transport headers.
 *
 * SLICE 1 SCOPE — read this before trusting it. There is NO authentication. The actor
 * header is an unverified development convenience, and no module checks the actor against
 * resource ownership, so any identified caller can read and write every project. Real
 * authentication and ownership checks arrive with the Customers module in slice 2
 * (SPEC §7, §10.1). Do not read slice 1 as having any authorization model.
 *
 * Because the header is unverified, it is honoured ONLY in LOCAL. An earlier version
 * accepted it everywhere and described that as fail-closed; it was the opposite — one
 * forged header granted full cross-tenant access in any environment. Every non-LOCAL
 * environment now refuses all traffic until real authentication exists.
 */

import { AppError } from './errors.ts';
import type { Config } from './config.ts';

export interface Actor {
  readonly id: string;
  /** The customer this actor acts on behalf of. Slice 2 authorizes resources against it. */
  readonly customerId: string;
}

/**
 * Header carrying an unverified development actor id.
 *
 * It is NOT authentication: anyone can set it. It exists so local work can exercise more
 * than one identity before real authentication lands in slice 2.
 */
export const ACTOR_HEADER = 'x-foundation-lab-actor';

/**
 * Resolve an actor from request headers.
 *
 * Refuses every request outside LOCAL. That is deliberate and load-bearing: an unverified
 * header MUST NOT be treated as identity in an environment that other people can reach, so
 * deploying this unfinished seam to DEV or SANDBOX denies service rather than granting
 * anonymous cross-tenant access. Slice 2 replaces this whole function.
 */
export function resolveActor(
  headers: Record<string, string | string[] | undefined>,
  config: Config,
): Actor {
  if (config.environment !== 'LOCAL') {
    throw new AppError(
      'unauthorized',
      'This environment is not accepting requests yet. Sign-in is not available.',
    );
  }

  const raw = headers[ACTOR_HEADER];
  const actorId = Array.isArray(raw) ? raw[0] : raw;

  if (actorId !== undefined && actorId.trim() !== '') {
    return { id: actorId.trim(), customerId: `customer-of-${actorId.trim()}` };
  }

  return { id: 'local-developer', customerId: 'customer-local' };
}
