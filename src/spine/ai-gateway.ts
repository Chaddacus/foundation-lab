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
 * Tools this gateway explicitly denies.
 *
 * `--allowedTools ''` is an EMPTY ALLOW-LIST, and an allow-list is not a denial control —
 * it relies on the CLI treating "nothing allowed" as "nothing permitted", which is likely
 * but unproven. `--disallowedTools` is the documented denial flag, so both are passed:
 * the allow-list narrows, the deny-list refuses. This pair is the single control between
 * attacker-controlled incident text and a tool-capable local subprocess, so it does not
 * rest on one flag's implied semantics.
 */
const DENIED_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'Task', 'Agent',
];

/** Argv for the subscription-backed CLI. Exported so a test can assert the exact controls. */
export function claudeCliArgs(model: string): readonly string[] {
  return ['-p', '--model', model, '--allowedTools', '', '--disallowedTools', DENIED_TOOLS.join(' ')];
}

/**
 * Response bytes accepted from the provider.
 *
 * A hostile or malfunctioning provider must not be able to grow this process's memory
 * without bound; the timeout alone would allow a great deal of data in 60 seconds.
 */
const MAX_RESPONSE_BYTES = 256 * 1024;

/**
 * The subscription-backed Claude CLI.
 *
 * D1: no `ANTHROPIC_API_KEY` exists on this machine, so the CLI's own login is the
 * credential. That is why this is a subprocess rather than an HTTP client — and why the
 * swap to a metered key is a change confined to this class.
 *
 * The executable is injectable so the subprocess behaviors — timeout kill, non-zero exit,
 * empty output, a stdin failure — can be proven against a stub. They were unprovable while
 * the binary was hardcoded, which is the same blind spot that previously hid a defect in
 * this file.
 */
export class ClaudeCliGateway implements AiGateway {
  readonly provider = 'claude-cli';
  readonly #command: string;
  readonly #buildArgs: (model: string) => readonly string[];

  constructor(command = 'claude', buildArgs: (model: string) => readonly string[] = claudeCliArgs) {
    this.#command = command;
    this.#buildArgs = buildArgs;
  }

  async complete(request: AiRequest): Promise<AiResult> {
    const startedAt = Date.now();

    return await new Promise<AiResult>((resolve) => {
      const child = spawn(this.#command, [...this.#buildArgs(request.model)], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

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

      child.stdout.on('data', (chunk: Buffer) => {
        if (stdout.length >= MAX_RESPONSE_BYTES) return;
        stdout += chunk.toString();
      });
      // stderr is drained but discarded: it may echo prompt content, and this boundary
      // must not become a path for user text to reach a log.
      child.stderr.resume();

      child.on('error', () => settle({ ok: false, reason: 'transport', latencyMs: Date.now() - startedAt }));

      // A child that exits before the prompt finishes writing makes this socket emit EPIPE.
      // Unhandled, that is an uncaught exception — and the process-level handler in main.ts
      // turns any uncaught exception into an exit. An async socket error is not inside the
      // request boundary's try/catch, so the boundary cannot catch it.
      child.stdin.on('error', () => settle({
        ok: false, reason: 'transport', latencyMs: Date.now() - startedAt,
      }));

      child.on('close', (code) => {
        const latencyMs = Date.now() - startedAt;
        if (code !== 0) return settle({ ok: false, reason: 'transport', latencyMs });

        // Returned verbatim. Interpreting the response — including unwrapping a markdown
        // code fence — belongs to the capability that expects a particular shape, not to
        // the transport. Keeping it here would also hide the behavior from the eval suite,
        // which substitutes this class and would then never exercise it.
        const text = stdout.trim();
        if (text === '') return settle({ ok: false, reason: 'empty', latencyMs });
        if (stdout.length >= MAX_RESPONSE_BYTES) {
          return settle({ ok: false, reason: 'transport', latencyMs });
        }
        settle({ ok: true, text, latencyMs });
      });

      child.stdin.end(request.prompt);
    });
  }
}
