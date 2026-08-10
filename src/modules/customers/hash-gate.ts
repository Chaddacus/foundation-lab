/**
 * Global bound on concurrent password hashing.
 *
 * Responsibility: cap how many scrypt operations run at once across the whole process, and
 * bound how many may wait, rejecting the rest fast.
 *
 * Place in the system: internal to the Customers module, held once and shared by every
 * login. It is deliberately global, not per-email: the incident it exists to prevent
 * (Phase 12) was a flood of DISTINCT addresses, each of which slipped past the per-email
 * throttle and drove its own hash.
 *
 * Why it is needed even though hashing is now asynchronous: async scrypt runs on libuv's
 * thread pool, so it no longer freezes the main thread — but an unbounded flood would still
 * queue thousands of operations, each holding ~32 MiB while it runs, and saturate the pool
 * so that legitimate logins wait behind the flood. This caps both the memory in flight and
 * the depth of the wait, and sheds load past that with a retryable failure rather than
 * absorbing it. It bounds work; it is not a substitute for an upstream/network rate limit.
 *
 * Fairness note: the cap is global, so a genuine burst of many simultaneous legitimate
 * logins can be shed too. That is an accepted trade — a rejected login is recoverable by
 * retry, a starved service is not — and legitimate login concurrency in this application is
 * small. Recorded rather than hidden.
 */

/** Raised when the gate is saturated. The caller maps it to a retryable denial. */
export class HashGateSaturated extends Error {
  constructor() {
    super('hash gate saturated');
    this.name = 'HashGateSaturated';
  }
}

export class HashGate {
  readonly #maxConcurrent: number;
  readonly #maxQueued: number;
  #active = 0;
  readonly #waiters: Array<() => void> = [];

  /**
   * @param maxConcurrent hashes allowed to run at once (each ~32 MiB, so this bounds memory)
   * @param maxQueued hashes allowed to wait; arrivals past this are shed immediately
   */
  constructor(maxConcurrent: number, maxQueued: number) {
    if (maxConcurrent < 1) throw new Error('maxConcurrent must be >= 1');
    if (maxQueued < 0) throw new Error('maxQueued must be >= 0');
    this.#maxConcurrent = maxConcurrent;
    this.#maxQueued = maxQueued;
  }

  /** For tests and telemetry: how many hashes are running and waiting right now. */
  get inFlight(): { active: number; queued: number } {
    return { active: this.#active, queued: this.#waiters.length };
  }

  /**
   * Run `work` under the concurrency bound.
   *
   * Throws `HashGateSaturated` synchronously-in-promise if there is no free slot and the
   * wait queue is full — the point is to reject fast rather than grow the queue. Always
   * releases its slot, on success or failure, so one throwing hash cannot leak capacity.
   */
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#maxConcurrent) {
      if (this.#waiters.length >= this.#maxQueued) throw new HashGateSaturated();
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    this.#active += 1;
    try {
      return await work();
    } finally {
      this.#active -= 1;
      const next = this.#waiters.shift();
      if (next !== undefined) next();
    }
  }
}
