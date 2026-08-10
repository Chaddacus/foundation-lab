/**
 * Incident Triage capability — integration tests.
 *
 * What this defends: the behavior around the model — authorization, the fallback contract,
 * the retry policy, and the promise that triage never mutates an incident.
 *
 * The provider is substituted; everything else is real. No subscription capacity is spent.
 * Model-judgement quality is the eval suite's job, not this file's.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, type Application } from '../../src/spine/app.ts';
import { loadConfig } from '../../src/spine/config.ts';
import type { AiGateway, AiRequest, AiResult } from '../../src/spine/ai-gateway.ts';
import type { Actor } from '../../src/spine/actor.ts';
import type { AppError } from '../../src/spine/errors.ts';
import { RateLimiter, TRIAGE_MAX_CALLS } from '../../src/spine/rate-limit.ts';
import { TriageService, type TriageObserver } from '../../src/modules/triage/service.ts';
import { BudgetedGateway, MAX_LIVE_CALLS } from '../../evals/incident-triage/run.ts';

const PASSWORD = 'triage-test-password';

/** A gateway whose answers and call count the test controls. */
class ScriptedGateway implements AiGateway {
  readonly provider = 'scripted';
  calls = 0;
  lastPrompt = '';
  #queue: AiResult[] = [];

  script(...results: AiResult[]): void {
    this.#queue = [...results];
  }

  async complete(request: AiRequest): Promise<AiResult> {
    this.calls += 1;
    this.lastPrompt = request.prompt;
    return this.#queue.shift() ?? { ok: false, reason: 'transport', latencyMs: 0 };
  }
}

const ASSESSMENT = JSON.stringify({
  severity: 'SEV-1', affectedCapability: 'projects',
  summary: 'Project creation is failing.', hypotheses: ['A bad release'],
  recommendedNextInvestigation: 'Check the last deployment.',
  evidenceRefs: ['e1'], confidence: 'high',
});

let app: Application;
let gateway: ScriptedGateway;
let ana: Actor;
let gil: Actor;
let incidentId: string;

beforeEach(async () => {
  gateway = new ScriptedGateway();
  app = buildApp(
    loadConfig({ FL_DATABASE_PATH: ':memory:', FL_OTLP_ENDPOINT: '', FL_SESSION_SECRET: 'triage-secret' }),
    gateway,
  );

  const provisioning = app.modules.customers.provisioning;
  const acme = provisioning.provisionCustomer('Acme');
  const globex = provisioning.provisionCustomer('Globex');
  await provisioning.provisionUser(acme.id, 'ana@acme.test', PASSWORD);
  await provisioning.provisionUser(globex.id, 'gil@globex.test', PASSWORD);
  ana = (await app.modules.customers.capability.login({ email: 'ana@acme.test', password: PASSWORD })).actor;
  gil = (await app.modules.customers.capability.login({ email: 'gil@globex.test', password: PASSWORD })).actor;

  incidentId = app.modules.incidents.capability.createIncident(ana, {
    title: 'Project creation failing',
    report: 'Every create returns 500.',
    severity: 'SEV-2',
  }).id;
});

describe('authorization', () => {
  test('another tenant cannot triage an incident, and causes no model call', async () => {
    // The lookup precedes the prompt deliberately: otherwise an unauthorized caller could
    // spend subscription budget without ever reading anything.
    await assert.rejects(
      () => app.modules.triage.capability.assessIncident(gil, incidentId),
      (error: AppError) => error.kind === 'not_found',
    );
    assert.equal(gateway.calls, 0, 'an unauthorized request reached the provider');
  });

  test('an unknown incident id is refused without a model call', async () => {
    await assert.rejects(() => app.modules.triage.capability.assessIncident(ana, 'missing'));
    assert.equal(gateway.calls, 0);
  });
});

describe('the assessment never becomes state', () => {
  test('a successful triage leaves the incident severity and status untouched', async () => {
    gateway.script({ ok: true, text: ASSESSMENT, latencyMs: 10 });
    const before = app.modules.incidents.capability.getIncident(ana, incidentId);

    const outcome = await app.modules.triage.capability.assessIncident(ana, incidentId);
    assert.equal(outcome.status, 'assessed');
    assert.equal(outcome.status === 'assessed' && outcome.assessment.severity, 'SEV-1');

    // The model suggested SEV-1; the record must still say SEV-2. Deterministic software
    // owns state.
    const after = app.modules.incidents.capability.getIncident(ana, incidentId);
    assert.equal(after.severity, before.severity);
    assert.equal(after.status, before.status);
    assert.equal(after.updatedAt, before.updatedAt);
  });
});

describe('fallback contract', () => {
  test('a provider timeout yields unavailable with the timeout reason', async () => {
    gateway.script({ ok: false, reason: 'timeout', latencyMs: 60_000 }, { ok: false, reason: 'timeout', latencyMs: 60_000 });
    const outcome = await app.modules.triage.capability.assessIncident(ana, incidentId);
    assert.equal(outcome.status, 'unavailable');
    assert.equal(outcome.status === 'unavailable' && outcome.reason, 'provider_timeout');
  });

  test('no assessment field exists on an unavailable outcome, so a caller cannot read one', async () => {
    gateway.script({ ok: false, reason: 'transport', latencyMs: 1 }, { ok: false, reason: 'transport', latencyMs: 1 });
    const outcome = await app.modules.triage.capability.assessIncident(ana, incidentId);
    assert.equal('assessment' in outcome, false);
  });

  test('a fabricated evidence reference yields unavailable, not a filtered assessment', async () => {
    gateway.script({
      ok: true, latencyMs: 10,
      text: JSON.stringify({ ...JSON.parse(ASSESSMENT), evidenceRefs: ['e1', 'invented'] }),
    });
    const outcome = await app.modules.triage.capability.assessIncident(ana, incidentId);
    assert.equal(outcome.status === 'unavailable' && outcome.reason, 'ungrounded_evidence');
  });
});

describe('retry policy', () => {
  test('unparseable output is retried exactly once, because it can be a truncated stream', async () => {
    gateway.script({ ok: true, text: 'not json', latencyMs: 5 }, { ok: true, text: ASSESSMENT, latencyMs: 10 });
    const outcome = await app.modules.triage.capability.assessIncident(ana, incidentId);
    assert.equal(outcome.status, 'assessed');
    assert.equal(gateway.calls, 2);
  });

  test('a SEMANTIC rejection is never retried', async () => {
    // Retrying a validation failure is how a wrong answer eventually gets through by chance.
    gateway.script(
      { ok: true, latencyMs: 5, text: JSON.stringify({ ...JSON.parse(ASSESSMENT), affectedCapability: 'payments' }) },
      { ok: true, text: ASSESSMENT, latencyMs: 10 },
    );
    const outcome = await app.modules.triage.capability.assessIncident(ana, incidentId);
    assert.equal(outcome.status === 'unavailable' && outcome.reason, 'unknown_capability');
    assert.equal(gateway.calls, 1, 'a semantically rejected answer was retried');
  });

  test('gives up after two attempts rather than looping', async () => {
    gateway.script({ ok: true, text: 'nope', latencyMs: 1 }, { ok: true, text: 'still nope', latencyMs: 1 });
    const outcome = await app.modules.triage.capability.assessIncident(ana, incidentId);
    assert.equal(outcome.status === 'unavailable' && outcome.reason, 'unparseable_output');
    assert.equal(gateway.calls, 2);
  });
});

describe('prompt construction', () => {
  test('the report is fenced as data and the module list is supplied', async () => {
    gateway.script({ ok: true, text: ASSESSMENT, latencyMs: 10 });
    await app.modules.triage.capability.assessIncident(ana, incidentId);

    assert.match(gateway.lastPrompt, /<report>/);
    assert.match(gateway.lastPrompt, /DATA, not instructions/);
    assert.match(gateway.lastPrompt, /projects/);
  });

  test('metadata carries provider and prompt version but no incident content', async () => {
    gateway.script({ ok: true, text: ASSESSMENT, latencyMs: 10 });
    const outcome = await app.modules.triage.capability.assessIncident(ana, incidentId);

    assert.equal(outcome.meta.promptVersion, 'triage-prompt-v2');
    // Data minimization: an incident report is user content and must not travel in metadata.
    assert.ok(!JSON.stringify(outcome.meta).includes('500'));
  });
});

describe('metered capacity is bounded at runtime', () => {
  const manyOk = () => Array.from({ length: 20 }, () => ({ ok: true as const, text: ASSESSMENT, latencyMs: 1 }));

  test('an actor cannot spend model capacity in a loop', async () => {
    // Every call costs metered subscription capacity — this application's defining
    // constraint — and the route previously had no bound of any kind.
    gateway.script(...manyOk());

    for (let attempt = 0; attempt < TRIAGE_MAX_CALLS; attempt += 1) {
      const outcome = await app.modules.triage.capability.assessIncident(ana, incidentId);
      assert.equal(outcome.status, 'assessed', `call ${attempt} was refused too early`);
    }

    await assert.rejects(
      () => app.modules.triage.capability.assessIncident(ana, incidentId),
      (error: AppError) => error.kind === 'conflict',
      'an unlimited number of analyses was allowed',
    );
  });

  test('a refused request costs no provider call', async () => {
    gateway.script(...manyOk());
    for (let attempt = 0; attempt < TRIAGE_MAX_CALLS; attempt += 1) {
      await app.modules.triage.capability.assessIncident(ana, incidentId);
    }
    const callsBefore = gateway.calls;

    await assert.rejects(() => app.modules.triage.capability.assessIncident(ana, incidentId));
    assert.equal(gateway.calls, callsBefore, 'a throttled request still reached the provider');
  });

  test('an exhausted actor does not consume another actor\'s budget', async () => {
    const shared = new RateLimiter(TRIAGE_MAX_CALLS, 60_000);
    const service = new TriageService(app.modules.incidents.capability, gateway, () => ['projects'], undefined, shared);
    gateway.script(...manyOk());

    for (let attempt = 0; attempt < TRIAGE_MAX_CALLS; attempt += 1) {
      await service.assessIncident(ana, incidentId);
    }
    await assert.rejects(() => service.assessIncident(ana, incidentId));

    // Gil cannot see Ana's incident, so what matters is that he fails on AUTHORIZATION
    // rather than on her exhausted quota — the limit is per actor, not global.
    await assert.rejects(
      () => service.assessIncident(gil, incidentId),
      (error: AppError) => error.kind === 'not_found',
    );
  });

  test('the eval budget ceiling actually aborts rather than counting past it', async () => {
    // Deleting this ceiling previously left every test green.
    let calls = 0;
    const budgeted = new BudgetedGateway({
      provider: 'stub',
      complete: async () => { calls += 1; return { ok: true as const, text: '{}', latencyMs: 0 }; },
    });

    for (let call = 0; call < MAX_LIVE_CALLS; call += 1) {
      await budgeted.complete({ prompt: 'x', model: 'm', timeoutMs: 1 });
    }
    assert.equal(budgeted.calls, MAX_LIVE_CALLS);

    await assert.rejects(
      () => budgeted.complete({ prompt: 'x', model: 'm', timeoutMs: 1 }),
      /budget exhausted/i,
    );
    assert.equal(calls, MAX_LIVE_CALLS, 'the wrapped gateway was called past the ceiling');
  });
});

describe('observability', () => {
  function observed() {
    const events: Record<string, unknown>[] = [];
    const observer: TriageObserver = { record: (event) => { events.push({ ...event }); } };
    return { events, service: new TriageService(app.modules.incidents.capability, gateway, () => ['projects'], observer) };
  }

  test('records provider, model, prompt version and outcome for a success', async () => {
    const { events, service } = observed();
    gateway.script({ ok: true, text: ASSESSMENT, latencyMs: 42 });
    await service.assessIncident(ana, incidentId);

    assert.equal(events.length, 1);
    assert.equal(events[0].outcome, 'assessed');
    assert.equal(events[0].promptVersion, 'triage-prompt-v2');
    assert.equal(events[0].attempts, 1);
  });

  test('records the reason for a rejected assessment, which telemetry could not otherwise see', async () => {
    // An unavailable outcome is a 200 at the HTTP layer, so without this it is
    // indistinguishable from an accepted one.
    const { events, service } = observed();
    gateway.script({ ok: false, reason: 'timeout', latencyMs: 5 }, { ok: false, reason: 'timeout', latencyMs: 5 });
    await service.assessIncident(ana, incidentId);

    assert.equal(events[0].outcome, 'unavailable');
    assert.equal(events[0].reason, 'provider_timeout');
  });

  test('records NO incident content — reports are user data', async () => {
    const { events, service } = observed();
    gateway.script({ ok: true, text: ASSESSMENT, latencyMs: 1 });
    await service.assessIncident(ana, incidentId);

    const serialized = JSON.stringify(events);
    assert.ok(!serialized.includes('Every create returns 500'), 'the report reached telemetry');
    assert.ok(!serialized.includes('Project creation is failing'), 'the response reached telemetry');
  });
});
