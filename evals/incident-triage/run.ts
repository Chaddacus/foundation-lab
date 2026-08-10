/**
 * Incident Triage — eval runner.
 *
 * Responsibility: run the dataset against the real capability, grade deterministically, and
 * emit a manifest.
 *
 * Place in the system: an eval harness, not application code. It substitutes only the
 * PROVIDER — validation, grounding checks, and fallback all run for real. A suite that
 * mocked the capability would prove nothing about the capability.
 *
 * Two modes:
 *   default            recorded provider, spends nothing, runs on every test invocation
 *   FL_EVAL_PROVIDER=live   the real model, budgeted and counted
 *
 * The default is what keeps `node --test` from drawing subscription capacity — the
 * constraint D1 identifies as having ended a previous session.
 *
 * Usage:
 *   node evals/incident-triage/run.ts
 *   FL_EVAL_PROVIDER=live node evals/incident-triage/run.ts [--fast]
 */

import { buildApp } from '../../src/spine/app.ts';
import { loadConfig } from '../../src/spine/config.ts';
import { ClaudeCliGateway, type AiGateway, type AiRequest, type AiResult } from '../../src/spine/ai-gateway.ts';
import { createHash } from 'node:crypto';
import { PROMPT_VERSION, composeTriagePrompt } from '../../src/modules/triage/prompt.ts';
import { TRIAGE_MODEL } from '../../src/modules/triage/service.ts';
import { CASES, DATASET_VERSION, RECORDED_AGAINST, type EvalCase } from './cases.ts';

export const GRADER_VERSION = 'triage-grader-v1';

/**
 * Hard ceiling on real provider calls in one run.
 *
 * Enforced in code, not by intention. The approved budget is 3 calls at FAST and ~25 at
 * MODULE; this aborts well before an accident becomes expensive.
 */
export const MAX_LIVE_CALLS = 40;

/** The FAST heartbeat: three golden cases, per the approved budget. */
const FAST_CASE_IDS = ['normal-db-outage', 'edge-ambiguous-no-capability', 'structured-code-fence'];

/** FAST live runs use only model-judgement cases, so the heartbeat is exactly three calls. */
const FAST_LIVE_CASE_IDS = ['normal-db-outage', 'normal-minor-cosmetic', 'edge-ambiguous-no-capability'];

/** Serves the recorded response for whichever case is running. Spends nothing. */
class DatasetGateway implements AiGateway {
  readonly provider = 'recorded';
  #current: EvalCase | null = null;

  use(evalCase: EvalCase): void {
    this.#current = evalCase;
  }

  async complete(_request: AiRequest): Promise<AiResult> {
    const recorded = this.#current?.recorded;
    if (recorded === undefined) return { ok: false, reason: 'transport', latencyMs: 0 };
    return recorded.ok
      ? { ok: true, text: recorded.text, latencyMs: 1 }
      : { ok: false, reason: recorded.reason, latencyMs: 1 };
  }
}

/** Wraps the real gateway to count calls and refuse to exceed the ceiling. */
export class BudgetedGateway implements AiGateway {
  readonly provider = 'claude-cli';
  readonly #inner: AiGateway;
  #calls = 0;

  constructor(inner: AiGateway) {
    this.#inner = inner;
  }

  get calls(): number {
    return this.#calls;
  }

  async complete(request: AiRequest): Promise<AiResult> {
    if (this.#calls >= MAX_LIVE_CALLS) {
      throw new Error(
        `Eval budget exhausted: ${MAX_LIVE_CALLS} live provider calls in one run. `
        + 'Refusing to continue rather than spending more subscription capacity.',
      );
    }
    this.#calls += 1;
    return await this.#inner.complete(request);
  }
}

export interface CaseResult {
  readonly id: string;
  readonly category: string;
  readonly passed: boolean;
  readonly detail: string;
  readonly latencyMs: number;
}

/**
 * Grade one outcome against a case's expectations.
 *
 * Deterministic throughout. Severity is graded as a BAND rather than an exact value,
 * because severity is a judgement and a suite that demanded one exact answer would be
 * measuring agreement with the author rather than correctness.
 */
export function grade(evalCase: EvalCase, outcome: { status: string; reason?: string; detail?: string; assessment?: Record<string, unknown> }): { passed: boolean; detail: string } {
  if (outcome.status !== evalCase.expect.status) {
    const why = outcome.reason === undefined ? '' : ` (${outcome.reason}${outcome.detail ? `: ${outcome.detail}` : ''})`;
    return { passed: false, detail: `expected status ${evalCase.expect.status}, got ${outcome.status}${why}` };
  }

  if (evalCase.expect.status === 'unavailable') {
    if (evalCase.expect.reason !== undefined && outcome.reason !== evalCase.expect.reason) {
      return { passed: false, detail: `expected reason ${evalCase.expect.reason}, got ${outcome.reason}` };
    }
    return { passed: true, detail: `refused as ${outcome.reason}` };
  }

  const assessment = outcome.assessment ?? {};
  const severity = String(assessment.severity);
  const capability = String(assessment.affectedCapability);
  const summary = String(assessment.summary ?? '');

  if (evalCase.expect.severityIn !== undefined && !evalCase.expect.severityIn.includes(severity)) {
    return { passed: false, detail: `severity ${severity} outside expected band ${evalCase.expect.severityIn.join('/')}` };
  }
  if (evalCase.expect.capabilityIn !== undefined && !evalCase.expect.capabilityIn.includes(capability)) {
    return { passed: false, detail: `capability ${capability} outside expected set ${evalCase.expect.capabilityIn.join('/')}` };
  }
  for (const required of evalCase.expect.summaryIncludes ?? []) {
    if (!summary.toLowerCase().includes(required.toLowerCase())) {
      return { passed: false, detail: `summary does not address the real incident (missing "${required}")` };
    }
  }

  if (evalCase.expect.maxHypotheses !== undefined) {
    const count = ((assessment.hypotheses ?? []) as unknown[]).length;
    if (count > evalCase.expect.maxHypotheses) {
      return { passed: false, detail: `hypotheses not truncated: ${count} > ${evalCase.expect.maxHypotheses}` };
    }
  }

  const refs = (assessment.evidenceRefs ?? []) as string[];
  for (const required of evalCase.expect.evidenceRefsInclude ?? []) {
    if (!refs.includes(required)) {
      return { passed: false, detail: `did not cite the real evidence "${required}"` };
    }
  }

  return { passed: true, detail: `${severity} / ${capability}` };
}

export interface SuiteReport {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly datasetVersion: string;
  readonly graderVersion: string;
  readonly results: readonly CaseResult[];
  readonly passed: number;
  readonly failed: number;
  readonly liveCalls: number;
  readonly maxLatencyMs: number;
}

/**
 * Fingerprint the prompt TEXT, not its declared version.
 *
 * A version string is a promise a human has to keep. Editing the prompt without bumping it
 * left the gate blind — verified by mutation. Hashing the composed text against a fixed
 * canonical request means ANY change to the prompt fails closed, whether or not anyone
 * remembered to bump the version.
 */
export function promptFingerprint(): string {
  const canonical = composeTriagePrompt({
    incidentId: 'fingerprint',
    title: 'canonical title',
    report: 'canonical report',
    evidence: [{ id: 'e1', text: 'canonical evidence' }],
    moduleNames: ['alpha', 'beta'],
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * Refuse a recorded run whose fixtures no longer match the behavior under test.
 *
 * A recorded provider cannot observe a prompt or model change, so without this the one
 * automated AI gate is blind to the two axes SPEC §7a calls behavioral software changes.
 * Fixtures are bound to the versions they were captured against, and a mismatch stops the
 * run rather than reporting a green result about a prompt that no longer exists.
 */
export function assertFixturesCurrent(): void {
  const fingerprint = promptFingerprint();
  const mismatches: string[] = [];

  if (PROMPT_VERSION !== RECORDED_AGAINST.promptVersion) {
    mismatches.push(`prompt version ${RECORDED_AGAINST.promptVersion} -> ${PROMPT_VERSION}`);
  }
  if (TRIAGE_MODEL !== RECORDED_AGAINST.model) {
    mismatches.push(`model ${RECORDED_AGAINST.model} -> ${TRIAGE_MODEL}`);
  }
  if (fingerprint !== RECORDED_AGAINST.promptFingerprint) {
    mismatches.push(`prompt text ${RECORDED_AGAINST.promptFingerprint} -> ${fingerprint} (edited without a version bump)`);
  }

  if (mismatches.length > 0) {
    throw new Error(
      `Eval fixtures are stale: ${mismatches.join('; ')}. Re-record against a live provider `
      + '(FL_EVAL_PROVIDER=live) and update RECORDED_AGAINST. A recorded run cannot observe a '
      + 'prompt or model change, so continuing would report a green result about behavior '
      + 'nobody evaluated.',
    );
  }
}

/** Run the suite. Exported so a test can assert on it without spawning a process. */
export async function runSuite(options: { live?: boolean; fast?: boolean } = {}): Promise<SuiteReport> {
  // Live runs exercise the real prompt, so they are the way to make fixtures current again.
  if (options.live !== true) assertFixturesCurrent();
  const fastIds = options.live === true ? FAST_LIVE_CASE_IDS : FAST_CASE_IDS;
  let cases = options.fast === true ? CASES.filter((entry) => fastIds.includes(entry.id)) : CASES;

  // Live runs cover only the model-judgement cases. The rest depend on a fabricated
  // provider response, which a real provider cannot be made to emit — running them live
  // would turn real coverage into unearned passes.
  if (options.live === true) cases = cases.filter((entry) => entry.live === true);

  const dataset = new DatasetGateway();
  const budgeted = options.live === true ? new BudgetedGateway(new ClaudeCliGateway()) : null;
  const gateway: AiGateway = budgeted ?? dataset;

  const app = buildApp(
    loadConfig({
      FL_DATABASE_PATH: ':memory:',
      FL_OTLP_ENDPOINT: '',
      FL_SESSION_SECRET: 'eval-secret',
      // The harness is not a user. Throttling it would make the suite silently skip cases
      // rather than evaluate them, which is worse than no suite because it looks green.
      FL_TRIAGE_MAX_CALLS: String(CASES.length * 3),
    }),
    gateway,
  );

  const customer = app.modules.customers.provisioning.provisionCustomer('Eval');
  app.modules.customers.provisioning.provisionUser(customer.id, 'eval@example.test', 'eval-password-value');
  const actor = app.modules.customers.capability.login({ email: 'eval@example.test', password: 'eval-password-value' }).actor;

  const results: CaseResult[] = [];

  for (const evalCase of cases) {
    dataset.use(evalCase);

    const incident = app.modules.incidents.capability.createIncident(actor, {
      title: evalCase.title,
      report: evalCase.report,
      severity: 'SEV-3',
    });

    const outcome = await app.modules.triage.capability.assessIncident(actor, incident.id);
    const graded = options.live === true && evalCase.liveExpect !== undefined
      ? {
          passed: evalCase.liveExpect.statusIn.includes(outcome.status),
          detail: `live: ${outcome.status}`,
        }
      : grade(evalCase, outcome as never);

    results.push({
      id: evalCase.id,
      category: evalCase.category,
      passed: graded.passed,
      detail: graded.detail,
      latencyMs: outcome.meta.latencyMs,
    });
  }

  app.close();

  return {
    provider: gateway.provider,
    model: TRIAGE_MODEL,
    promptVersion: PROMPT_VERSION,
    datasetVersion: DATASET_VERSION,
    graderVersion: GRADER_VERSION,
    results,
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length,
    liveCalls: budgeted?.calls ?? 0,
    maxLatencyMs: Math.max(0, ...results.map((result) => result.latencyMs)),
  };
}

// Executed directly rather than imported: run the suite and exit non-zero on any failure.
if (import.meta.filename === process.argv[1]) {
  const live = process.env.FL_EVAL_PROVIDER === 'live';
  const fast = process.argv.includes('--fast');

  const report = await runSuite({ live, fast });

  for (const result of report.results) {
    console.log(`${result.passed ? 'PASS' : 'FAIL'}  ${result.category.padEnd(18)} ${result.id.padEnd(34)} ${result.detail}`);
  }

  console.log(JSON.stringify({
    ai: {
      provider: report.provider,
      model: report.model,
      prompt_version: report.promptVersion,
      eval_dataset_version: report.datasetVersion,
      grader: 'deterministic',
      grader_version: report.graderVersion,
      toolset_version: 'none-v1',
      thresholds: { pass_rate: 1.0, max_live_calls: MAX_LIVE_CALLS },
      results: { passed: report.passed, failed: report.failed },
      live_provider_calls: report.liveCalls,
      max_latency_ms: report.maxLatencyMs,
    },
  }, null, 2));

  if (report.failed > 0) {
    console.error(`\n${report.failed} eval case(s) failed. The capability is NOT READY.`);
    process.exit(1);
  }
}
