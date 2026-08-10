/**
 * Configuration loading and validation.
 *
 * Responsibility: turn process environment into one validated, frozen config object,
 * and fail loudly at startup when required configuration is missing or nonsensical.
 *
 * Place in the system: spine. Configuration is application-wide coordination. Modules
 * receive the values they need through dependency registration; they do not read
 * `process.env` themselves.
 *
 * Boundary: this file resolves NO secret values, and slice 1 needs no secret at all — there
 * is no credential in this configuration yet. When one arrives, the repository will carry a
 * secret *reference* (`rbw://…`, the personal plane per SPEC §7), and validating it will
 * mean checking the reference is present and well formed — never printing or dereferencing
 * it here.
 */

import { randomBytes } from 'node:crypto';
import { AppError } from './errors.ts';
import { TRIAGE_MAX_CALLS } from './rate-limit.ts';

/** Deployment environments this application recognises. Maps to `deployment.environment.name`. */
export type Environment = 'LOCAL' | 'DEV' | 'SANDBOX';

export interface Config {
  readonly environment: Environment;
  readonly port: number;
  /**
   * Interface to listen on. Defaults to loopback.
   *
   * A container must bind `0.0.0.0` or its published port is unreachable — the process would
   * be listening on the container's own loopback. The loopback-only guarantee is preserved
   * one level up: the host publishes to `127.0.0.1` only, so the port is not exposed to the
   * network even though the process inside accepts on all interfaces.
   */
  readonly bindAddress: string;
  /** Filesystem path to the SQLite database owned by this deployment. */
  readonly databasePath: string;
  /** OTel resource identity — see the correlation contract in SPEC §8. */
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly vcsRef: string;
  readonly artifactDigest: string;
  /** OTLP/HTTP collector base endpoint. Empty string disables the exporter. */
  readonly otlpEndpoint: string;
  /**
   * Real AI provider calls allowed per actor per minute.
   *
   * Configurable because the right bound differs by deployment, and because the eval
   * harness legitimately needs a higher one — it is a harness, not a user, and throttling it
   * would make the suite silently skip cases rather than evaluate them.
   */
  readonly triageMaxCalls: number;
  /**
   * HMAC key for session cookies. RESTRICTED — never log it, never return it, never place
   * it in telemetry or an error message.
   */
  readonly sessionSecret: string;
}

const ENVIRONMENTS: readonly Environment[] = ['LOCAL', 'DEV', 'SANDBOX'];

/**
 * Build and validate configuration from an environment map.
 *
 * Takes the environment as a parameter rather than reading `process.env` directly so
 * tests can prove the validation rules without mutating global process state.
 *
 * Throws `AppError('validation')` when a value is present but invalid. Absent values fall
 * back to LOCAL-safe defaults; that is deliberate — a developer clone must start with no
 * setup, while a malformed explicit value must never be silently ignored.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const environment = requireEnum(env.FL_ENV ?? 'LOCAL', ENVIRONMENTS, 'FL_ENV');
  const port = requirePort(env.FL_PORT ?? '4310');

  return Object.freeze({
    environment,
    port,
    bindAddress: env.FL_BIND_ADDRESS ?? '127.0.0.1',
    databasePath: env.FL_DATABASE_PATH ?? `data/foundation-lab.${environment.toLowerCase()}.sqlite`,
    serviceName: env.FL_SERVICE_NAME ?? 'foundation-lab',
    serviceVersion: env.FL_SERVICE_VERSION ?? '0.1.0',
    // Unknown-until-built values are labelled, never faked. A blank release identity in
    // telemetry is a real signal that a build did not stamp it.
    vcsRef: env.FL_VCS_REF ?? 'unknown',
    artifactDigest: env.FL_ARTIFACT_DIGEST ?? 'unbuilt',
    otlpEndpoint: env.FL_OTLP_ENDPOINT ?? 'http://127.0.0.1:4318',
    triageMaxCalls: requirePositiveInteger(env.FL_TRIAGE_MAX_CALLS, TRIAGE_MAX_CALLS, 'FL_TRIAGE_MAX_CALLS'),
    sessionSecret: requireSessionSecret(env.FL_SESSION_SECRET, environment),
  });
}

/**
 * Resolve the session signing key.
 *
 * LOCAL generates an ephemeral random key when none is supplied, so a fresh clone runs with
 * no setup and restarting invalidates sessions — which is correct for local work, and means
 * nobody is tempted to commit a shared literal.
 *
 * Every other environment REFUSES TO START without one. A default signing key is
 * indistinguishable from no signature at all, so this must fail loudly at boot rather than
 * quietly accept forged cookies in DEV or SANDBOX.
 *
 * The value arrives already resolved by the runtime (from an `rbw://` reference per SPEC
 * §7). This function neither resolves references nor unlocks a backend — that stays a
 * human act — and it never echoes the value, including in its error message.
 */
function requireSessionSecret(value: string | undefined, environment: Environment): string {
  if (value !== undefined && value.trim() !== '') return value;

  if (environment === 'LOCAL') {
    return randomBytes(32).toString('base64');
  }

  throw AppError.validation(
    `Configuration FL_SESSION_SECRET is required in ${environment}. ` +
    'Supply it at runtime from the configured secret backend.',
  );
}

function requirePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw AppError.validation(`Configuration ${name} must be a positive integer. Received "${value}".`);
  }
  return parsed;
}

function requireEnum<T extends string>(value: string, allowed: readonly T[], name: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw AppError.validation(
      `Configuration ${name} must be one of ${allowed.join(', ')}. Received "${value}".`,
    );
  }
  return value as T;
}

function requirePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw AppError.validation(`Configuration FL_PORT must be an integer 1-65535. Received "${value}".`);
  }
  return port;
}
