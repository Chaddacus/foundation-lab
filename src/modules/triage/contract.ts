/**
 * Incident Triage — public capability contract.
 *
 * Responsibility: define the request and the structured assessment, and the shape of every
 * possible outcome including failure.
 *
 * Place in the system: the public surface of the Triage module. Contract:
 * `docs/ai-capability-incident-triage.md`.
 *
 * The governing rule (Standard 9): an LLM is a probabilistic dependency behind a
 * DETERMINISTIC application contract. Everything here is deterministic. The model's answer
 * is a candidate that must survive validation before it becomes a `TriageAssessment`, and a
 * caller can never receive a partially-filled or unvalidated one.
 */

import type { Actor } from '../../spine/actor.ts';

export type TriageSeverity = 'SEV-0' | 'SEV-1' | 'SEV-2' | 'SEV-3';
export type TriageConfidence = 'high' | 'medium' | 'low';

/** One piece of grounding material. `id` is what an assessment may cite. */
export interface TriageEvidence {
  readonly id: string;
  readonly text: string;
}

export interface TriageRequest {
  readonly incidentId: string;
  readonly title: string;
  readonly report: string;
  readonly evidence: readonly TriageEvidence[];
  /** The capabilities that exist. An assessment naming anything else is rejected. */
  readonly moduleNames: readonly string[];
}

export interface TriageAssessment {
  readonly severity: TriageSeverity;
  /** One of the supplied module names, or the literal `unknown`. Never a fabricated name. */
  readonly affectedCapability: string;
  readonly summary: string;
  readonly hypotheses: readonly string[];
  readonly recommendedNextInvestigation: string;
  /** Ids drawn from the supplied evidence. A citation to anything else is rejected. */
  readonly evidenceRefs: readonly string[];
  readonly confidence: TriageConfidence;
}

/**
 * Why an assessment was not produced.
 *
 * Separated from a generic failure because these are the categories the eval suite must
 * exercise and the interface must explain differently to a person.
 */
export type TriageFailureReason =
  | 'provider_unavailable'
  | 'provider_timeout'
  | 'unparseable_output'
  | 'schema_invalid'
  | 'ungrounded_evidence'
  | 'unknown_capability';

/**
 * The outcome of a triage attempt.
 *
 * A discriminated union, so a caller cannot read an assessment without first checking that
 * one exists. There is deliberately no "partial" case: the capability either produces a
 * fully validated assessment or none at all.
 */
export type TriageOutcome =
  | { readonly status: 'assessed'; readonly assessment: TriageAssessment; readonly meta: TriageMeta }
  | {
      readonly status: 'unavailable';
      readonly reason: TriageFailureReason;
      /**
       * Which rule rejected the answer. INTERNAL diagnostics — it names a field, never its
       * content, and the interface shows the reason rather than this.
       */
      readonly detail?: string;
      readonly meta: TriageMeta;
    };

/** Recorded per attempt. Carries no prompt, report, or response text (data minimization). */
export interface TriageMeta {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly latencyMs: number;
  readonly attempts: number;
}

export interface TriageCapability {
  /**
   * Assess an incident the caller can see.
   *
   * Never mutates the incident. The result is a suggestion; severity and status of record
   * change only through the Incidents capability.
   */
  assessIncident(actor: Actor, incidentId: string): Promise<TriageOutcome>;
}
