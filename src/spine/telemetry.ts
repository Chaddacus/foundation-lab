/**
 * OpenTelemetry initialization.
 *
 * Responsibility: start the OTel SDK with the resource identity required by the
 * correlation contract (SPEC §8), and expose the tracer that adapters use to record
 * module-attributed spans.
 *
 * Place in the system: spine. Instrumentation is application-wide wiring. Modules do not
 * configure exporters; they receive a tracer or are traced by their adapter.
 *
 * Boundary: data minimization applies. Spans carry identifiers and outcomes, never
 * request bodies, prompts, or user content.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { trace, type Tracer } from '@opentelemetry/api';
import type { Config } from './config.ts';

/** Custom attribute names. Kept as constants so tests and dashboards cannot drift from the code. */
export const ATTR_DEPLOYMENT_ENVIRONMENT_NAME = 'deployment.environment.name';
export const ATTR_VCS_REF_HEAD_REVISION = 'vcs.ref.head.revision';
export const ATTR_APP_ARTIFACT_DIGEST = 'app.artifact.digest';
/** Set per span by the adapter that owns the call, making module boundaries observable. */
export const ATTR_APP_MODULE = 'app.module';

/**
 * Build the OTel resource for this deployment.
 *
 * Exported separately from `startTelemetry` so a test can assert the correlation contract
 * is complete without starting an exporter or opening a socket.
 */
export function buildResourceAttributes(config: Config): Record<string, string> {
  return {
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion,
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.environment,
    [ATTR_VCS_REF_HEAD_REVISION]: config.vcsRef,
    [ATTR_APP_ARTIFACT_DIGEST]: config.artifactDigest,
  };
}

/**
 * Start the SDK. Returns a shutdown function so the process can flush spans on exit.
 *
 * Side effect: registers global tracing state. Safe to skip entirely — when
 * `config.otlpEndpoint` is empty the application runs uninstrumented rather than
 * failing to boot, because losing telemetry MUST NOT take the service down.
 */
export function startTelemetry(config: Config): () => Promise<void> {
  if (config.otlpEndpoint === '') {
    return async () => {};
  }

  const sdk = new NodeSDK({
    resource: resourceFromAttributes(buildResourceAttributes(config)),
    traceExporter: new OTLPTraceExporter({ url: `${config.otlpEndpoint}/v1/traces` }),
    // Logs are exported too, not only traces. Without this an error log cannot be joined to
    // the release that produced it, which is the first question an incident asks.
    //
    // The processor takes an OPTIONS OBJECT. Passing the exporter positionally is accepted
    // silently, leaves the exporter undefined, and produces a pipeline that exports nothing
    // and throws on shutdown — it fails quietly, so it is asserted in the tests below.
    logRecordProcessors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({ url: `${config.otlpEndpoint}/v1/logs` }),
      }),
    ],
  });

  sdk.start();
  return () => sdk.shutdown();
}

/** The application tracer. One name per deployable, matching the service identity. */
export function getTracer(config: Config): Tracer {
  return trace.getTracer(config.serviceName, config.serviceVersion);
}

/**
 * The all-zero trace id the OTel API returns for a non-recording span.
 *
 * It appears whenever no SDK is registered or nothing is sampled. It is NOT a usable
 * reference, and showing it to a user would send support looking for a trace that does not
 * exist — worse than showing no reference at all.
 */
const INVALID_TRACE_ID = '00000000000000000000000000000000';

/** Return a trace id only when it can actually be looked up; otherwise an empty string. */
export function usableTraceId(traceId: string | undefined): string {
  return traceId === undefined || traceId === INVALID_TRACE_ID ? '' : traceId;
}

/** Current trace id, or an empty string when nothing is sampled. Used as the user-facing error reference. */
export function currentTraceId(): string {
  return usableTraceId(trace.getActiveSpan()?.spanContext().traceId);
}
