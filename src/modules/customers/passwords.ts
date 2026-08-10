/**
 * Password hashing and verification.
 *
 * Responsibility: turn a password into a storable verifier, and check a candidate against
 * one, without ever exposing either.
 *
 * Place in the system: internal to the Customers module. Nothing outside it calls these.
 *
 * Boundary: no storage, no policy, no logging. In particular this file MUST NOT log, and
 * MUST NOT throw an error whose message contains a password or a verifier — an exception
 * string is one of the easiest ways for a credential to reach a log.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

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
 * Hash a password into a self-describing verifier: `scrypt$N$r$p$salt$hash`.
 *
 * The parameters travel with the verifier so a later cost increase can re-hash on next
 * login without invalidating existing accounts.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const derived = scryptSync(password, salt, KEY_LENGTH, { ...SCRYPT_COST, maxmem: MAX_MEMORY_BYTES });
  const { N, r, p } = SCRYPT_COST;
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/**
 * Verify a candidate password against a stored verifier.
 *
 * Returns false rather than throwing on a malformed verifier: a corrupt row must deny
 * access, not crash the login endpoint into a 500 that reveals it exists.
 *
 * Comparison is `timingSafeEqual`, so response time does not leak how much of the hash
 * matched.
 */
export function verifyPassword(password: string, verifier: string): boolean {
  const parts = verifier.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, n, r, p, saltB64, hashB64] = parts;
  try {
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const derived = scryptSync(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: MAX_MEMORY_BYTES,
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/**
 * A verifier for an account that does not exist.
 *
 * `login` hashes against this when the email is unknown, so an unknown email costs the same
 * time as a wrong password. Without it, login timing enumerates accounts regardless of how
 * carefully the response messages are matched.
 */
export const DUMMY_VERIFIER = hashPassword(randomBytes(32).toString('base64'));
