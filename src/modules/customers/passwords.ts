/**
 * Password hashing and verification.
 *
 * Responsibility: turn a password into a storable verifier, and check a candidate against
 * one, without ever exposing either — and without one caller's hashing being able to starve
 * the process.
 *
 * Place in the system: internal to the Customers module. Nothing outside it calls these.
 *
 * Boundary: no storage, no auth policy (lockout, throttling), no logging. In particular this
 * file MUST NOT log, and MUST NOT throw an error whose message contains a password or a
 * verifier — an exception string is one of the easiest ways for a credential to reach a log.
 *
 * Concurrency: hashing is asynchronous (libuv thread pool) so it does not block the main
 * thread, and it runs under a global `HashGate` so a flood cannot exhaust memory or the pool.
 * Both are safety properties of the primitive itself, which is why they live here and not in
 * the caller — every path that hashes gets them. Realised in Phase 12 after a login flood of
 * distinct addresses starved authenticated reads; see hash-gate.ts.
 */

import { randomBytes, scrypt as scryptCallback, scryptSync, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { HashGate } from './hash-gate.ts';

/**
 * Promisified scrypt WITH the options overload.
 *
 * `promisify(scrypt)` resolves to the no-options overload, so a call passing cost parameters
 * fails to type-check. Wrapped explicitly rather than cast at each call site, so the types
 * are honest at one place instead of suppressed at several.
 */
function scrypt(password: string | Buffer, salt: string | Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

/**
 * scrypt cost. N=2^15 with r=8 is a standard interactive-login setting.
 *
 * Deliberately a constant rather than configuration: a deployment that could lower the cost
 * is a deployment that can silently weaken every password in the database.
 */
const SCRYPT_COST = { N: 32768, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/**
 * Memory ceiling for scrypt.
 *
 * scrypt needs roughly `128 * N * r` bytes — 32 MiB at the cost above, which is exactly
 * Node's default limit, so the default rejects our own parameters. Set explicitly with
 * headroom.
 *
 * It also bounds verification: the parameters in a stored verifier drive the work, so an
 * absurd `N` in a corrupt or hostile row would otherwise let one login attempt exhaust
 * memory. Exceeding this throws, and `verifyPassword` turns that into a denial.
 */
const MAX_MEMORY_BYTES = 96 * 1024 * 1024;

/**
 * The process-wide hashing bound.
 *
 * Eight concurrent hashes ≈ 256 MiB in flight, comfortable for the container; a wait queue
 * of 32 absorbs a normal burst while shedding a flood fast. Each running hash holds ~32 MiB,
 * so `maxConcurrent` is the real memory lever. Exported so the service can read its depth
 * for telemetry and a test can drive it to saturation.
 */
export const hashGate = new HashGate(8, 32);

/**
 * Hash a password into a self-describing verifier: `scrypt$N$r$p$salt$hash`.
 *
 * The parameters travel with the verifier so a later cost increase can re-hash on next
 * login without invalidating existing accounts.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await hashGate.run(() =>
    scrypt(password, salt, KEY_LENGTH, { ...SCRYPT_COST, maxmem: MAX_MEMORY_BYTES }),
  );
  const { N, r, p } = SCRYPT_COST;
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/**
 * Verify a candidate password against a stored verifier.
 *
 * Returns false rather than throwing on a malformed verifier: a corrupt row must deny
 * access, not crash the login endpoint into a 500 that reveals it exists. A gate rejection
 * is NOT swallowed here — it is a different condition (the service is shedding load, not the
 * password being wrong) and the caller must be able to tell them apart, so it propagates.
 *
 * Comparison is `timingSafeEqual`, so response time does not leak how much of the hash
 * matched.
 */
export async function verifyPassword(password: string, verifier: string): Promise<boolean> {
  const parts = verifier.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, n, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');

  let derived: Buffer;
  try {
    derived = await hashGate.run(() =>
      scrypt(password, salt, expected.length, {
        N: Number(n),
        r: Number(r),
        p: Number(p),
        maxmem: MAX_MEMORY_BYTES,
      }),
    );
  } catch (error) {
    // A saturated gate is load-shedding, not a bad password — surface it. A crypto failure
    // (e.g. an absurd N in a corrupt row) is a denial, as before.
    if (error instanceof Error && error.name === 'HashGateSaturated') throw error;
    return false;
  }

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * A verifier for an account that does not exist.
 *
 * `login` verifies against this when the email is unknown, so an unknown email costs the
 * same as a wrong password. Generated once at module load with the synchronous primitive —
 * a single startup hash, off the request path — so it needs no top-level await and does not
 * consume a gate slot during normal operation.
 */
function dummyVerifier(): string {
  const salt = randomBytes(SALT_LENGTH);
  const derived = scryptSync(randomBytes(32), salt, KEY_LENGTH, { ...SCRYPT_COST, maxmem: MAX_MEMORY_BYTES });
  const { N, r, p } = SCRYPT_COST;
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export const DUMMY_VERIFIER = dummyVerifier();
