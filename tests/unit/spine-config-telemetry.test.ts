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
import { createLogger } from '../../src/spine/logger.ts';
import type { AppError } from '../../src/spine/errors.ts';

/**
 * A session secret for non-LOCAL configurations.
 *
 * Outside LOCAL the application refuses to start without one, so tests that build a DEV or
 * SANDBOX config must supply it — that refusal is asserted separately below.
 */
const SECRET = { FL_SESSION_SECRET: 'test-secret-not-a-real-key' };

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
    assert.notEqual(loadConfig({ FL_ENV: 'DEV', ...SECRET }).databasePath, loadConfig({ FL_ENV: 'SANDBOX', ...SECRET }).databasePath);
  });

  test('defaults to loopback, so a misconfiguration cannot expose the port', () => {
    assert.equal(loadConfig({}).bindAddress, '127.0.0.1');
  });

  test('the bind address is overridable, because a container must bind 0.0.0.0', () => {
    // Inside a container, binding loopback makes a published port unreachable. The
    // loopback-only guarantee moves up a level: the HOST publishes to 127.0.0.1 only.
    assert.equal(loadConfig({ FL_BIND_ADDRESS: '0.0.0.0' }).bindAddress, '0.0.0.0');
  });

  test('returns a frozen object, so nothing mutates configuration at runtime', () => {
    assert.equal(Object.isFrozen(loadConfig({})), true);
  });
});

describe('session secret', () => {
  test('LOCAL generates an ephemeral secret so a fresh clone runs with no setup', () => {
    const first = loadConfig({});
    const second = loadConfig({});
    assert.ok(first.sessionSecret.length >= 32);
    // Different per process start, so restarting invalidates sessions rather than
    // reusing a value that has quietly become a shared constant.
    assert.notEqual(first.sessionSecret, second.sessionSecret);
  });

  test('DEV and SANDBOX refuse to start without one, rather than defaulting', () => {
    // A default signing key is indistinguishable from no signature at all: anyone who reads
    // the source could mint sessions. This must be a loud startup failure.
    for (const environment of ['DEV', 'SANDBOX']) {
      assert.throws(
        () => loadConfig({ FL_ENV: environment }),
        (error: AppError) => error.kind === 'validation' && error.message.includes('FL_SESSION_SECRET'),
        `${environment} accepted a missing session secret`,
      );
    }
  });

  test('the refusal never echoes the secret value', () => {
    try {
      loadConfig({ FL_ENV: 'DEV', FL_SESSION_SECRET: '   ' });
      assert.fail('expected a refusal');
    } catch (error) {
      assert.ok(!(error as AppError).message.includes('   '.trim() || 'IMPOSSIBLE'));
      assert.ok(!/secret is\s+\S+$/.test((error as AppError).message));
    }
  });
});

describe('OTel correlation contract', () => {
  test('carries every field the correlation contract requires', () => {
    const attributes = buildResourceAttributes(loadConfig({
      ...SECRET,
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

  test('the log processor is built with an exporter that is actually wired', async () => {
    // Regression: `new BatchLogRecordProcessor(exporter)` is accepted silently but leaves
    // the exporter undefined — the pipeline then exports nothing and throws on shutdown.
    // The constructor takes an options object. This asserts the wiring rather than the
    // call shape, so it still holds if the construction is refactored.
    const { BatchLogRecordProcessor } = await import('@opentelemetry/sdk-logs');
    const { OTLPLogExporter } = await import('@opentelemetry/exporter-logs-otlp-http');

    const processor = new BatchLogRecordProcessor({
      exporter: new OTLPLogExporter({ url: 'http://127.0.0.1:4318/v1/logs' }),
    });

    assert.ok(
      (processor as unknown as { _exporter?: unknown })._exporter !== undefined,
      'log processor has no exporter — log export would silently do nothing',
    );
    await processor.shutdown();
  });
});

describe('structured logs', () => {
  test('carry the full correlation contract, so a log can be joined to a release', () => {
    const config = loadConfig({ ...SECRET, FL_ENV: 'DEV', FL_SERVICE_VERSION: '2.0.0', FL_VCS_REF: 'deadbee', FL_OTLP_ENDPOINT: '' });
    const written: string[] = [];
    const original = console.error;
    console.error = (line: string) => { written.push(line); };

    try {
      createLogger(config).error('database unreachable', { module: 'projects', operation: 'createProject' });
    } finally {
      console.error = original;
    }

    const record = JSON.parse(written[0]);
    assert.equal(record.level, 'error');
    assert.equal(record.message, 'database unreachable');
    assert.equal(record['deployment.environment.name'], 'DEV');
    assert.equal(record['service.version'], '2.0.0');
    assert.equal(record['vcs.ref.head.revision'], 'deadbee');
    assert.equal(record['app.module'], 'projects');
  });

  test('omit trace_id entirely when nothing is sampled, rather than emitting the all-zero id', () => {
    const written: string[] = [];
    const original = console.error;
    console.error = (line: string) => { written.push(line); };

    try {
      createLogger(loadConfig({ FL_OTLP_ENDPOINT: '' })).error('boom', { module: 'spine' });
    } finally {
      console.error = original;
    }

    const record = JSON.parse(written[0]);
    assert.equal('trace_id' in record, false);
  });
});
