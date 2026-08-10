/**
 * HTTP transport: route table, request context, and the global error boundary.
 *
 * Responsibility: match a request to a module-supplied route, resolve the actor, parse the
 * body, invoke the handler inside a traced span, and translate any failure into an honest
 * response.
 *
 * Place in the system: spine. Routing composition and the global error boundary are
 * application-wide concerns. Modules contribute `Route` values; they never touch
 * `IncomingMessage`, status codes, or the error mapping.
 *
 * Boundary: no business logic. This file must stay ignorant of what a project is.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { SpanStatusCode } from '@opentelemetry/api';
import type { Tracer } from '@opentelemetry/api';
import { AppError, isAppError, type ErrorKind } from './errors.ts';
import type { Actor } from './actor.ts';
import { readCookie, verifySessionCookie, SESSION_COOKIE } from './session.ts';
import type { Config } from './config.ts';

/**
 * Placeholder actor for public routes.
 *
 * Its empty `customerId` matches no tenant, so if it ever reaches a capability that
 * compares customers, every comparison fails and the request is denied. It is inert by
 * construction rather than by the caller remembering to check for it.
 */
const ANONYMOUS: Actor = { id: 'anonymous', customerId: '' };
import { ATTR_APP_MODULE, currentTraceId, usableTraceId } from './telemetry.ts';
import type { Logger } from './logger.ts';

export interface RequestContext {
  readonly actor: Actor;
  readonly params: Readonly<Record<string, string>>;
  readonly body: unknown;
  /** The presented session id, if any. Only sign-out needs it; capabilities do not. */
  readonly sessionId: string | null;
  /** Set a cookie on the response. Used only by login and logout. */
  readonly setCookie: (value: string) => void;
}

export interface Route {
  readonly method: 'GET' | 'POST' | 'PATCH';
  /** Path pattern with `:name` segments, e.g. `/api/projects/:id`. */
  readonly pattern: string;
  /** The owning capability module, recorded on the span as `app.module`. */
  readonly module: string;
  /** Operation name for the span, e.g. `createProject`. */
  readonly operation: string;
  readonly handler: (context: RequestContext) => unknown | Promise<unknown>;
  /** HTTP status on success. Defaults to 200. */
  readonly successStatus?: number;
  /**
   * Reachable without authentication. Defaults to false, so a new route is protected unless
   * it deliberately opts out — forgetting the flag denies access rather than granting it.
   */
  readonly public?: boolean;
}

/** Maps the application error vocabulary onto HTTP. The only place that translation happens. */
const STATUS_BY_KIND: Record<ErrorKind, number> = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  dependency: 503,
  internal: 500,
};

const MAX_BODY_BYTES = 64 * 1024;

/**
 * Build the Node request listener from the composed route table.
 *
 * Every request runs inside one span so a failure is joinable to its trace, and the trace
 * id is returned to the client as `reference` — the id a user can quote when reporting a
 * problem (Standard 10).
 */
export function createRequestListener(
  routes: readonly Route[],
  config: Config,
  tracer: Tracer,
  staticHandler: (req: IncomingMessage, res: ServerResponse) => boolean,
  logger: Logger,
  /** Resolves a verified session id to its actor, or null. Supplied by the Customers module. */
  authenticate: (sessionId: string) => Actor | null,
) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Parsing runs INSIDE the boundary. A malformed request line or Host header makes
    // `new URL` throw, and a malformed percent-escape makes `decodeURIComponent` throw
    // during matching. Both arrive before any authentication, so leaving them outside the
    // boundary turned one unauthenticated GET into a process kill.
    let match: { route: Route; params: Record<string, string> } | null;
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      match = matchRoute(routes, req.method ?? 'GET', url.pathname);
    } catch {
      sendJson(res, 400, {
        error: { kind: 'validation', message: 'That request address is not valid.', reference: '' },
      });
      return;
    }

    if (match === null) {
      try {
        if (staticHandler(req, res)) return;
      } catch {
        // A static handler failure must not escape either; fall through to the 404.
      }
      sendJson(res, 404, { error: { kind: 'not_found', message: 'That page does not exist.', reference: '' } });
      return;
    }

    const { route, params } = match;

    await tracer.startActiveSpan(`${route.module}.${route.operation}`, async (span) => {
      span.setAttribute(ATTR_APP_MODULE, route.module);
      span.setAttribute('http.request.method', route.method);
      span.setAttribute('http.route', route.pattern);

      const cookies: string[] = [];

      try {
        // CSRF control, paired with SameSite=Strict on the session cookie: a cross-site
        // HTML form can only send url-encoded, plain-text, or multipart bodies, so
        // requiring JSON means such a form cannot reach a state-changing route at all.
        if (route.method !== 'GET') {
          const contentType = (req.headers['content-type'] ?? '').split(';')[0].trim();
          if (contentType !== 'application/json') {
            throw AppError.validation('State-changing requests must use Content-Type: application/json.');
          }
        }

        const signed = readCookie(req.headers.cookie, SESSION_COOKIE);
        const sessionId = signed === null ? null : verifySessionCookie(signed, config.sessionSecret);
        const actor = sessionId === null ? null : authenticate(sessionId);

        if (actor === null && route.public !== true) {
          throw new AppError('unauthorized', 'Sign in to continue.');
        }
        if (actor !== null) span.setAttribute('enduser.id', actor.id);

        const body = route.method === 'GET' ? undefined : await readJsonBody(req);
        // Awaited even though slice-1 handlers are synchronous: `Route` is the spine's
        // extension point, and an un-awaited async handler would serialize an empty object
        // on success and let its rejection escape the boundary entirely.
        // A public route may run without an actor. The anonymous placeholder is inert: it
        // has no customer, so any tenant comparison against it fails closed.
        const result = await route.handler({
          actor: actor ?? ANONYMOUS,
          params,
          body,
          sessionId,
          setCookie: (value: string) => cookies.push(value),
        });

        span.setStatus({ code: SpanStatusCode.OK });
        sendJson(res, route.successStatus ?? 200, { data: result }, cookies);
      } catch (error) {
        const { status, payload } = translateError(error, span.spanContext().traceId);
        // Record the outcome on the span, never the request body — data minimization (SPEC §8).
        span.setStatus({ code: SpanStatusCode.ERROR, message: payload.error.kind });
        span.setAttribute('error.type', payload.error.kind);
        if (status >= 500) {
          logger.error(error instanceof Error ? error.message : String(error), {
            module: route.module,
            operation: route.operation,
            error_type: payload.error.kind,
          });
        }
        sendJson(res, status, payload);
      } finally {
        span.end();
      }
    });
  };
}

/**
 * Translate any thrown value into a client-safe response.
 *
 * Fails closed: anything that is not an `AppError` becomes a generic 500 whose message is
 * withheld, because an unexpected error may carry internal detail. The trace id still goes
 * out so the failure stays diagnosable.
 */
export function translateError(error: unknown, traceId: string): {
  status: number;
  payload: { error: { kind: ErrorKind; message: string; details?: Record<string, string>; reference: string } };
} {
  // An unsampled or uninstrumented request has no usable trace. Emit an empty reference so
  // the interface omits it entirely rather than quoting an id nobody can look up.
  const reference = usableTraceId(traceId);

  if (isAppError(error)) {
    const appError = error as AppError;
    return {
      status: STATUS_BY_KIND[appError.kind] ?? 500,
      payload: {
        error: {
          kind: appError.kind,
          message: appError.message,
          ...(appError.details ? { details: appError.details } : {}),
          reference,
        },
      },
    };
  }

  return {
    status: 500,
    payload: {
      error: {
        kind: 'internal',
        message: 'Something went wrong on our side. The problem has been recorded — try again shortly.',
        reference,
      },
    },
  };
}

/** Match a path against the route table, extracting `:name` segments. */
function matchRoute(
  routes: readonly Route[],
  method: string,
  pathname: string,
): { route: Route; params: Record<string, string> } | null {
  const segments = pathname.split('/').filter((segment) => segment !== '');

  for (const route of routes) {
    if (route.method !== method) continue;

    const patternSegments = route.pattern.split('/').filter((segment) => segment !== '');
    if (patternSegments.length !== segments.length) continue;

    const params: Record<string, string> = {};
    let matched = true;

    for (const [index, patternSegment] of patternSegments.entries()) {
      if (patternSegment.startsWith(':')) {
        params[patternSegment.slice(1)] = decodeURIComponent(segments[index]);
      } else if (patternSegment !== segments[index]) {
        matched = false;
        break;
      }
    }

    if (matched) return { route, params };
  }

  return null;
}

/**
 * Read and parse a JSON body.
 *
 * Bounded at `MAX_BODY_BYTES` so an oversized request is refused as it arrives rather than
 * buffered into memory. Malformed JSON is a client error, not a crash.
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw AppError.validation('That request is too large.');
    }
    chunks.push(chunk as Buffer);
  }

  if (size === 0) return undefined;

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw AppError.validation('That request body is not valid JSON.');
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown, cookies: string[] = []): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-trace-id': currentTraceId(),
    // Responses carrying identity must never be cached by a shared cache.
    'cache-control': 'no-store',
    ...(cookies.length > 0 ? { 'set-cookie': cookies } : {}),
  });
  res.end(body);
}
