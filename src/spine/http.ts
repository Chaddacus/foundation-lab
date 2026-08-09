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
import { resolveActor, type Actor } from './actor.ts';
import type { Config } from './config.ts';
import { ATTR_APP_MODULE, currentTraceId, usableTraceId } from './telemetry.ts';

export interface RequestContext {
  readonly actor: Actor;
  readonly params: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface Route {
  readonly method: 'GET' | 'POST' | 'PATCH';
  /** Path pattern with `:name` segments, e.g. `/api/projects/:id`. */
  readonly pattern: string;
  /** The owning capability module, recorded on the span as `app.module`. */
  readonly module: string;
  /** Operation name for the span, e.g. `createProject`. */
  readonly operation: string;
  readonly handler: (context: RequestContext) => unknown;
  /** HTTP status on success. Defaults to 200. */
  readonly successStatus?: number;
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
) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const match = matchRoute(routes, req.method ?? 'GET', url.pathname);

    if (match === null) {
      if (staticHandler(req, res)) return;
      sendJson(res, 404, { error: { kind: 'not_found', message: 'That page does not exist.', reference: '' } });
      return;
    }

    const { route, params } = match;

    await tracer.startActiveSpan(`${route.module}.${route.operation}`, async (span) => {
      span.setAttribute(ATTR_APP_MODULE, route.module);
      span.setAttribute('http.request.method', route.method);
      span.setAttribute('http.route', route.pattern);

      try {
        const actor = resolveActor(req.headers, config);
        span.setAttribute('enduser.id', actor.id);

        const body = route.method === 'GET' ? undefined : await readJsonBody(req);
        const result = route.handler({ actor, params, body });

        span.setStatus({ code: SpanStatusCode.OK });
        sendJson(res, route.successStatus ?? 200, { data: result });
      } catch (error) {
        const { status, payload } = translateError(error, span.spanContext().traceId);
        // Record the outcome on the span, never the request body — data minimization (SPEC §8).
        span.setStatus({ code: SpanStatusCode.ERROR, message: payload.error.kind });
        span.setAttribute('error.type', payload.error.kind);
        if (status >= 500) {
          console.error(JSON.stringify({
            level: 'error',
            module: route.module,
            operation: route.operation,
            trace_id: span.spanContext().traceId,
            message: error instanceof Error ? error.message : String(error),
          }));
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

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-trace-id': currentTraceId(),
  });
  res.end(body);
}
