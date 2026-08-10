/**
 * Releases domain rules — unit tests.
 *
 * Layer rationale: validation and the lifecycle state machine are pure, so they are proven
 * here by direct calls. The authorization tests do not re-assert these rules, and these
 * tests know nothing about tenants.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertTransitionAllowed,
  normalizeCreate,
  ENVIRONMENTS,
  VERSION_MAX_LENGTH,
} from '../../src/modules/releases/domain.ts';
import type { ReleaseStatus } from '../../src/modules/releases/contract.ts';
import type { AppError } from '../../src/spine/errors.ts';

const VALID = {
  projectId: 'project-1',
  version: '1.4.0',
  vcsRef: 'abc1234',
  artifactDigest: 'sha256:beef',
  environment: 'DEV' as const,
};

describe('normalizeCreate', () => {
  test('accepts and trims a complete release', () => {
    assert.deepEqual(normalizeCreate({ ...VALID, version: '  1.4.0  ' }), VALID);
  });

  test('requires every field that identifies what is being released', () => {
    // Each of these is what joins a release to its telemetry and its artifact. A release
    // missing one cannot be correlated later, which defeats the point of recording it.
    for (const field of ['projectId', 'version', 'vcsRef', 'artifactDigest'] as const) {
      assert.throws(
        () => normalizeCreate({ ...VALID, [field]: '' }),
        (error: AppError) => error.kind === 'validation' && error.details?.[field] !== undefined,
        `missing ${field} was accepted`,
      );
    }
  });

  test('rejects an environment outside the declared set', () => {
    assert.throws(
      () => normalizeCreate({ ...VALID, environment: 'PRODUCTION' as never }),
      (error: AppError) => error.details?.environment !== undefined,
    );
    for (const environment of ENVIRONMENTS) {
      assert.equal(normalizeCreate({ ...VALID, environment }).environment, environment);
    }
  });

  test('rejects a version longer than the limit', () => {
    assert.throws(() => normalizeCreate({ ...VALID, version: 'x'.repeat(VERSION_MAX_LENGTH + 1) }));
  });

  test('reports every invalid field at once', () => {
    assert.throws(
      () => normalizeCreate({ projectId: '', version: '', vcsRef: '', artifactDigest: '', environment: 'X' as never }),
      (error: AppError) => Object.keys(error.details ?? {}).length === 5,
    );
  });

  test('ignores a client-supplied status, so a release cannot be born verified', () => {
    const result = normalizeCreate({ ...VALID, status: 'verified' } as never);
    assert.equal('status' in result, false);
  });
});

describe('lifecycle transitions', () => {
  test('allows the forward path', () => {
    assert.doesNotThrow(() => assertTransitionAllowed('pending', 'deployed'));
    assert.doesNotThrow(() => assertTransitionAllowed('deployed', 'verified'));
  });

  test('allows rolling back from pending or deployed', () => {
    assert.doesNotThrow(() => assertTransitionAllowed('pending', 'rolled_back'));
    assert.doesNotThrow(() => assertTransitionAllowed('deployed', 'rolled_back'));
  });

  test('refuses to move backwards, because release status is evidence', () => {
    // Evidence that can be rewritten backwards is not evidence: a verified release must not
    // quietly become pending again.
    assert.throws(
      () => assertTransitionAllowed('deployed', 'pending'),
      (error: AppError) => error.kind === 'conflict',
    );
  });

  test('treats verified and rolled_back as terminal', () => {
    for (const from of ['verified', 'rolled_back'] as ReleaseStatus[]) {
      for (const to of ['pending', 'deployed', 'verified', 'rolled_back'] as ReleaseStatus[]) {
        assert.throws(
          () => assertTransitionAllowed(from, to),
          (error: AppError) => error.kind === 'conflict',
          `${from} -> ${to} was allowed`,
        );
      }
    }
  });

  test('reports a no-op transition as conflict rather than silently succeeding', () => {
    assert.throws(
      () => assertTransitionAllowed('pending', 'pending'),
      (error: AppError) => error.kind === 'conflict' && /already pending/.test(error.message),
    );
  });

  test('rejects a status that is not part of the lifecycle', () => {
    assert.throws(
      () => assertTransitionAllowed('pending', 'deleted' as never),
      (error: AppError) => error.kind === 'validation',
    );
  });
});
