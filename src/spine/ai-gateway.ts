/**
 * AI provider gateway.
 *
 * Responsibility: turn a prompt into text from a language model, and nothing else.
 *
 * Place in the system: spine. This is the Standard 9 gateway boundary — the ONE place that
 * knows how a provider is invoked. Capability modules depend on the `AiGateway` interface,
 * never on a provider SDK or CLI, so replacing the provider is a change here plus
 * configuration, with no business logic moved.
 *
 * Boundary: no prompts are composed here and no output is interpreted here. Composing the
 * prompt is the capability's job; validating the answer is the capability's job. This file
 * would be equally correct if the model were asked to write a poem.
 *
 * Data minimization: this file MUST NOT log prompt or response text. It records provider,
 * model, latency, and outcome — the metadata the observability standard asks for and
 * nothing that could carry user content.
 */

import { spawn } from 'node:child_process';

export interface AiRequest {
  readonly prompt: string;
  readonly model: string;
  readonly timeoutMs: number;
}

export type AiResult =
  | { readonly ok: true; readonly text: string; readonly latencyMs: number }
  | { readonly ok: false; readonly reason: 'timeout' | 'transport' | 'empty'; readonly latencyMs: number };

export interface AiGateway {
  /** Provider identity, for the observability manifest. */
  readonly provider: string;
  complete(request: AiRequest): Promise<AiResult>;
}

/**
 * The subscription-backed Claude CLI.
 *
 * D1: no `ANTHROPIC_API_KEY` exists on this machine, so the CLI's own login is the
 * credential. That is why this is a subprocess rather than an HTTP client — and why the
 * swap to a metered key is a change confined to this class.
 *
 * Tools are explicitly disabled. This gateway serves a capability with no tool authority,
 * and a provider that could reach the filesystem would silently grant some.
 */
export class ClaudeCliGateway implements AiGateway {
  readonly provider = 'claude-cli';

  async complete(request: AiRequest): Promise<AiResult> {
    const startedAt = Date.now();

    return await new Promise<AiResult>((resolve) => {
      const child = spawn(
        'claude',
        ['-p', '--model', request.model, '--allowedTools', ''],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );

      let stdout = '';
      let settled = false;

      const settle = (result: AiResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      // The child is killed on timeout rather than left running: an abandoned subprocess
      // still holds a model call, which is capacity this application is budgeted against.
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        settle({ ok: false, reason: 'timeout', latencyMs: Date.now() - startedAt });
      }, request.timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      // stderr is drained but discarded: it may echo prompt content, and this boundary
      // must not become a path for user text to reach a log.
      child.stderr.resume();

      child.on('error', () => settle({ ok: false, reason: 'transport', latencyMs: Date.now() - startedAt }));

      child.on('close', (code) => {
        const latencyMs = Date.now() - startedAt;
        if (code !== 0) return settle({ ok: false, reason: 'transport', latencyMs });

        // Returned verbatim. Interpreting the response — including unwrapping a markdown
        // code fence — belongs to the capability that expects a particular shape, not to
        // the transport. Keeping it here would also hide the behavior from the eval suite,
        // which substitutes this class and would then never exercise it.
        const text = stdout.trim();
        if (text === '') return settle({ ok: false, reason: 'empty', latencyMs });
        settle({ ok: true, text, latencyMs });
      });

      child.stdin.end(request.prompt);
    });
  }
}
