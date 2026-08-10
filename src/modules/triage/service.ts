/**
 * Incident Triage — capability implementation.
 *
 * Responsibility: fetch an incident the caller may see, ask the model once, validate the
 * answer deterministically, and return an outcome that is either fully assessed or
 * explicitly unavailable.
 *
 * Place in the system: internal to the Triage module. It depends on the Incidents
 * CAPABILITY (not its storage), so the tenant rule for incidents keeps one owner, and on
 * the `AiGateway` interface, so no provider detail reaches this file.
 *
 * What this file deliberately does NOT do: mutate an incident, retry a semantically
 * rejected answer, or return anything partial. Deterministic software owns state; the model
 * only proposes.
 */

import { AppError } from '../../spine/errors.ts';
import type { Actor } from '../../spine/actor.ts';
import type { AiGateway } from '../../spine/ai-gateway.ts';
import { RateLimiter, TRIAGE_MAX_CALLS, TRIAGE_WINDOW_MS } from '../../spine/rate-limit.ts';
import type { IncidentsCapability } from '../incidents/contract.ts';
import type {
  TriageCapability,
  TriageEvidence,
  TriageFailureReason,
  TriageOutcome,
  TriageRequest,
} from './contract.ts';
import { PROMPT_VERSION, composeTriagePrompt } from './prompt.ts';
import { validateAssessment } from './validation.ts';

export const TRIAGE_MODEL = 'claude-haiku-4-5-20251001';
export const TRIAGE_TIMEOUT_MS = 60_000;
export const MAX_REPORT_LENGTH = 8000;
export const MAX_EVIDENCE_ITEMS = 20;

/** Supplied by the spine: the capability names that exist, for the grounding check. */
export type ModuleNameSource = () => readonly string[];

/**
 * Records what an attempt did, without recording what it was about.
 *
 * The capability contract promises per-call observability; nothing implemented it, and an
 * `unavailable` outcome was indistinguishable from an accepted one in telemetry. Injected
 * rather than called directly so the module stays free of telemetry detail and so a test
 * can assert exactly which fields are recorded — the risk here is recording too MUCH, since
 * an incident report is user content.
 */
export interface TriageObserver {
  record(event: {
    readonly provider: string;
    readonly model: string;
    readonly promptVersion: string;
    readonly outcome: 'assessed' | 'unavailable';
    readonly reason?: string;
    readonly latencyMs: number;
    readonly attempts: number;
  }): void;
}

const NO_OBSERVER: TriageObserver = { record: () => {} };

export class TriageService implements TriageCapability {
  readonly #incidents: IncidentsCapability;
  readonly #gateway: AiGateway;
  readonly #moduleNames: ModuleNameSource;
  readonly #observer: TriageObserver;
  readonly #limiter: RateLimiter;

  constructor(
    incidents: IncidentsCapability,
    gateway: AiGateway,
    moduleNames: ModuleNameSource,
    observer: TriageObserver = NO_OBSERVER,
    limiter: RateLimiter = new RateLimiter(TRIAGE_MAX_CALLS, TRIAGE_WINDOW_MS),
  ) {
    this.#incidents = incidents;
    this.#gateway = gateway;
    this.#moduleNames = moduleNames;
    this.#observer = observer;
    this.#limiter = limiter;
  }

  /**
   * Assess an incident.
   *
   * The incident lookup is the authorization check: an incident the caller cannot see raises
   * `not_found` before any prompt is composed, so an unauthorized caller cannot even cause a
   * model call — which would otherwise be a way to spend budget without reading anything.
   */
  async assessIncident(actor: Actor, incidentId: string): Promise<TriageOutcome> {
    const incident = this.#incidents.getIncident(actor, incidentId);

    // Bound real spend per actor. Every call costs metered subscription capacity — the
    // application's defining constraint — and without this any authenticated user could
    // spend it in a loop. Checked AFTER authorization so it cannot be used to probe which
    // incidents exist, and BEFORE the prompt so a refused request costs nothing.
    if (!this.#limiter.allow(actor.id)) {
      throw AppError.conflict(
        'Too many analyses have been requested recently. Wait a minute and try again.',
      );
    }
    this.#limiter.record(actor.id);

    const request: TriageRequest = {
      incidentId: incident.id,
      title: incident.title,
      report: incident.report,
      evidence: buildEvidence(incident.report),
      moduleNames: this.#moduleNames(),
    };

    assertRequestWithinLimits(request);

    const prompt = composeTriagePrompt(request);
    let attempts = 0;
    let latencyMs = 0;
    let lastReason: TriageFailureReason = 'provider_unavailable';

    // At most two attempts, and the second only for a TRANSPORT-class failure. A
    // semantically rejected answer is never retried: retrying a validation failure is how a
    // wrong answer eventually slips through by chance.
    while (attempts < 2) {
      attempts += 1;

      const result = await this.#gateway.complete({ prompt, model: TRIAGE_MODEL, timeoutMs: TRIAGE_TIMEOUT_MS });
      latencyMs += result.latencyMs;

      if (!result.ok) {
        lastReason = result.reason === 'timeout' ? 'provider_timeout' : 'provider_unavailable';
        continue;
      }

      const validation = validateAssessment(result.text, request.evidence, request.moduleNames);

      if (validation.ok) {
        return this.#observed({
          status: 'assessed',
          assessment: validation.assessment,
          meta: this.#meta(latencyMs, attempts),
        });
      }

      // Unparseable output can be a truncated stream, so it earns the one retry.
      // Everything else is a considered answer that failed, and stops here.
      if (validation.reason !== 'unparseable_output' || attempts >= 2) {
        return this.#observed({
          status: 'unavailable',
          reason: validation.reason,
          detail: validation.detail,
          meta: this.#meta(latencyMs, attempts),
        });
      }
      lastReason = validation.reason;
    }

    return this.#observed({ status: 'unavailable', reason: lastReason, meta: this.#meta(latencyMs, attempts) });
  }

  /**
   * Record the outcome and return it unchanged.
   *
   * Identifiers and outcome only. The incident report, the prompt, and the response are
   * user content and never travel here — data minimization applies to AI operations like
   * everything else.
   */
  #observed(outcome: TriageOutcome): TriageOutcome {
    this.#observer.record({
      provider: outcome.meta.provider,
      model: outcome.meta.model,
      promptVersion: outcome.meta.promptVersion,
      outcome: outcome.status,
      ...(outcome.status === 'unavailable' ? { reason: outcome.reason } : {}),
      latencyMs: outcome.meta.latencyMs,
      attempts: outcome.meta.attempts,
    });
    return outcome;
  }

  #meta(latencyMs: number, attempts: number) {
    return {
      provider: this.#gateway.provider,
      model: TRIAGE_MODEL,
      promptVersion: PROMPT_VERSION,
      latencyMs,
      attempts,
    };
  }
}

/**
 * Derive citable evidence from the incident report.
 *
 * Slice 3 has no trace or log ingestion, so the evidence is the report's own paragraphs,
 * each given a stable id. That is honest: the grounding check is real, and it operates on
 * real supplied material. When Phase 12 brings live trace and Case context, it becomes
 * another source of `TriageEvidence` and nothing else changes.
 */
function buildEvidence(report: string): readonly TriageEvidence[] {
  return report
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '')
    .slice(0, MAX_EVIDENCE_ITEMS)
    .map((text, index) => ({ id: `e${index + 1}`, text }));
}

/**
 * Refuse an oversized request before it reaches the provider.
 *
 * Input validation runs BEFORE the model (Standard 9). Sending an over-long report would
 * spend budget on a request already known to be out of contract.
 */
function assertRequestWithinLimits(request: TriageRequest): void {
  if (request.report.length > MAX_REPORT_LENGTH) {
    throw AppError.validation(`An incident report may be at most ${MAX_REPORT_LENGTH} characters.`);
  }
  if (request.evidence.length > MAX_EVIDENCE_ITEMS) {
    throw AppError.validation(`At most ${MAX_EVIDENCE_ITEMS} pieces of evidence may be supplied.`);
  }
  if (new Set(request.evidence.map((item) => item.id)).size !== request.evidence.length) {
    throw AppError.validation('Evidence ids must be unique.');
  }
}
