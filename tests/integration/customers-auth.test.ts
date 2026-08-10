/**
 * Authentication lifecycle — integration tests.
 *
 * What this defends: the properties of `login`, session validity, and lockout that only
 * real storage and a controllable clock can show. Password hashing itself is proven in
 * `tests/unit/customers-passwords.test.ts`; this file does not re-assert it.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from '../../src/spine/database.ts';
import { CustomersRepository, migration } from '../../src/modules/customers/repository.ts';
import {
  CustomersService,
  LOCKOUT_MS,
  MAX_FAILED_ATTEMPTS,
  SESSION_TTL_MS,
  type AuthClock,
} from '../../src/modules/customers/service.ts';
import {
  RateLimiter,
  THROTTLE_MAX_ATTEMPTS,
  THROTTLE_WINDOW_MS,
  type RateLimitClock,
} from '../../src/spine/rate-limit.ts';
import type { AppError } from '../../src/spine/errors.ts';

const PASSWORD = 'correct-horse-battery-staple';

/** Controllable clock: session expiry and lockout are time-dependent by nature. */
function testClock(): AuthClock & { advance: (ms: number) => void } {
  let current = new Date('2026-08-09T10:00:00.000Z');
  let counter = 0;
  return {
    now: () => current,
    newId: () => `id-${++counter}`,
    newSessionId: () => `session-${++counter}`,
    advance: (ms: number) => { current = new Date(current.getTime() + ms); },
  };
}

/** Separate clock for the throttle, whose window is measured in milliseconds since epoch. */
function throttleTestClock(): RateLimitClock & { advance: (ms: number) => void } {
  let current = 1_000_000;
  return { now: () => current, advance: (ms: number) => { current += ms; } };
}

let clock: ReturnType<typeof testClock>;
let throttleClock: ReturnType<typeof throttleTestClock>;
let repository: CustomersRepository;
let service: CustomersService;
let customerId: string;

/** Build a service sharing the seeded database, with an injectable throttle. */
function buildService(throttle: RateLimiter): CustomersService {
  return new CustomersService(repository, clock, throttle);
}

beforeEach(async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyMigrations(db, [migration]);
  clock = testClock();
  throttleClock = throttleTestClock();
  repository = new CustomersRepository(db);
  service = new CustomersService(repository, clock);

  customerId = service.provisionCustomer('Acme').id;
  await service.provisionUser(customerId, 'ana@acme.test', PASSWORD);
});

async function loginKind(email: string, password: string): Promise<string> {
  try {
    await service.login({ email, password });
    return 'SUCCESS';
  } catch (error) {
    return (error as AppError).kind;
  }
}

describe('login', () => {
  test('a correct credential yields a session bound to the user\'s customer', async () => {
    const grant = await service.login({ email: 'ana@acme.test', password: PASSWORD });
    assert.equal(grant.actor.customerId, customerId);
    assert.ok(grant.sessionId.length > 0);
    assert.equal(grant.expiresAt, new Date(clock.now().getTime() + SESSION_TTL_MS).toISOString());
  });

  test('email matching is case-insensitive, because email case is not identity', async () => {
    assert.equal(await loginKind('ANA@ACME.TEST', PASSWORD), 'SUCCESS');
  });

  test('a wrong password is refused', async () => {
    assert.equal(await loginKind('ana@acme.test', 'wrong'), 'unauthorized');
  });

  test('an unknown email, a wrong password, and empty input give the same error', async () => {
    const messages = new Set<string>();
    for (const [email, password] of [['nobody@nowhere.test', 'x'], ['ana@acme.test', 'wrong'], ['', '']]) {
      try {
        await service.login({ email, password });
        assert.fail('expected refusal');
      } catch (error) {
        messages.add((error as AppError).message);
      }
    }
    assert.equal(messages.size, 1, `login messages differ and leak account existence: ${[...messages].join(' | ')}`);
  });

  test('each login yields a distinct session id', async () => {
    const first = (await service.login({ email: 'ana@acme.test', password: PASSWORD })).sessionId;
    const second = (await service.login({ email: 'ana@acme.test', password: PASSWORD })).sessionId;
    assert.notEqual(first, second);
  });

  test('signing in again does not invalidate an existing session on another device', async () => {
    const first = await service.login({ email: 'ana@acme.test', password: PASSWORD });
    await service.login({ email: 'ana@acme.test', password: PASSWORD });
    assert.notEqual(service.resolveSession(first.sessionId), null, 'the first device was signed out');
  });
});

describe('login consults the throttle', () => {
  // The gap this closes: the throttle had thorough unit tests, but nothing asserted that
  // `login` actually calls it. Deleting the check from `login` passed the whole suite —
  // the DoS bound existed as a class nobody used.

  test('a throttled address is refused even with the correct password', async () => {
    const throttle = new RateLimiter(THROTTLE_MAX_ATTEMPTS, THROTTLE_WINDOW_MS, throttleClock);
    const service = buildService(throttle);

    for (let attempt = 0; attempt < THROTTLE_MAX_ATTEMPTS; attempt += 1) {
      throttle.record('ana@acme.test');
    }

    // The correct password would otherwise succeed, so refusal can only come from the
    // throttle being consulted.
    await assert.rejects(
      () => service.login({ email: 'ana@acme.test', password: PASSWORD }),
      (error: AppError) => error.kind === 'unauthorized',
    );
  });

  test('the same address succeeds once the window reopens', async () => {
    const throttle = new RateLimiter(THROTTLE_MAX_ATTEMPTS, THROTTLE_WINDOW_MS, throttleClock);
    const service = buildService(throttle);

    for (let attempt = 0; attempt < THROTTLE_MAX_ATTEMPTS; attempt += 1) {
      throttle.record('ana@acme.test');
    }
    throttleClock.advance(THROTTLE_WINDOW_MS + 1);

    assert.ok((await service.login({ email: 'ana@acme.test', password: PASSWORD })).sessionId);
  });

  test('failed logins feed the throttle, including for addresses with no account', async () => {
    const throttle = new RateLimiter(THROTTLE_MAX_ATTEMPTS, THROTTLE_WINDOW_MS, throttleClock);
    const service = buildService(throttle);

    for (let attempt = 0; attempt < THROTTLE_MAX_ATTEMPTS; attempt += 1) {
      try { await service.login({ email: 'ghost@nowhere.test', password: 'wrong' }); } catch { /* expected */ }
    }

    // An address with no user row can still be throttled — the per-user lockout could not
    // do this, which is why unknown addresses could previously drive unlimited hashing.
    assert.equal(throttle.allow('ghost@nowhere.test'), false);
  });
});

describe('lockout', () => {
  test('the account locks after the configured number of failures', async () => {
    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      assert.equal(await loginKind('ana@acme.test', 'wrong'), 'unauthorized');
    }
    // The correct password is now refused too — that is what locked means.
    assert.equal(await loginKind('ana@acme.test', PASSWORD), 'unauthorized');
  });

  test('the lock expires and the correct password works again', async () => {
    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await loginKind('ana@acme.test', 'wrong');
    }
    assert.equal(await loginKind('ana@acme.test', PASSWORD), 'unauthorized');

    clock.advance(LOCKOUT_MS + 1000);
    assert.equal(await loginKind('ana@acme.test', PASSWORD), 'SUCCESS');
  });

  test('a successful login before the limit clears the failure count', async () => {
    await loginKind('ana@acme.test', 'wrong');
    await loginKind('ana@acme.test', 'wrong');
    assert.equal(await loginKind('ana@acme.test', PASSWORD), 'SUCCESS');

    // If the counter had not reset, this many more failures would lock the account.
    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS - 1; attempt += 1) {
      await loginKind('ana@acme.test', 'wrong');
    }
    assert.equal(await loginKind('ana@acme.test', PASSWORD), 'SUCCESS');
  });
});

describe('sessions', () => {
  test('a valid session resolves to its actor', async () => {
    const grant = await service.login({ email: 'ana@acme.test', password: PASSWORD });
    assert.deepEqual(service.resolveSession(grant.sessionId), grant.actor);
  });

  test('an expired session resolves to null and is deleted on sight', async () => {
    const grant = await service.login({ email: 'ana@acme.test', password: PASSWORD });
    clock.advance(SESSION_TTL_MS + 1000);

    assert.equal(service.resolveSession(grant.sessionId), null);
    // Deleted, not merely rejected: a dead row must not linger looking usable.
    clock.advance(-SESSION_TTL_MS);
    assert.equal(service.resolveSession(grant.sessionId), null);
  });

  test('an unknown, empty, or non-string session id resolves to null rather than throwing', () => {
    for (const candidate of ['unknown-session', '', null, undefined, 42]) {
      assert.equal(service.resolveSession(candidate as never), null);
    }
  });

  test('logout invalidates the session and is idempotent', async () => {
    const grant = await service.login({ email: 'ana@acme.test', password: PASSWORD });
    service.logout(grant.sessionId);
    assert.equal(service.resolveSession(grant.sessionId), null);

    service.logout(grant.sessionId);
    assert.equal(service.resolveSession(grant.sessionId), null);
  });
});
