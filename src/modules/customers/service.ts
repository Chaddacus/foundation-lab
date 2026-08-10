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
import { RateLimiter, THROTTLE_MAX_ATTEMPTS, THROTTLE_WINDOW_MS } from '../../spine/rate-limit.ts';
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
  readonly #throttle: RateLimiter;

  constructor(
    repository: CustomersRepository,
    clock: AuthClock = systemAuthClock,
    throttle: RateLimiter = new RateLimiter(THROTTLE_MAX_ATTEMPTS, THROTTLE_WINDOW_MS),
  ) {
    this.#repository = repository;
    this.#clock = clock;
    this.#throttle = throttle;
  }

  /**
   * Exchange a credential for a session.
   *
   * Runs the password check even when the email is unknown, against a dummy verifier, so
   * an unknown account costs the same time as a wrong password. Response text alone does
   * not hide account existence if the timing gives it away.
   */
  async login(input: LoginInput): Promise<SessionGrant> {
    const email = typeof input?.email === 'string' ? input.email.trim() : '';
    const password = typeof input?.password === 'string' ? input.password : '';

    if (email === '' || password === '') {
      throw new AppError('unauthorized', LOGIN_FAILED);
    }

    // Bound hashing work BEFORE any scrypt call, ATOMICALLY. The per-user lockout below
    // cannot help here: it lives on a user row, so an unknown address could never be
    // throttled and could drive unlimited scrypt.
    //
    // tryAcquire checks-and-counts in one step with no await, so concurrent arrivals cannot
    // all slip past a check before any of them counts — the race the async hash introduced.
    // Keyed by address regardless of whether an account exists, so it reveals nothing about
    // account existence.
    if (!this.#throttle.tryAcquire(email)) {
      throw new AppError('unauthorized', LOGIN_FAILED);
    }

    const now = this.#clock.now();
    const row = this.#repository.findUserRowByEmail(email);

    if (row === null) {
      await this.#verify(password, DUMMY_VERIFIER);
      throw new AppError('unauthorized', LOGIN_FAILED);
    }

    // A locked account still pays the hashing cost, so lockout is not detectable by timing.
    // The throttle above is what bounds total work; this comparison is about not leaking
    // lock state through response time, and the two concerns are deliberately separate.
    const lockedUntil = row.locked_until === null ? null : new Date(row.locked_until);
    const isLocked = lockedUntil !== null && lockedUntil > now;

    const passwordMatches = await this.#verify(password, row.password_verifier);

    if (isLocked || !passwordMatches) {
      if (!isLocked) this.#recordFailure(row.id, now);
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
  async provisionUser(customerId: string, email: string, password: string): Promise<User> {
    const user: User = {
      id: this.#clock.newId(),
      email: email.trim(),
      customerId,
      createdAt: this.#clock.now().toISOString(),
    };
    let verifier: string;
    try {
      verifier = await hashPassword(password);
    } catch (error) {
      // Same translation as #verify: a saturated gate is a retryable dependency condition,
      // not an internal fault. Provisioning is not adapter-reachable today, but the scripts
      // that call it should get a clean error rather than a 500-class untranslated throw.
      if (error instanceof Error && error.name === 'HashGateSaturated') {
        throw new AppError('dependency', 'The service is busy. Please try again in a moment.');
      }
      throw error;
    }
    this.#repository.insertUser({ ...user, passwordVerifier: verifier });
    return user;
  }

  /**
   * Hash comparison with load-shedding mapped to a retryable failure.
   *
   * A saturated hash gate means the service is shedding password work under flood, not that
   * the password is wrong. Returning `unauthorized` would tell a legitimate user their
   * credentials are bad; `dependency` (503) tells them to retry, and keeps a flood from
   * being silently absorbed as a wall of auth failures.
   */
  async #verify(password: string, verifier: string): Promise<boolean> {
    try {
      return await verifyPassword(password, verifier);
    } catch (error) {
      if (error instanceof Error && error.name === 'HashGateSaturated') {
        throw new AppError('dependency', 'The service is busy. Please try signing in again in a moment.');
      }
      throw error;
    }
  }

  /**
   * Count one failed attempt, ATOMICALLY.
   *
   * Was: read `failed_attempts` off the row, add one in JS, write the absolute value. Safe
   * when login was synchronous; under the async hash, N concurrent failures all read the
   * same stale count and all wrote `1`, so the lockout never tripped (measured in review:
   * 30 concurrent wrong guesses left the counter at 1). The increment now happens inside a
   * single SQL statement, so the database — not a stale JS read — owns the count, and the
   * lock is set in the same statement the instant the count crosses the threshold.
   */
  #recordFailure(userId: string, now: Date): void {
    const lockedUntilIfTripped = new Date(now.getTime() + LOCKOUT_MS).toISOString();
    this.#repository.recordFailedAttempt(userId, MAX_FAILED_ATTEMPTS, lockedUntilIfTripped);
  }
}
