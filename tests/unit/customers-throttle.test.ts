/**
 * Login throttling — unit tests.
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
  LoginThrottle,
  THROTTLE_MAX_ATTEMPTS,
  THROTTLE_WINDOW_MS,
  type ThrottleClock,
} from '../../src/modules/customers/throttle.ts';

function testClock(): ThrottleClock & { advance: (ms: number) => void } {
  let current = 1_000_000;
  return {
    now: () => current,
    advance: (ms: number) => { current += ms; },
  };
}

describe('LoginThrottle', () => {
  test('allows failures up to the limit and refuses beyond it', () => {
    const throttle = new LoginThrottle(testClock());

    for (let attempt = 1; attempt <= THROTTLE_MAX_ATTEMPTS; attempt += 1) {
      assert.equal(throttle.allow('ana@acme.test'), true, `attempt ${attempt} was refused`);
      throttle.recordFailure('ana@acme.test');
    }
    assert.equal(throttle.allow('ana@acme.test'), false);
  });

  test('successful sign-ins are never throttled, however many there are', () => {
    // The browser proof signs in dozens of times a minute with a correct password. If
    // success counted, legitimate use would be refused while an attacker — who only ever
    // produces failures — would be no worse off.
    const throttle = new LoginThrottle(testClock());
    for (let attempt = 0; attempt < THROTTLE_MAX_ATTEMPTS * 10; attempt += 1) {
      assert.equal(throttle.allow('ana@acme.test'), true, `success ${attempt} was throttled`);
    }
  });

  test('treats an unknown address exactly like a known one', () => {
    // The throttle never consults storage, so it cannot distinguish them — which is what
    // stops it from becoming an enumeration oracle.
    const throttle = new LoginThrottle(testClock());
    const results = (email: string) => Array.from({ length: THROTTLE_MAX_ATTEMPTS + 2 }, () => {
      const allowed = throttle.allow(email);
      throttle.recordFailure(email);
      return allowed;
    });

    assert.deepEqual(results('nobody@nowhere.test'), results('someone@else.test'));
  });

  test('is per address, so one attacker cannot lock out an unrelated user', () => {
    const throttle = new LoginThrottle(testClock());
    for (let attempt = 0; attempt <= THROTTLE_MAX_ATTEMPTS; attempt += 1) {
      throttle.recordFailure('victim@acme.test');
    }
    assert.equal(throttle.allow('victim@acme.test'), false);
    assert.equal(throttle.allow('bystander@acme.test'), true);
  });

  test('is case- and whitespace-insensitive, so trivial variation does not evade it', () => {
    const throttle = new LoginThrottle(testClock());
    for (let attempt = 0; attempt < THROTTLE_MAX_ATTEMPTS; attempt += 1) {
      throttle.recordFailure('ana@acme.test');
    }
    assert.equal(throttle.allow('  ANA@ACME.TEST  '), false);
  });

  test('the window reopens, so a legitimate user is not locked out permanently', () => {
    const clock = testClock();
    const throttle = new LoginThrottle(clock);

    for (let attempt = 0; attempt <= THROTTLE_MAX_ATTEMPTS; attempt += 1) {
      throttle.recordFailure('ana@acme.test');
    }
    assert.equal(throttle.allow('ana@acme.test'), false);

    clock.advance(THROTTLE_WINDOW_MS + 1);
    assert.equal(throttle.allow('ana@acme.test'), true);
  });

  test('does not grow without bound, so it is not its own exhaustion vector', () => {
    const clock = testClock();
    const throttle = new LoginThrottle(clock);

    for (let index = 0; index < 500; index += 1) {
      throttle.recordFailure(`attacker-${index}@nowhere.test`);
    }
    assert.equal(throttle.trackedAddresses, 500, 'setup did not populate the throttle');

    // Opening a new window after everything expired must evict the old entries.
    clock.advance(THROTTLE_WINDOW_MS + 1);
    throttle.recordFailure('trigger@eviction.test');

    assert.equal(
      throttle.trackedAddresses,
      1,
      'expired entries were retained — the throttle would be its own memory-exhaustion vector',
    );
  });
});
