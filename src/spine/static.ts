/**
 * Static asset serving for the web frontend.
 *
 * Responsibility: serve static files for non-API requests, from a set of mounted roots —
 * the application shell under `src/web`, plus each module's own UI directory.
 *
 * Place in the system: spine. Serving the application shell is bootstrap wiring, not a
 * capability. Feature UI code lives with its module's assets; this file only delivers bytes.
 *
 * Boundary: read-only, and confined to the web root.
 */

import { readFileSync, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/**
 * A URL prefix mapped to a directory on disk.
 *
 * Mounts exist so module-owned UI stays inside the module directory (Standard 10) instead
 * of being pooled into one global web folder. `/modules/projects/` serves
 * `src/modules/projects/ui/`, which keeps the file layout honest about ownership.
 */
export interface StaticMount {
  readonly prefix: string;
  readonly root: string;
}

/**
 * Build a handler that returns true when it served the request.
 *
 * Path traversal is refused by resolving the request against the mount root and rejecting
 * any result that escapes it — an untrusted path MUST NOT be able to read outside the root.
 */
export function createStaticHandler(mounts: readonly StaticMount[]) {
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    if (req.method !== 'GET') return false;

    const requestPath = new URL(req.url ?? '/', 'http://localhost').pathname;
    // Longest prefix wins, so a specific module mount is never shadowed by the root mount.
    const mount = [...mounts]
      .sort((a, b) => b.prefix.length - a.prefix.length)
      .find((candidate) => requestPath.startsWith(candidate.prefix));

    if (mount === undefined) return false;

    const withinMount = requestPath.slice(mount.prefix.length - 1);
    const relative = normalize(withinMount === '/' || withinMount === '' ? '/index.html' : withinMount);

    if (relative.includes('..')) return false;

    const filePath = join(mount.root, relative);
    if (!filePath.startsWith(mount.root)) return false;

    try {
      if (!statSync(filePath).isFile()) return false;
      const body = readFileSync(filePath);
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
        'content-length': body.length,
        // The frontend is same-origin and self-contained; a strict policy here is cheap.
        'content-security-policy': "default-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'",
        'x-content-type-options': 'nosniff',
      });
      res.end(body);
      return true;
    } catch {
      return false;
    }
  };
}
