/**
 * Projects domain rules — unit tests.
 *
 * Layer rationale: these rules are pure functions, so plain calls are the cheapest layer
 * that can observe them. The HTTP and MCP tests do NOT re-assert validation messages; they
 * assert their own boundary instead (Standard 4: one behavior, one primary proving layer).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCreate, normalizeUpdate, NAME_MAX_LENGTH, DESCRIPTION_MAX_LENGTH } from '../../src/modules/projects/domain.ts';
import { AppError } from '../../src/spine/errors.ts';

describe('normalizeCreate', () => {
  test('trims a valid project and defaults an absent description to empty', () => {
    const result = normalizeCreate({ name: '  Apollo  ', customerId: ' cust-1 ' });
    assert.deepEqual(result, { name: 'Apollo', description: '', customerId: 'cust-1' });
  });

  test('rejects a name that is only whitespace', () => {
    assert.throws(
      () => normalizeCreate({ name: '   ', customerId: 'cust-1' }),
      (error: AppError) => error.kind === 'validation' && error.details?.name === 'Enter a project name.',
    );
  });

  test('rejects a name longer than the limit but accepts one exactly at it', () => {
    assert.throws(() => normalizeCreate({ name: 'x'.repeat(NAME_MAX_LENGTH + 1), customerId: 'c' }));
    assert.equal(normalizeCreate({ name: 'x'.repeat(NAME_MAX_LENGTH), customerId: 'c' }).name.length, NAME_MAX_LENGTH);
  });

  test('rejects a description longer than the limit', () => {
    assert.throws(
      () => normalizeCreate({ name: 'Apollo', customerId: 'c', description: 'x'.repeat(DESCRIPTION_MAX_LENGTH + 1) }),
      (error: AppError) => error.details?.description !== undefined,
    );
  });

  test('requires a customer, because an unowned project has no authorization anchor', () => {
    assert.throws(
      () => normalizeCreate({ name: 'Apollo', customerId: '' }),
      (error: AppError) => error.details?.customerId === 'A project must belong to a customer.',
    );
  });

  test('reports every invalid field at once so a form need not be resubmitted to find the next error', () => {
    assert.throws(
      () => normalizeCreate({ name: '', customerId: '' }),
      (error: AppError) => Object.keys(error.details ?? {}).length === 2,
    );
  });

  test('treats a non-string field as missing rather than coercing it', () => {
    assert.throws(() => normalizeCreate({ name: 42, customerId: 'c' } as never));
  });
});

describe('normalizeUpdate', () => {
  test('returns only the supplied fields, so an absent field means unchanged', () => {
    assert.deepEqual(normalizeUpdate({ name: ' Renamed ' }), { name: 'Renamed' });
  });

  test('allows clearing a description with an explicit empty string', () => {
    assert.deepEqual(normalizeUpdate({ description: '' }), { description: '' });
  });

  test('rejects an update that names no recognised field instead of silently succeeding', () => {
    assert.throws(
      () => normalizeUpdate({}),
      (error: AppError) => error.kind === 'validation',
    );
  });

  test('rejects clearing the name, which is required', () => {
    assert.throws(() => normalizeUpdate({ name: '  ' }));
  });
});
