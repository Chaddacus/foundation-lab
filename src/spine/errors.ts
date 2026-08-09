/**
 * Application-wide error contract.
 *
 * Responsibility: define the single error taxonomy that capability modules raise
 * and that the spine's global error boundary maps to transport responses.
 *
 * Place in the system: spine. The spine owns the global error boundary, so it owns
 * the vocabulary that boundary understands. Modules import `AppError` and raise it;
 * they never decide HTTP status codes or MCP error shapes — that is adapter concern.
 *
 * Boundary: this file holds no business logic and no transport detail.
 */

/**
 * Error kinds the boundary knows how to translate.
 *
 * `unauthorized` and `forbidden` are distinct on purpose: the first means the actor is
 * unknown, the second means a known actor lacks authority. Collapsing them hides real
 * authorization defects during the Standard 8 authorization tests.
 */
export type ErrorKind =
  | 'validation'
  | 'not_found'
  | 'conflict'
  | 'unauthorized'
  | 'forbidden'
  | 'dependency'
  | 'internal';

/**
 * An error with a kind the spine can translate, plus optional structured detail.
 *
 * Contract: `message` is safe to show a user — it explains impact and recovery in plain
 * language and MUST NOT carry secrets, credentials, or CONFIDENTIAL data. `details`
 * carries field-level validation results for form display.
 *
 * Invariant: anything thrown that is NOT an AppError is treated as `internal` by the
 * boundary and its message is withheld from the client. This fails closed by default.
 */
export class AppError extends Error {
  readonly kind: ErrorKind;
  readonly details?: Record<string, string>;

  constructor(kind: ErrorKind, message: string, details?: Record<string, string>) {
    super(message);
    this.name = 'AppError';
    this.kind = kind;
    this.details = details;
  }

  static validation(message: string, details?: Record<string, string>): AppError {
    return new AppError('validation', message, details);
  }

  static notFound(message: string): AppError {
    return new AppError('not_found', message);
  }

  static conflict(message: string): AppError {
    return new AppError('conflict', message);
  }

  static forbidden(message: string): AppError {
    return new AppError('forbidden', message);
  }
}

const ERROR_KINDS: ReadonlySet<string> = new Set<ErrorKind>([
  'validation', 'not_found', 'conflict', 'unauthorized', 'forbidden', 'dependency', 'internal',
]);

/**
 * Type guard used by the error boundary.
 *
 * Accepts an `AppError`, or a structurally identical object so the guard still works if two
 * realms ever load this module twice. The structural branch requires BOTH a recognised kind
 * and the `AppError` name: a loose "has a kind property" check would let an unrelated
 * third-party error masquerade as an application error and leak its internal message to a
 * client. This guard is the gate in front of that message, so it fails closed.
 */
export function isAppError(value: unknown): value is AppError {
  if (value instanceof AppError) return true;

  return (
    typeof value === 'object' && value !== null &&
    (value as { name?: unknown }).name === 'AppError' &&
    typeof (value as { message?: unknown }).message === 'string' &&
    ERROR_KINDS.has((value as { kind?: unknown }).kind as string)
  );
}
