/**
 * Customers — capability implementation.
 *
 * Responsibility: authenticate credentials, manage session lifetime, and answer customer
 * and user queries scoped to the caller.
 *
 * Place in the system: internal to the Customers module; the object the spine and the
 * adapters call. Every authorization decision about customers and users is made HERE, so
 * HTTP and MCP cannot diverge and a UI cannot be the thing enforcing a rule.
 *
 * Boundary: no transport, no cookies, no SQL. The spine turns a `SessionGrant` into a
 * cookie; this file does not know cookies exist.
 */

import { randomBytes } from 'node:crypto';
import { AppError } from '../../spine/errors.ts';
import type { Actor } from '../../spine/actor.ts';
import type {
  Customer,
  CustomersCapability,
  LoginInput,
  SessionGrant,
  User,
} from './contract.ts';
import { DUMMY_VERIFIER, hashPassword, verifyPassword } from './passwords.ts';
import type { CustomersRepository } from './repository.ts';

/** Injected so tests can pin time and identifiers and assert exact stored values. */
export interface AuthClock {
  now(): Date;
  newId(): string;
  newSessionId(): string;
}

export const systemAuthClock: AuthClock = {
  now: () => new Date(),
  newId: () => crypto.randomUUID(),
  // 256 bits. Session ids are bearer credentials: possession is authentication.
  newSessionId: () => randomBytes(32).toString('base64url'),
};

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;

/**
 * One message for every login failure.
 *
 * Unknown email, wrong password, and locked account are indistinguishable to the caller.
 * Separating them would let anyone enumerate which emails have accounts.
 */
const LOGIN_FAILED = 'That email and password combination is not correct.';

export class CustomersService implements CustomersCapability {
  readonly #repository: CustomersRepository;
  readonly #clock: AuthClock;

  constructor(repository: CustomersRepository, clock: AuthClock = systemAuthClock) {
    this.#repository = repository;
    this.#clock = clock;
  }

  /**
   * Exchange a credential for a session.
   *
   * Runs the password check even when the email is unknown, against a dummy verifier, so
   * an unknown account costs the same time as a wrong password. Response text alone does
   * not hide account existence if the timing gives it away.
   */
  login(input: LoginInput): SessionGrant {
    const email = typeof input?.email === 'string' ? input.email.trim() : '';
    const password = typeof input?.password === 'string' ? input.password : '';

    if (email === '' || password === '') {
      throw new AppError('unauthorized', LOGIN_FAILED);
    }

    const now = this.#clock.now();
    const row = this.#repository.findUserRowByEmail(email);

    if (row === null) {
      verifyPassword(password, DUMMY_VERIFIER);
      throw new AppError('unauthorized', LOGIN_FAILED);
    }

    // A locked account still pays the hashing cost, so lockout is not detectable by timing.
    const lockedUntil = row.locked_until === null ? null : new Date(row.locked_until);
    const isLocked = lockedUntil !== null && lockedUntil > now;

    const passwordMatches = verifyPassword(password, row.password_verifier);

    if (isLocked || !passwordMatches) {
      if (!isLocked) this.#recordFailure(row.id, row.failed_attempts, now);
      throw new AppError('unauthorized', LOGIN_FAILED);
    }

    this.#repository.clearFailedAttempts(row.id);

    // Session fixation is structurally impossible here: ids are generated server-side and
    // a client-supplied one is never adopted, so every login already yields a fresh id.
    //
    // Existing sessions are deliberately NOT destroyed. Doing so would mean signing in on a
    // second device silently signs you out of the first — a single-session policy, which is
    // a product decision, not a security requirement, and not one this application needs.
    this.#repository.deleteExpiredSessions(now.toISOString());

    const sessionId = this.#clock.newSessionId();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
    this.#repository.insertSession({
      id: sessionId,
      userId: row.id,
      expiresAt,
      createdAt: now.toISOString(),
    });

    return {
      sessionId,
      actor: { id: row.id, customerId: row.customer_id },
      email: row.email,
      expiresAt,
    };
  }

  /**
   * Resolve a session id to its actor.
   *
   * Returns null for absent, unknown, and expired sessions alike — the caller turns that
   * into `unauthorized`. An expired session is deleted on sight rather than left to
   * accumulate as a usable-looking row.
   */
  resolveSession(sessionId: string): Actor | null {
    if (typeof sessionId !== 'string' || sessionId === '') return null;

    const session = this.#repository.findSession(sessionId);
    if (session === null) return null;

    if (new Date(session.expiresAt) <= this.#clock.now()) {
      this.#repository.deleteSession(sessionId);
      return null;
    }

    const user = this.#repository.findUserById(session.userId);
    if (user === null) return null;

    return { id: user.id, customerId: user.customerId };
  }

  /** Idempotent: signing out an already-dead session is a success, not an error. */
  logout(sessionId: string): void {
    if (typeof sessionId === 'string' && sessionId !== '') {
      this.#repository.deleteSession(sessionId);
    }
  }

  /**
   * The caller's customer.
   *
   * Another customer's id raises `not_found`, NOT `forbidden`. `forbidden` would confirm
   * that the id exists, which is a cross-tenant disclosure (threat model, Information
   * disclosure). Do not "correct" this to `forbidden`.
   */
  getCustomer(actor: Actor, id: string): Customer {
    if (id !== actor.customerId) {
      throw AppError.notFound(`No customer exists with id ${id}.`);
    }

    const customer = this.#repository.findCustomerById(id);
    if (customer === null) {
      throw AppError.notFound(`No customer exists with id ${id}.`);
    }
    return customer;
  }

  /** Scoped by construction: the query takes the caller's customer, never a parameter. */
  listUsers(actor: Actor): readonly User[] {
    return this.#repository.listUsersByCustomer(actor.customerId);
  }

  /**
   * Provision a customer.
   *
   * Deliberately NOT exposed through any adapter: slice 2 has no admin role, so there is no
   * authenticated caller entitled to create tenants. Used by the local seed and by tests.
   */
  provisionCustomer(name: string): Customer {
    const customer: Customer = {
      id: this.#clock.newId(),
      name,
      createdAt: this.#clock.now().toISOString(),
    };
    this.#repository.insertCustomer(customer);
    return customer;
  }

  /** Provision a user. Not exposed through any adapter, for the same reason as above. */
  provisionUser(customerId: string, email: string, password: string): User {
    const user: User = {
      id: this.#clock.newId(),
      email: email.trim(),
      customerId,
      createdAt: this.#clock.now().toISOString(),
    };
    this.#repository.insertUser({ ...user, passwordVerifier: hashPassword(password) });
    return user;
  }

  #recordFailure(userId: string, previousFailures: number, now: Date): void {
    const failedAttempts = previousFailures + 1;
    const lockedUntil = failedAttempts >= MAX_FAILED_ATTEMPTS
      ? new Date(now.getTime() + LOCKOUT_MS).toISOString()
      : null;
    this.#repository.recordFailedAttempt(userId, failedAttempts, lockedUntil);
  }
}
