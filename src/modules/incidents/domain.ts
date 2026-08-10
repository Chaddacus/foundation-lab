/**
 * Incidents — domain rules.
 *
 * Responsibility: validate incident input and constrain status transitions.
 *
 * Place in the system: internal to the Incidents module. Pure, so the rules are proven by
 * direct calls rather than by driving a server.
 */

import { AppError } from '../../spine/errors.ts';
import type {
  CreateIncidentInput,
  IncidentSeverity,
  IncidentStatus,
  UpdateIncidentInput,
} from './contract.ts';

export const SEVERITIES: readonly IncidentSeverity[] = ['SEV-0', 'SEV-1', 'SEV-2', 'SEV-3'];
export const STATUSES: readonly IncidentStatus[] = ['open', 'mitigated', 'resolved'];
export const TITLE_MAX_LENGTH = 200;
/** Matches the AI capability's input limit, so an incident can always be triaged. */
export const REPORT_MAX_LENGTH = 8000;

export interface NormalizedIncident {
  readonly title: string;
  readonly report: string;
  readonly severity: IncidentSeverity;
  readonly caseRef: string | null;
  readonly projectId: string | null;
}

export function normalizeCreate(input: CreateIncidentInput): NormalizedIncident {
  const details: Record<string, string> = {};

  const title = text(input?.title);
  if (title === '') {
    details.title = 'Enter a short title for the incident.';
  } else if (title.length > TITLE_MAX_LENGTH) {
    details.title = `Use ${TITLE_MAX_LENGTH} characters or fewer.`;
  }

  const report = text(input?.report);
  if (report === '') {
    details.report = 'Describe what is happening.';
  } else if (report.length > REPORT_MAX_LENGTH) {
    details.report = `Use ${REPORT_MAX_LENGTH} characters or fewer.`;
  }

  const severity = text(input?.severity) as IncidentSeverity;
  if (!SEVERITIES.includes(severity)) {
    details.severity = `Choose one of: ${SEVERITIES.join(', ')}.`;
  }

  if (Object.keys(details).length > 0) {
    throw AppError.validation('That incident could not be saved. Correct the fields below and try again.', details);
  }

  return {
    title,
    report,
    severity,
    // Empty string and absent both mean "no Case yet"; null is the single representation.
    caseRef: emptyToNull(input?.caseRef),
    projectId: emptyToNull(input?.projectId),
  };
}

/**
 * Validate an update, returning only the supplied fields.
 *
 * A resolved incident is closed: reopening is a deliberate act that this slice does not
 * provide, so the transition is refused rather than quietly allowed.
 */
export function normalizeUpdate(
  input: UpdateIncidentInput,
  currentStatus: IncidentStatus,
): Partial<{ severity: IncidentSeverity; status: IncidentStatus; caseRef: string | null }> {
  const details: Record<string, string> = {};
  const changes: { severity?: IncidentSeverity; status?: IncidentStatus; caseRef?: string | null } = {};

  if (input?.severity !== undefined) {
    const severity = text(input.severity) as IncidentSeverity;
    if (!SEVERITIES.includes(severity)) {
      details.severity = `Choose one of: ${SEVERITIES.join(', ')}.`;
    } else {
      changes.severity = severity;
    }
  }

  if (input?.status !== undefined) {
    const status = text(input.status) as IncidentStatus;
    if (!STATUSES.includes(status)) {
      details.status = `Choose one of: ${STATUSES.join(', ')}.`;
    } else if (currentStatus === 'resolved' && status !== 'resolved') {
      throw AppError.conflict('This incident is resolved and cannot be reopened.');
    } else {
      changes.status = status;
    }
  }

  if (input?.caseRef !== undefined) {
    changes.caseRef = emptyToNull(input.caseRef);
  }

  if (Object.keys(details).length > 0) {
    throw AppError.validation('That incident could not be updated. Correct the fields below and try again.', details);
  }
  if (Object.keys(changes).length === 0) {
    throw AppError.validation('Nothing to update. Change the severity, status, or Case reference first.');
  }

  return changes;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function emptyToNull(value: unknown): string | null {
  const trimmed = text(value);
  return trimmed === '' ? null : trimmed;
}
