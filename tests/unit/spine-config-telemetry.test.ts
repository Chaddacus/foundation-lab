/**
 * Spine configuration and telemetry contract — unit tests.
 *
 * What this defends: configuration that fails loudly on bad input, and the OTel correlation
 * contract from SPEC §8. The correlation fields are asserted by name because a missing one
 * silently breaks the ability to join a signal to a release — the failure would otherwise
 * only surface during an incident.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/spine/config.ts';
import { buildResourceAttributes } from '../../src/spine/telemetry.ts';
import type { AppError } from '../../src/spine/errors.ts';

describe('loadConfig', () => {
  test('defaults to a runnable LOCAL configuration with no environment set', () => {
    const config = loadConfig({});
    assert.equal(config.environment, 'LOCAL');
    assert.equal(config.port, 4310);
    assert.equal(config.otlpEndpoint, 'http://127.0.0.1:4318');
  });

  test('rejects an unknown environment instead of falling back to LOCAL', () => {
    assert.throws(
      () => loadConfig({ FL_ENV: 'PRODUCTION' }),
      (error: AppError) => error.kind === 'validation' && error.message.includes('FL_ENV'),
    );
  });

  test('rejects a non-numeric or out-of-range port', () => {
    assert.throws(() => loadConfig({ FL_PORT: 'eighty' }));
    assert.throws(() => loadConfig({ FL_PORT: '70000' }));
    assert.throws(() => loadConfig({ FL_PORT: '0' }));
  });

  test('labels unstamped release identity rather than inventing a value', () => {
    const config = loadConfig({});
    assert.equal(config.vcsRef, 'unknown');
    assert.equal(config.artifactDigest, 'unbuilt');
  });

  test('derives a per-environment database path so environments cannot share a file', () => {
    assert.notEqual(loadConfig({ FL_ENV: 'DEV' }).databasePath, loadConfig({ FL_ENV: 'SANDBOX' }).databasePath);
  });

  test('returns a frozen object, so nothing mutates configuration at runtime', () => {
    assert.equal(Object.isFrozen(loadConfig({})), true);
  });
});

describe('OTel correlation contract', () => {
  test('carries every field the correlation contract requires', () => {
    const attributes = buildResourceAttributes(loadConfig({
      FL_ENV: 'DEV',
      FL_SERVICE_VERSION: '1.2.3',
      FL_VCS_REF: 'abc1234',
      FL_ARTIFACT_DIGEST: 'sha256:beef',
    }));

    assert.deepEqual(attributes, {
      'service.name': 'foundation-lab',
      'service.version': '1.2.3',
      'deployment.environment.name': 'DEV',
      'vcs.ref.head.revision': 'abc1234',
      'app.artifact.digest': 'sha256:beef',
    });
  });

  test('carries no configuration values beyond deployment identity', () => {
    const attributes = buildResourceAttributes(loadConfig({ FL_DATABASE_PATH: '/secret/path.sqlite' }));
    assert.ok(!JSON.stringify(attributes).includes('/secret/path.sqlite'));
  });
});
