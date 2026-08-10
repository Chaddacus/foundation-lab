/**
 * Actor identity.
 *
 * Responsibility: define who a request is acting as, once authentication has resolved.
 *
 * Place in the system: spine. Identity is application-wide. Capability modules receive a
 * resolved `Actor` and authorize their OWN resources against it; they never parse headers
 * or cookies.
 *
 * History worth keeping: slice 1 resolved the actor from an unverified request header.
 * Independent review showed that any forged header granted full cross-tenant access. The
 * header is gone. Identity now comes only from a signed session cookie backed by a
 * server-side session row (see `session.ts` and the Customers module).
 */

export interface Actor {
  readonly id: string;
  /**
   * The customer this actor acts for. Every tenant authorization decision compares against
   * this value, and it comes from the authenticated session — NEVER from a request body.
   */
  readonly customerId: string;
}
