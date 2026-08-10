/**
 * Password hashing — unit tests.
 *
 * Layer rationale: these are pure functions, so plain calls are the cheapest layer that can
 * observe them. The authentication tests do not re-assert hashing; they assert login
 * behavior.
 *
 * What this defends: that a verifier is salted, self-describing, and never equal to the
 * password, and that a malformed verifier denies rather than crashes.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DUMMY_VERIFIER, hashPassword, verifyPassword } from '../../src/modules/customers/passwords.ts';

const PASSWORD = 'correct-horse-battery-staple';

describe('hashPassword', () => {
  test('produces a self-describing verifier that records its own cost parameters', async () => {
    const parts = (await hashPassword(PASSWORD)).split('$');
    assert.equal(parts.length, 6);
    assert.equal(parts[0], 'scrypt');
    // Parameters travel with the verifier so cost can be raised later without invalidating
    // existing accounts.
    assert.ok(Number(parts[1]) >= 16384, 'scrypt N is below an interactive-login setting');
  });

  test('never contains the password', async () => {
    assert.ok(!(await hashPassword(PASSWORD)).includes(PASSWORD));
  });

  test('salts, so the same password hashes differently every time', async () => {
    assert.notEqual(await hashPassword(PASSWORD), await hashPassword(PASSWORD));
  });
});

describe('verifyPassword', () => {
  test('accepts the correct password and rejects a wrong one', async () => {
    const verifier = await hashPassword(PASSWORD);
    assert.equal(await verifyPassword(PASSWORD, verifier), true);
    assert.equal(await verifyPassword('wrong', verifier), false);
  });

  test('rejects a near-miss, including case and whitespace differences', async () => {
    const verifier = await hashPassword(PASSWORD);
    const nearMisses = [PASSWORD.toUpperCase(), ` ${PASSWORD}`, `${PASSWORD} `, PASSWORD.slice(0, -1)];

    for (const candidate of nearMisses) {
      assert.equal(await verifyPassword(candidate, verifier), false, `accepted near-miss "${candidate}"`);
    }
  });

  test('denies rather than throws on a malformed verifier', async () => {
    // A corrupt row must not crash login into a 500 that reveals the account exists.
    for (const malformed of ['', 'not-a-verifier', 'scrypt$1$2$3', 'scrypt$a$b$c$d$e', 'bcrypt$1$8$1$aa$bb']) {
      assert.equal(await verifyPassword(PASSWORD, malformed), false, `accepted malformed verifier "${malformed}"`);
    }
  });

  test('denies a verifier whose cost would exhaust memory, instead of attempting it', async () => {
    // Bounds the work a hostile or corrupt row can demand of one login attempt.
    const absurd = `scrypt$1073741824$8$1$${Buffer.from('salt').toString('base64')}$${Buffer.alloc(64).toString('base64')}`;
    assert.equal(await verifyPassword(PASSWORD, absurd), false);
  });
});

describe('the dummy verifier', () => {
  test('is a real verifier, so an unknown email costs the same work as a wrong password', async () => {
    assert.match(DUMMY_VERIFIER, /^scrypt\$/);
    assert.equal(await verifyPassword(PASSWORD, DUMMY_VERIFIER), false);
  });
});
