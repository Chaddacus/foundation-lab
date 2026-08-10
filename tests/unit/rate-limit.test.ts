/**
 * Rate limiting — unit tests.
 *
 * What this defends: that password hashing work is bounded per email address, INCLUDING for
 * addresses with no account. Without that bound, an unauthenticated caller could drive
 * unlimited scrypt — ~32 MiB and tens of milliseconds each, on Node's single thread — and
 * measurably degrade every other request.
 *
 * The throttle must behave identically for known and unknown addresses, or it becomes an
 * account-enumeration oracle in the course of fixing a denial-of-service problem.
 *
 * Only FAILURES count. Counting successes would throttle ordinary use — signing in
 * repeatedly with the correct password is not the threat, and an attacker has no correct
 * password. That distinction is asserted below, because getting it wrong locks out real
 * users while barely inconveniencing an attacker.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  RateLimiter,
  THROTTLE_MAX_ATTEMPTS,
  THROTTLE_WINDOW_MS,
  TRIAGE_MAX_CALLS,
  type RateLimitClock,
} from '../../src/spine/rate-limit.ts';

function testClock(): RateLimitClock & { advance: (ms: number) => void } {
  let current = 1_000_000;
  return {
    now: () => current,
    advance: (ms: number) => { current += ms; },
  };
}

describe('RateLimiter', () => {
  test('allows failures up to the limit and refuses beyond it', () => {
    const throttle = new RateLimiter(THROTTLE_MAX_ATTEMPTS, THROTTLE_WINDOW_MS, testClock());

    for (let attempt = 1; attempt <= THROTTLE_MAX_ATTEMPTS; attempt += 1) {
      assert.equal(throttle.allow('ana@acme.test'), true, `attempt ${attempt} was refused`);
      throttle.record('ana@acme.test');
    }
    assert.equal(throttle.allow('ana@acme.test'), false);
  });

  test('successful sign-ins are never throttled, however many there are', () => {
    // The browser proof signs in dozens of times a minute with a correct password. If
    // success counted, legitimate use would be refused while an attacker — who only ever
    // produces failures — would be no worse off.
    const throttle = new RateLimiter(THROTTLE_MAX_ATTEMPTS, THROTTLE_WINDOW_MS, testClock());
    for (let attempt = 0; attempt < THROTTLE_MAX_ATTEMPTS * 10; attempt += 1) {
      assert.equal(throttle.allow('ana@acme.test'), true, `success ${attempt} was throttled`);
    }
  });

  test('treats an unknown address exactly like a known one', () => {
    // The throttle never consults storage, so it cannot distinguish them — which is what
    // stops it from becoming an enumeration oracle.
    const throttle = new RateLimiter(THROTTLE_MAX_ATTEMPTS, THROTTLE_WINDOW_MS, testClock());
    const results = (email: string) => Array.from({ length: THROTTLE_MAX_ATTEMPTS + 2 }, () => {
      const allowed = throttle.allow(email);
      throttle.record(email);
      return allowed;
    });

    assert.deepEqual(results('nobody@nowhere.test'), results('someone@else.test'));
  });

  test('is per address, so one attacker cannot lock out an unrelated user', () => {
    const throttle = new RateLimiter(THROTTLE_MAX_ATTEMPTS, THROTTLE_WINDOW_MS, testClock());
    for (let attempt = 0; attempt <= THROTTLE_MAX_ATTEMPTS; attempt += 1) {
      throttle.record('victim@acme.test');
    }
    assert.equal(throttle.allow('victim@acme.test'), false);
    assert.equal(throttle.allow('bystander@acme.test'), true);
  });

  test('is case- and whitespace-insensitive, so trivial variation does not evade it', () => {
    const throttle = new RateLimiter(THROTTLE_MAX_ATTEMPTS, THROTTLE_WINDOW_MS, testClock());
    for (let attempt = 0; attempt < THROTTLE_MAX_ATTEMPTS; attempt += 1) {
      throttle.record('ana@acme.test');
    }
    assert.equal(throttle.allow('  ANA@ACME.TEST  '), false);
  });

  test('the window reopens, so a legitimate user is not locked out permanently', () => {
    const clock = testClock();
    const throttle = new RateLimiter(THROTTLE_MAX_ATTEMPTS, THROTTLE_WINDOW_MS, clock);

    for (let attempt = 0; attempt <= THROTTLE_MAX_ATTEMPTS; attempt += 1) {
      throttle.record('ana@acme.test');
    }
    assert.equal(throttle.allow('ana@acme.test'), false);

    clock.advance(THROTTLE_WINDOW_MS + 1);
    assert.equal(throttle.allow('ana@acme.test'), true);
  });

  test('does not grow without bound, so it is not its own exhaustion vector', () => {
    const clock = testClock();
    const throttle = new RateLimiter(THROTTLE_MAX_ATTEMPTS, THROTTLE_WINDOW_MS, clock);

    for (let index = 0; index < 500; index += 1) {
      throttle.record(`attacker-${index}@nowhere.test`);
    }
    assert.equal(throttle.trackedKeys, 500, 'setup did not populate the throttle');

    // Opening a new window after everything expired must evict the old entries.
    clock.advance(THROTTLE_WINDOW_MS + 1);
    throttle.record('trigger@eviction.test');

    assert.equal(
      throttle.trackedKeys,
      1,
      'expired entries were retained — the throttle would be its own memory-exhaustion vector',
    );
  });

  test('the triage limit is lower than the login limit, because each unit costs capacity', () => {
    // Login units cost CPU; triage units cost metered subscription capacity. The bounds
    // reflect that difference deliberately rather than sharing one number.
    assert.ok(TRIAGE_MAX_CALLS < THROTTLE_MAX_ATTEMPTS);
  });

  test('a caller may configure its own bound and window', () => {
    const clock = testClock();
    const limiter = new RateLimiter(2, 1000, clock);

    limiter.record('actor-1');
    limiter.record('actor-1');
    assert.equal(limiter.allow('actor-1'), false);

    clock.advance(1001);
    assert.equal(limiter.allow('actor-1'), true);
  });
});
