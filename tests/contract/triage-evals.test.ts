/**
 * Incident Triage eval suite — executed as part of the normal test run.
 *
 * What this defends: that the eval suite actually runs and passes. "No suite, failing suite,
 * or stale suite = NOT READY" is only enforceable if something fails when the suite does,
 * and a suite that only runs when someone remembers is close to no suite at all.
 *
 * Uses the recorded provider, so this costs no subscription capacity. Live runs stay
 * deliberate: `FL_EVAL_PROVIDER=live node evals/incident-triage/run.ts`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runSuite } from '../../evals/incident-triage/run.ts';
import { CASES } from '../../evals/incident-triage/cases.ts';

describe('the eval suite passes', () => {
  test('every recorded case passes', async () => {
    const report = await runSuite();
    const failures = report.results.filter((result) => !result.passed);
    assert.deepEqual(
      failures.map((failure) => `${failure.id}: ${failure.detail}`),
      [],
      'the capability is NOT READY while any eval case fails',
    );
    assert.equal(report.liveCalls, 0, 'the default run must not call a real provider');
  });
});

describe('the suite covers the categories the standard requires', () => {
  test('every mandatory category has at least one case', () => {
    const present = new Set(CASES.map((entry) => entry.category));
    for (const required of ['normal', 'edge', 'malformed', 'injection', 'grounding', 'structured-output', 'fallback']) {
      assert.ok(present.has(required as never), `no eval case covers "${required}"`);
    }
  });

  test('at least one case is live-eligible, or live runs would prove nothing', () => {
    assert.ok(CASES.some((entry) => entry.live === true));
  });

  test('every case declares what it defends, so a red result explains itself', () => {
    for (const entry of CASES) {
      assert.ok(entry.defends.length > 30, `${entry.id} does not say what it defends`);
    }
  });
});
