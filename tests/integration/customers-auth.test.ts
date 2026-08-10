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

let clock: ReturnType<typeof testClock>;
let service: CustomersService;
let customerId: string;

beforeEach(() => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyMigrations(db, [migration]);
  clock = testClock();
  service = new CustomersService(new CustomersRepository(db), clock);

  customerId = service.provisionCustomer('Acme').id;
  service.provisionUser(customerId, 'ana@acme.test', PASSWORD);
});

function loginKind(email: string, password: string): string {
  try {
    service.login({ email, password });
    return 'SUCCESS';
  } catch (error) {
    return (error as AppError).kind;
  }
}

describe('login', () => {
  test('a correct credential yields a session bound to the user\'s customer', () => {
    const grant = service.login({ email: 'ana@acme.test', password: PASSWORD });
    assert.equal(grant.actor.customerId, customerId);
    assert.ok(grant.sessionId.length > 0);
    assert.equal(grant.expiresAt, new Date(clock.now().getTime() + SESSION_TTL_MS).toISOString());
  });

  test('email matching is case-insensitive, because email case is not identity', () => {
    assert.equal(loginKind('ANA@ACME.TEST', PASSWORD), 'SUCCESS');
  });

  test('a wrong password is refused', () => {
    assert.equal(loginKind('ana@acme.test', 'wrong'), 'unauthorized');
  });

  test('an unknown email, a wrong password, and empty input give the same error', () => {
    const messages = new Set<string>();
    for (const [email, password] of [['nobody@nowhere.test', 'x'], ['ana@acme.test', 'wrong'], ['', '']]) {
      try {
        service.login({ email, password });
        assert.fail('expected refusal');
      } catch (error) {
        messages.add((error as AppError).message);
      }
    }
    assert.equal(messages.size, 1, `login messages differ and leak account existence: ${[...messages].join(' | ')}`);
  });

  test('each login yields a distinct session id', () => {
    const first = service.login({ email: 'ana@acme.test', password: PASSWORD }).sessionId;
    const second = service.login({ email: 'ana@acme.test', password: PASSWORD }).sessionId;
    assert.notEqual(first, second);
  });

  test('signing in again does not invalidate an existing session on another device', () => {
    const first = service.login({ email: 'ana@acme.test', password: PASSWORD });
    service.login({ email: 'ana@acme.test', password: PASSWORD });
    assert.notEqual(service.resolveSession(first.sessionId), null, 'the first device was signed out');
  });
});

describe('lockout', () => {
  test('the account locks after the configured number of failures', () => {
    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      assert.equal(loginKind('ana@acme.test', 'wrong'), 'unauthorized');
    }
    // The correct password is now refused too — that is what locked means.
    assert.equal(loginKind('ana@acme.test', PASSWORD), 'unauthorized');
  });

  test('the lock expires and the correct password works again', () => {
    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      loginKind('ana@acme.test', 'wrong');
    }
    assert.equal(loginKind('ana@acme.test', PASSWORD), 'unauthorized');

    clock.advance(LOCKOUT_MS + 1000);
    assert.equal(loginKind('ana@acme.test', PASSWORD), 'SUCCESS');
  });

  test('a successful login before the limit clears the failure count', () => {
    loginKind('ana@acme.test', 'wrong');
    loginKind('ana@acme.test', 'wrong');
    assert.equal(loginKind('ana@acme.test', PASSWORD), 'SUCCESS');

    // If the counter had not reset, this many more failures would lock the account.
    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS - 1; attempt += 1) {
      loginKind('ana@acme.test', 'wrong');
    }
    assert.equal(loginKind('ana@acme.test', PASSWORD), 'SUCCESS');
  });
});

describe('sessions', () => {
  test('a valid session resolves to its actor', () => {
    const grant = service.login({ email: 'ana@acme.test', password: PASSWORD });
    assert.deepEqual(service.resolveSession(grant.sessionId), grant.actor);
  });

  test('an expired session resolves to null and is deleted on sight', () => {
    const grant = service.login({ email: 'ana@acme.test', password: PASSWORD });
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

  test('logout invalidates the session and is idempotent', () => {
    const grant = service.login({ email: 'ana@acme.test', password: PASSWORD });
    service.logout(grant.sessionId);
    assert.equal(service.resolveSession(grant.sessionId), null);

    service.logout(grant.sessionId);
    assert.equal(service.resolveSession(grant.sessionId), null);
  });
});
