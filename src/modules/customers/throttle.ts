/**
 * Login attempt throttling.
 *
 * Responsibility: bound how often any single email address can trigger password hashing.
 *
 * Place in the system: internal to the Customers module, consulted by `login` BEFORE any
 * scrypt work.
 *
 * Why it exists separately from the per-user lockout: the database lockout lives on a user
 * row, so an email with no account could never be throttled, and an attacker could drive
 * unlimited scrypt with unknown addresses. scrypt is deliberately expensive (~32 MiB, tens
 * of milliseconds) and `scryptSync` blocks Node's only thread, so that was a cheap way to
 * degrade the whole service. Measured before this existed: a flood of unauthenticated
 * logins raised an authenticated read from ~1 ms to ~58 ms.
 *
 * Keyed by email, NOT by account existence, so a throttled response reveals nothing about
 * whether the address is registered — known and unknown addresses throttle identically.
 *
 * SCOPE, stated honestly: this bounds work per address. An attacker using many DISTINCT
 * addresses is still limited only by the machine. Closing that needs a work queue or an
 * upstream rate limit, which belongs with the DEV/SANDBOX deployment in slice 5. Recorded
 * in SPEC §10 and the threat model rather than implied to be solved.
 */

export interface ThrottleClock {
  now(): number;
}

export const systemThrottleClock: ThrottleClock = { now: () => Date.now() };

/** FAILED attempts allowed per address inside the window before hashing is refused. */
export const THROTTLE_MAX_ATTEMPTS = 10;
export const THROTTLE_WINDOW_MS = 60_000;

interface Attempt {
  count: number;
  windowStartedAt: number;
}

export class LoginThrottle {
  readonly #attempts = new Map<string, Attempt>();
  readonly #clock: ThrottleClock;

  constructor(clock: ThrottleClock = systemThrottleClock) {
    this.#clock = clock;
  }

  /**
   * Whether another hashing attempt is allowed for this address. Does not itself count.
   *
   * Only FAILURES are counted (see `recordFailure`). Counting successes as well would
   * throttle ordinary use — a person or a test signing in repeatedly with the correct
   * password is not the threat, and an attacker has no correct password to use. Bounding
   * failures bounds the attack while leaving legitimate sign-in untouched.
   */
  allow(email: string): boolean {
    const existing = this.#attempts.get(normalize(email));
    if (existing === undefined) return true;
    if (this.#clock.now() - existing.windowStartedAt >= THROTTLE_WINDOW_MS) return true;
    return existing.count < THROTTLE_MAX_ATTEMPTS;
  }

  /**
   * Count one failed attempt against this address.
   *
   * Called for unknown addresses as well as known ones, so an address with no account is
   * throttled exactly like one with an account — the bound cannot be used to discover which
   * addresses are registered.
   */
  recordFailure(email: string): void {
    const key = normalize(email);
    const now = this.#clock.now();
    const existing = this.#attempts.get(key);

    if (existing === undefined || now - existing.windowStartedAt >= THROTTLE_WINDOW_MS) {
      this.#attempts.set(key, { count: 1, windowStartedAt: now });
      this.#evictExpired(now);
      return;
    }

    existing.count += 1;
  }

  /**
   * How many addresses are currently tracked.
   *
   * Exists so the eviction behavior can be asserted directly. The map is attacker-controlled
   * in size, so "it does not grow without bound" is a property worth observing rather than
   * assuming — and a test that cannot see the map proves nothing about it.
   */
  get trackedAddresses(): number {
    return this.#attempts.size;
  }

  /**
   * Drop entries whose window has closed.
   *
   * Without this the map is an unbounded, attacker-controlled allocation — the throttle
   * would become its own memory-exhaustion vector. Runs only when a new window opens, so it
   * costs nothing on the hot path.
   */
  #evictExpired(now: number): void {
    for (const [key, attempt] of this.#attempts) {
      if (now - attempt.windowStartedAt >= THROTTLE_WINDOW_MS) this.#attempts.delete(key);
    }
  }
}

function normalize(email: string): string {
  return email.trim().toLowerCase();
}
