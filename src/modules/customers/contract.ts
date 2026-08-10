/**
 * Customers — public capability contract.
 *
 * Responsibility: the single definition of customers, the users belonging to them, and the
 * authentication capability that turns a credential into a session.
 *
 * Place in the system: the public surface of the Customers module. The spine depends on
 * `authenticate` to resolve every request's actor; other modules depend only on the
 * `Actor` they are handed.
 *
 * Boundary: types and the interface. No password handling, no SQL, no transport. Nothing
 * here exposes a password verifier — `User` deliberately has no such field, so a verifier
 * cannot leave the module even by accident.
 */

import type { Actor } from '../../spine/actor.ts';

export interface Customer {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

/**
 * A user account.
 *
 * There is no password field. The verifier lives in the module's storage row type and is
 * never lifted into the contract, so no adapter can serialize it.
 */
export interface User {
  readonly id: string;
  readonly email: string;
  readonly customerId: string;
  readonly createdAt: string;
}

/** What a successful login produces. The raw session id goes to the cookie, never to a body. */
export interface SessionGrant {
  readonly sessionId: string;
  readonly actor: Actor;
  /** The signed-in user's own email, so an interface can name them rather than show a uuid. */
  readonly email: string;
  readonly expiresAt: string;
}

export interface LoginInput {
  readonly email: string;
  readonly password: string;
}

/**
 * The Customers capability.
 *
 * `login` and `resolveSession` are the only methods reachable without an authenticated
 * actor; everything else takes one and is authorized against it.
 */
export interface CustomersCapability {
  /**
   * Exchange a credential for a session.
   *
   * Raises `unauthorized` for unknown email, wrong password, and locked-out account alike —
   * one message for all three, so login cannot be used to enumerate accounts. Raises
   * `dependency` (retryable) when password hashing is being shed under load.
   *
   * Asynchronous because hashing runs off the main thread: a synchronous login would block
   * the single Node thread for the duration of a scrypt, which is the defect Phase 12 fixed.
   */
  login(input: LoginInput): Promise<SessionGrant>;

  /** Resolve a session id to its actor, or null when absent, unknown, or expired. */
  resolveSession(sessionId: string): Actor | null;

  /** Destroy a session. Idempotent: signing out twice is not an error. */
  logout(sessionId: string): void;

  /** The caller's own customer. Another customer's id raises `not_found`, never `forbidden`. */
  getCustomer(actor: Actor, id: string): Customer;

  /** Users within the caller's customer only. */
  listUsers(actor: Actor): readonly User[];
}
