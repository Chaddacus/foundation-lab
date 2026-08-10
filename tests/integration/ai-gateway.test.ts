/**
 * AI provider gateway — integration tests against a stub executable.
 *
 * What this defends: the subprocess behaviors the eval suite structurally CANNOT cover,
 * because it substitutes this class by design. That substitution is exactly what previously
 * hid a defect in this file, so the transport is proven here directly.
 *
 * Uses a stub script instead of the real CLI: no subscription capacity is spent, and
 * failure modes a real provider will not produce on demand — a non-zero exit, silence, an
 * early exit that breaks the stdin pipe — become reproducible.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCliGateway, claudeCliArgs } from '../../src/spine/ai-gateway.ts';

let directory: string;

/** Write an executable stub and return its path. */
function stub(name: string, body: string): string {
  const path = join(directory, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

before(() => { directory = mkdtempSync(join(tmpdir(), 'foundation-lab-gateway-')); });
after(() => { rmSync(directory, { recursive: true, force: true }); });

const request = { prompt: 'hello', model: 'test-model', timeoutMs: 5000 };

describe('tool controls', () => {
  test('passes BOTH an empty allow-list and an explicit deny-list', () => {
    // An allow-list is not a denial control. This argv is the only thing standing between
    // attacker-controlled report text and a tool-capable subprocess, so its exact shape is
    // asserted rather than assumed.
    const args = claudeCliArgs('some-model');

    assert.ok(args.includes('--allowedTools'));
    assert.equal(args[args.indexOf('--allowedTools') + 1], '');

    assert.ok(args.includes('--disallowedTools'), 'no explicit denial flag');
    const denied = args[args.indexOf('--disallowedTools') + 1];
    for (const tool of ['Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'Task']) {
      assert.match(denied, new RegExp(`\\b${tool}\\b`), `${tool} is not explicitly denied`);
    }
  });

  test('runs non-interactively against the requested model', () => {
    const args = claudeCliArgs('claude-haiku-4-5-20251001');
    assert.ok(args.includes('-p'));
    assert.equal(args[args.indexOf('--model') + 1], 'claude-haiku-4-5-20251001');
  });

  test('the argv actually reaches the child process', async () => {
    // Asserting the array alone would prove nothing if the class ignored it.
    // Drains stdin first, like every other stub. Without that the child can exit before the
    // prompt finishes writing, the gateway correctly reports a broken pipe, and the test
    // fails for a reason that has nothing to do with argv. It passed on macOS and failed on
    // Linux — a race the local platform happened to hide.
    const path = stub('echo-args.sh', 'cat > /dev/null; echo "$@"');
    const result = await new ClaudeCliGateway(path).complete(request);
    assert.equal(result.ok, true);
    assert.match(result.ok ? result.text : '', /--disallowedTools/);
  });
});

describe('outcomes', () => {
  test('a normal response is returned verbatim', async () => {
    const path = stub('ok.sh', 'cat > /dev/null; printf \'{"a":1}\'');
    const result = await new ClaudeCliGateway(path).complete(request);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.text, '{"a":1}');
    assert.ok(result.latencyMs >= 0);
  });

  test('a non-zero exit is transport, not a crash', async () => {
    const path = stub('fail.sh', 'cat > /dev/null; echo something; exit 3');
    const result = await new ClaudeCliGateway(path).complete(request);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'transport');
  });

  test('silence is reported as empty, not as an empty assessment', async () => {
    const path = stub('silent.sh', 'cat > /dev/null; exit 0');
    const result = await new ClaudeCliGateway(path).complete(request);
    assert.equal(result.ok === false && result.reason, 'empty');
  });

  test('a missing executable is transport, not an unhandled error', async () => {
    const result = await new ClaudeCliGateway(join(directory, 'does-not-exist')).complete(request);
    assert.equal(result.ok === false && result.reason, 'transport');
  });

  test('a child that exits before reading stdin does not crash the process', async () => {
    // Regression: with no `error` listener on the child's stdin, this emits an unhandled
    // EPIPE, and the process-level handler in main.ts turns that into an exit. An async
    // socket error is not inside the request boundary's try/catch.
    const path = stub('early-exit.sh', 'exit 0');
    const big = { ...request, prompt: 'x'.repeat(400_000) };

    const result = await new ClaudeCliGateway(path).complete(big);

    // The property that matters is that this SETTLES cleanly rather than throwing. The
    // stdin error handler reports it as transport, which is the accurate classification —
    // the prompt never reached the provider.
    assert.equal(result.ok, false, 'a broken stdin pipe should be a failure result');
    assert.ok(
      result.ok === false && ['transport', 'empty'].includes(result.reason),
      `unexpected reason: ${result.ok === false ? result.reason : 'ok'}`,
    );
  });
});

describe('timeout', () => {
  test('a slow child is killed and reported as a timeout', async () => {
    const path = stub('slow.sh', 'cat > /dev/null; sleep 30; echo late');
    const started = Date.now();

    const result = await new ClaudeCliGateway(path).complete({ ...request, timeoutMs: 400 });

    assert.equal(result.ok === false && result.reason, 'timeout');
    // Proves the child was killed rather than waited out — an abandoned subprocess still
    // holds a model call, which is capacity this application is budgeted against.
    assert.ok(Date.now() - started < 5000, 'the gateway waited for the child instead of killing it');
  });

  test('a late write after a timeout does not change the settled result', async () => {
    const path = stub('slow-then-print.sh', 'cat > /dev/null; sleep 2; printf ok');
    const result = await new ClaudeCliGateway(path).complete({ ...request, timeoutMs: 200 });
    assert.equal(result.ok === false && result.reason, 'timeout');
  });
});

describe('data minimization', () => {
  test('stderr from the provider never becomes the response', async () => {
    // stderr may echo prompt content; it must not be a path for user text to travel.
    const path = stub('noisy.sh', 'cat > /dev/null; echo "SECRET REPORT TEXT" >&2; printf \'{"a":1}\'');
    const result = await new ClaudeCliGateway(path).complete(request);
    assert.equal(result.ok, true);
    assert.ok(!(result.ok ? result.text : '').includes('SECRET'));
  });

  test('an oversized response is refused rather than buffered without bound', async () => {
    const path = stub('flood.sh', 'cat > /dev/null; i=0; while [ $i -lt 400 ]; do printf "%01000d" 0; i=$((i+1)); done');
    const result = await new ClaudeCliGateway(path).complete(request);
    assert.equal(result.ok === false && result.reason, 'transport');
  });
});
