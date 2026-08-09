/**
 * Structured logging with release correlation.
 *
 * Responsibility: emit log records that carry the same identity as traces, so an error log
 * can be joined to the exact environment, revision, and artifact that produced it.
 *
 * Place in the system: spine. Log identity is application-wide wiring.
 *
 * Why it exists: the first version logged only `module`, `operation`, and `trace_id`. That
 * is enough to find a trace but NOT enough to answer "which release broke this", which is
 * the first question the incident journey asks. SPEC §8 requires the full correlation
 * contract on every signal, not only on spans.
 *
 * Boundary: data minimization applies — identifiers and outcomes only. Request bodies,
 * credentials, and user content MUST NOT be logged.
 */

import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import type { Config } from './config.ts';
import {
  ATTR_APP_MODULE,
  ATTR_APP_ARTIFACT_DIGEST,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_VCS_REF_HEAD_REVISION,
  currentTraceId,
} from './telemetry.ts';

export interface LogFields {
  readonly module: string;
  readonly operation?: string;
  readonly error_type?: string;
  readonly [key: string]: string | number | boolean | undefined;
}

export interface Logger {
  info(message: string, fields: LogFields): void;
  error(message: string, fields: LogFields): void;
}

/**
 * Build the application logger.
 *
 * Writes to stdout/stderr AND to the OTel log pipeline. Both are kept: the console line is
 * what a developer reads locally, and the OTel record is what Elastic correlates. Losing
 * the exporter must never cost the local line.
 */
export function createLogger(config: Config): Logger {
  const identity = {
    'service.name': config.serviceName,
    'service.version': config.serviceVersion,
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.environment,
    [ATTR_VCS_REF_HEAD_REVISION]: config.vcsRef,
    [ATTR_APP_ARTIFACT_DIGEST]: config.artifactDigest,
  };

  const emit = (
    level: 'info' | 'error',
    severityNumber: SeverityNumber,
    message: string,
    fields: LogFields,
  ): void => {
    const traceId = currentTraceId();
    const record = {
      level,
      message,
      ...identity,
      [ATTR_APP_MODULE]: fields.module,
      ...fields,
      // Empty when unsampled, so a reader never chases a trace that does not exist.
      ...(traceId === '' ? {} : { trace_id: traceId }),
    };

    const line = JSON.stringify(record);
    if (level === 'error') console.error(line); else console.log(line);

    logs.getLogger(config.serviceName, config.serviceVersion).emit({
      severityNumber,
      severityText: level.toUpperCase(),
      body: message,
      attributes: record as Record<string, string | number | boolean>,
    });
  };

  return {
    info: (message, fields) => emit('info', SeverityNumber.INFO, message, fields),
    error: (message, fields) => emit('error', SeverityNumber.ERROR, message, fields),
  };
}
