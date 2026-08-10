/**
 * Incidents domain rules — unit tests.
 *
 * Layer rationale: validation and the status machine are pure, so they are proven here by
 * direct calls. The authorization tests do not re-assert them.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCreate, normalizeUpdate, REPORT_MAX_LENGTH, SEVERITIES, TITLE_MAX_LENGTH,
} from '../../src/modules/incidents/domain.ts';
import type { AppError } from '../../src/spine/errors.ts';

const VALID = { title: 'Projects failing', report: 'Creates return 500.', severity: 'SEV-1' as const };

describe('normalizeCreate', () => {
  test('accepts and trims a complete incident', () => {
    const result = normalizeCreate({ ...VALID, title: '  Projects failing  ' });
    assert.equal(result.title, 'Projects failing');
    assert.equal(result.caseRef, null);
  });

  test('requires a title, a report, and a severity', () => {
    for (const field of ['title', 'report', 'severity'] as const) {
      assert.throws(
        () => normalizeCreate({ ...VALID, [field]: '' }),
        (error: AppError) => error.details?.[field] !== undefined,
        `missing ${field} was accepted`,
      );
    }
  });

  test('rejects a severity outside the enum', () => {
    assert.throws(() => normalizeCreate({ ...VALID, severity: 'CRITICAL' as never }));
    for (const severity of SEVERITIES) {
      assert.equal(normalizeCreate({ ...VALID, severity }).severity, severity);
    }
  });

  test('bounds the title and the report', () => {
    assert.throws(() => normalizeCreate({ ...VALID, title: 'x'.repeat(TITLE_MAX_LENGTH + 1) }));
    assert.throws(() => normalizeCreate({ ...VALID, report: 'x'.repeat(REPORT_MAX_LENGTH + 1) }));
  });

  test('the report bound matches the AI input limit, so any stored incident can be triaged', () => {
    // If these ever diverge, an incident could be created that the triage capability must
    // refuse — a dead end the user could not have anticipated.
    assert.equal(REPORT_MAX_LENGTH, 8000);
  });

  test('treats an absent and an empty Case reference identically as null', () => {
    // "No Case yet" has one representation, so a reader never has to guess whether an empty
    // string means something different from a missing field.
    assert.equal(normalizeCreate({ ...VALID, caseRef: '' }).caseRef, null);
    assert.equal(normalizeCreate({ ...VALID, caseRef: '   ' }).caseRef, null);
    assert.equal(normalizeCreate({ ...VALID }).caseRef, null);
    assert.equal(normalizeCreate({ ...VALID, caseRef: 'case-42' }).caseRef, 'case-42');
  });
});

describe('normalizeUpdate', () => {
  test('returns only the supplied fields', () => {
    assert.deepEqual(normalizeUpdate({ severity: 'SEV-0' }, 'open'), { severity: 'SEV-0' });
  });

  test('allows clearing a Case reference explicitly', () => {
    assert.deepEqual(normalizeUpdate({ caseRef: '' }, 'open'), { caseRef: null });
  });

  test('rejects an update naming no recognised field', () => {
    assert.throws(() => normalizeUpdate({}, 'open'));
  });

  test('refuses to reopen a resolved incident', () => {
    // Reopening is a deliberate act this slice does not provide. Allowing it silently would
    // make "resolved" mean nothing.
    assert.throws(
      () => normalizeUpdate({ status: 'open' }, 'resolved'),
      (error: AppError) => error.kind === 'conflict',
    );
  });

  test('allows a resolved incident to be re-saved as resolved', () => {
    assert.deepEqual(normalizeUpdate({ status: 'resolved' }, 'resolved'), { status: 'resolved' });
  });
});
