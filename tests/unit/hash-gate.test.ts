/**
 * HashGate — the bound that stops a password-hash flood from starving the process.
 *
 * These assertions defend the two properties that make the gate a control and not a comment:
 * it never runs more than its cap at once, and it sheds arrivals past its queue instead of
 * absorbing them. Each was mutation-checked against the implementation.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HashGate, HashGateSaturated } from '../../src/modules/customers/hash-gate.ts';

/** A unit of work that blocks until released, so concurrency is observable rather than timed. */
function gate() {
  const releases: Array<() => void> = [];
  const blockOnce = () => new Promise<void>((resolve) => releases.push(resolve));
  return { releases, blockOnce };
}

describe('HashGate concurrency bound', () => {
  test('never runs more than maxConcurrent at once', async () => {
    const g = new HashGate(3, 100);
    const { releases, blockOnce } = gate();
    let active = 0;
    let peak = 0;

    const runs = Array.from({ length: 12 }, () =>
      g.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await blockOnce();
        active -= 1;
      }),
    );

    // Let everything that can start, start. Only the cap should be running; the rest wait.
    await new Promise((r) => setImmediate(r));
    assert.equal(g.inFlight.active, 3, 'more than the cap started');
    assert.equal(g.inFlight.queued, 9, 'the excess did not queue');

    // Drain: release running units one at a time. Each release frees a slot, a queued unit
    // becomes active and registers its own release, so the list refills until all 12 pass
    // through. Loop until every run has settled rather than until the list is momentarily
    // empty.
    let settled = false;
    void Promise.all(runs).then(() => { settled = true; });
    while (!settled) {
      const release = releases.shift();
      if (release !== undefined) release();
      await new Promise((r) => setImmediate(r));
    }
    await Promise.all(runs);
    assert.equal(peak, 3, `peak concurrency was ${peak}, above the cap of 3`);
  });

  test('sheds arrivals past the queue with HashGateSaturated, rather than absorbing them', async () => {
    const g = new HashGate(1, 2); // 1 running + 2 waiting = 3 tolerated; the 4th is shed

    // One shared latch every admitted unit waits on, released once at the end. A per-unit
    // latch would deadlock the drain: a queued unit only registers its latch after it is
    // admitted, so releasing the latches that exist at one instant is not enough.
    let open = () => {};
    const latch = new Promise<void>((resolve) => { open = resolve; });

    const accepted = [g.run(() => latch), g.run(() => latch), g.run(() => latch)];
    await new Promise((r) => setImmediate(r));

    // Race the 4th arrival against a short timer instead of awaiting its rejection directly.
    // If the gate stops shedding (mutation), the 4th queues and never settles; awaiting it
    // would hang, and a hang is a slow, flaky way to catch a bug. The timer turns "not shed"
    // into a fast, deterministic assertion failure.
    const fourth = g.run(async () => 'ran');
    const outcome = await Promise.race([
      fourth.then(() => 'absorbed', (error) => (error instanceof HashGateSaturated ? 'shed' : 'other')),
      new Promise<string>((resolve) => setTimeout(() => resolve('queued-not-shed'), 50)),
    ]);
    assert.equal(outcome, 'shed', `the 4th arrival was "${outcome}", expected it to be shed`);

    open();
    await Promise.allSettled([...accepted, fourth]);
  });

  test('a throwing unit releases its slot, so one failure cannot leak capacity', async () => {
    const g = new HashGate(1, 0);

    await assert.rejects(() => g.run(async () => { throw new Error('boom'); }));
    // If the slot leaked, this second run would be shed as saturated.
    assert.equal(await g.run(async () => 'ok'), 'ok');
    assert.equal(g.inFlight.active, 0);
  });
});
