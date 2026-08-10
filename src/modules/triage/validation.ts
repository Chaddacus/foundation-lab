/**
 * Incident Triage — post-output validation.
 *
 * Responsibility: decide whether a model's answer may become a `TriageAssessment`.
 *
 * Place in the system: internal to the Triage module, and the most important file in it.
 * **Valid JSON is not semantic correctness** (Standard 9): parsing proves the shape, not
 * that the content is honest. These checks are what make "grounded" mean something —
 * structurally, rather than by trusting the prompt to have been obeyed.
 *
 * Pure and synchronous on purpose, so every rejection case is provable by a direct call
 * without a provider, a clock, or a network.
 */

import type {
  TriageAssessment,
  TriageConfidence,
  TriageEvidence,
  TriageFailureReason,
  TriageSeverity,
} from './contract.ts';

export const SEVERITIES: readonly TriageSeverity[] = ['SEV-0', 'SEV-1', 'SEV-2', 'SEV-3'];
export const CONFIDENCES: readonly TriageConfidence[] = ['high', 'medium', 'low'];
export const SUMMARY_MAX_LENGTH = 600;
/**
 * Upper bound on hypotheses — enforced by TRUNCATION, not rejection.
 *
 * This field is treated differently from every other, deliberately. Live runs showed the
 * model returning 4, then 7, against a stated limit; raising the number each time is
 * chasing a bound the model does not reliably respect.
 *
 * The distinction that matters: extra hypotheses are not WRONG, merely more than the
 * interface wants, so keeping the first few is a presentation decision. Extra evidence
 * references or an out-of-enum severity are different — those are fabrication or a
 * judgement the system does not understand, and they must still reject. Truncating those
 * would silently discard the very signal the check exists to catch.
 */
export const MAX_HYPOTHESES = 6;
/** The one capability name permitted that is not a supplied module. */
export const UNKNOWN_CAPABILITY = 'unknown';

/**
 * Unwrap a markdown code fence.
 *
 * Models wrap JSON in a fence even when told not to — measured against the real CLI, not
 * assumed. This lives with validation rather than in the gateway for two reasons: it is
 * interpretation of a response shape, which is the capability's concern; and a gateway that
 * did it would hide the behavior from the eval suite, which substitutes the gateway.
 */
export function unwrapFencedJson(text: string): string {
  const fenced = text.trim().match(/^```(?:[a-zA-Z]+)?\s*\n?([\s\S]*?)\n?```$/);
  return (fenced === null ? text : fenced[1]).trim();
}

export type ValidationResult =
  | { readonly ok: true; readonly assessment: TriageAssessment }
  | {
      readonly ok: false;
      readonly reason: TriageFailureReason;
      /**
       * Which rule rejected the answer, for diagnostics.
       *
       * INTERNAL ONLY — it names a field, never the content of one, and it is never shown to
       * a user or placed in telemetry. It exists because "schema_invalid" alone made a live
       * eval failure impossible to diagnose without spending more model calls to guess.
       */
      readonly detail: string;
    };

/**
 * Validate raw model output against the contract and the supplied grounding.
 *
 * Rejection reasons are distinguished rather than collapsed, because they mean different
 * things: `schema_invalid` is a malformed answer, while `ungrounded_evidence` and
 * `unknown_capability` are a *confident* answer that invented something. The second kind is
 * the one worth counting, and the eval suite asserts on it specifically.
 */
export function validateAssessment(
  raw: string,
  evidence: readonly TriageEvidence[],
  moduleNames: readonly string[],
): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapFencedJson(raw));
  } catch {
    return { ok: false, reason: 'unparseable_output', detail: 'response is not JSON' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'schema_invalid', detail: 'top level is not an object' };
  }

  const candidate = parsed as Record<string, unknown>;

  const severity = candidate.severity;
  if (typeof severity !== 'string' || !SEVERITIES.includes(severity as TriageSeverity)) {
    return { ok: false, reason: 'schema_invalid', detail: 'severity missing or outside the enum' };
  }

  const confidence = candidate.confidence;
  if (typeof confidence !== 'string' || !CONFIDENCES.includes(confidence as TriageConfidence)) {
    return { ok: false, reason: 'schema_invalid', detail: 'confidence missing or outside the enum' };
  }

  const summary = candidate.summary;
  if (typeof summary !== 'string' || summary.trim() === '') {
    return { ok: false, reason: 'schema_invalid', detail: 'summary missing or empty' };
  }
  if (summary.length > SUMMARY_MAX_LENGTH) {
    return { ok: false, reason: 'schema_invalid', detail: `summary is ${summary.length} chars, limit ${SUMMARY_MAX_LENGTH}` };
  }

  const recommended = candidate.recommendedNextInvestigation;
  if (typeof recommended !== 'string' || recommended.trim() === '') {
    return { ok: false, reason: 'schema_invalid', detail: 'recommendedNextInvestigation missing or empty' };
  }

  const hypotheses = candidate.hypotheses;
  if (
    !Array.isArray(hypotheses)
    || hypotheses.length < 1
    || !hypotheses.every((entry) => typeof entry === 'string' && entry.trim() !== '')
  ) {
    return {
      ok: false,
      reason: 'schema_invalid',
      detail: `hypotheses must be at least one non-empty string, got ${Array.isArray(hypotheses) ? `${hypotheses.length} entries` : typeof hypotheses}`,
    };
  }

  const evidenceRefs = candidate.evidenceRefs;
  if (!Array.isArray(evidenceRefs) || !evidenceRefs.every((entry) => typeof entry === 'string')) {
    return { ok: false, reason: 'schema_invalid', detail: 'evidenceRefs is not an array of strings' };
  }

  const affectedCapability = candidate.affectedCapability;
  if (typeof affectedCapability !== 'string' || affectedCapability.trim() === '') {
    return { ok: false, reason: 'schema_invalid', detail: 'affectedCapability missing or empty' };
  }

  // Grounding, checked structurally. A model that cites evidence it was never given has
  // fabricated it, however plausible the rest of the answer reads.
  const suppliedIds = new Set(evidence.map((item) => item.id));
  if (!evidenceRefs.every((ref) => suppliedIds.has(ref))) {
    return { ok: false, reason: 'ungrounded_evidence', detail: 'cited an evidence id that was not supplied' };
  }

  // A capability name that does not exist is the same class of fabrication, and would send
  // a responder to a module that is not there.
  if (affectedCapability !== UNKNOWN_CAPABILITY && !moduleNames.includes(affectedCapability)) {
    return { ok: false, reason: 'unknown_capability', detail: 'named a capability that does not exist' };
  }

  return {
    ok: true,
    assessment: {
      severity: severity as TriageSeverity,
      affectedCapability,
      summary: summary.trim(),
      // Truncated rather than rejected — see MAX_HYPOTHESES.
      hypotheses: hypotheses.slice(0, MAX_HYPOTHESES).map((entry) => (entry as string).trim()),
      recommendedNextInvestigation: recommended.trim(),
      evidenceRefs: [...evidenceRefs] as string[],
      confidence: confidence as TriageConfidence,
    },
  };
}
