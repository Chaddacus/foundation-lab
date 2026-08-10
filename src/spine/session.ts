/**
 * Session cookie transport.
 *
 * Responsibility: carry a session id between the browser and the application — parse it in,
 * sign it, verify the signature, and serialize the `Set-Cookie` header.
 *
 * Place in the system: spine. Cookies are transport, not business. The Customers module
 * decides whether a session id is valid; this file only decides whether the cookie was
 * tampered with in transit.
 *
 * Boundary: no database access, no session lifetime policy. A signature that verifies means
 * "this application issued this string", nothing more — the session may still be expired or
 * revoked, which only the module can know.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.ts';

export const SESSION_COOKIE = 'foundation_lab_session';

/**
 * Sign a session id.
 *
 * The cookie value is `<id>.<signature>`. Signing does not hide the id — it prevents a
 * client from inventing one, so a forged cookie is rejected before any database lookup and
 * cannot be used to probe for valid ids.
 */
export function signSessionId(sessionId: string, secret: string): string {
  const signature = createHmac('sha256', secret).update(sessionId).digest('base64url');
  return `${sessionId}.${signature}`;
}

/**
 * Verify a signed cookie value and return the session id, or null.
 *
 * Comparison is `timingSafeEqual` on equal-length buffers. Any malformed shape returns null
 * rather than throwing: a malformed cookie is an unauthenticated request, not a server error.
 */
export function verifySessionCookie(value: string, secret: string): string | null {
  const separator = value.lastIndexOf('.');
  if (separator <= 0) return null;

  const sessionId = value.slice(0, separator);
  const presented = Buffer.from(value.slice(separator + 1));
  const expected = Buffer.from(createHmac('sha256', secret).update(sessionId).digest('base64url'));

  if (presented.length !== expected.length) return null;
  return timingSafeEqual(presented, expected) ? sessionId : null;
}

/**
 * Read one cookie from a `Cookie` header. Returns null when absent or malformed.
 *
 * Decoding is TOTAL. `decodeURIComponent` throws on a malformed escape, and the cookie
 * header is entirely attacker-controlled: an unguarded call turned `Cookie: …=%` into a 500
 * plus an ERROR log on every endpoint, including public ones, so an unauthenticated caller
 * could drive the error rate at will. A malformed cookie is an unauthenticated request, not
 * a server fault.
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      const raw = part.slice(separator + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Build the `Set-Cookie` header for a new session.
 *
 * `HttpOnly` keeps it away from scripts. `SameSite=Strict` is the CSRF control — a
 * cross-site request carries no session at all. `Secure` is set everywhere EXCEPT LOCAL,
 * because LOCAL is plain HTTP on loopback and a `Secure` cookie there would be dropped
 * silently, breaking login in a way that looks like a password problem.
 */
export function buildSessionCookie(signedValue: string, expiresAt: string, config: Config): string {
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(signedValue)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  if (config.environment !== 'LOCAL') attributes.push('Secure');
  return attributes.join('; ');
}

/** Build the header that clears the cookie on sign-out. */
export function buildClearedSessionCookie(config: Config): string {
  const attributes = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (config.environment !== 'LOCAL') attributes.push('Secure');
  return attributes.join('; ');
}
