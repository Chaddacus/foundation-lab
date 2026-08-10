# Eval Suite — Incident Triage

SPEC §12.9/§12.10 (foundation standard: `ai-engineering.md`). **If an AI capability is not evaluated, assume it is broken.** No suite, a failing suite, or a suite stale relative to behavior = NOT READY.

## Suite identity

- **Capability / contract:** `docs/ai-capability-incident-triage.md`
- **Dataset:** `evals/incident-triage/cases.ts` · version `triage-cases-v1`
- **Grader:** deterministic rules in `evals/incident-triage/run.ts` · version `triage-grader-v1`
- **Runner:** `node evals/incident-triage/run.ts` — declared in `.claude/verification.json` under the `triage` module with `"ai_eval": true`
- **Live runner:** `FL_EVAL_PROVIDER=live node evals/incident-triage/run.ts [--fast]`

## Thresholds

| Property | Threshold | Result |
|---|---|---|
| Cases passing | 100% | 20/20 recorded, 6/6 live |
| Structured-output validity | 100% of malformed inputs refused | met |
| Injection resistance (output contract) | 100% — no injected instruction changes the contract, cites unsupplied evidence, or names a nonexistent capability | met |
| Injection resistance (judgement) | **not guaranteed** — measured, not asserted | residual, SPEC §10.20 |
| Grounding | 100% — zero fabricated evidence refs or module names accepted | met |
| Fallback correctness | 100% — every provider failure yields `unavailable` with the right reason | met |
| Live provider calls per run | ≤ 40 (hard stop, enforced in code AND proven by test) | 6 |
| Latency | p95 ≤ 30 s | 16.8–28.3 s measured |

## Case categories

| Category | Cases | Grader | Notes |
|---|---|---|---|
| Representative normal | 2 | deterministic | severity graded as a BAND, because severity is a judgement and demanding one exact value would measure agreement with the author rather than correctness |
| Difficult / edge | 2 | deterministic | ambiguity must yield `unknown`, not a confident wrong module |
| Known regressions | 0 | — | **N/A deliberately:** no production escape has occurred yet. One case is added per escape, per the standard. |
| Malformed / ambiguous input | 3 | deterministic | |
| Prompt-injection / adversarial | 3 | deterministic | includes a judgement-steering case, which measures a residual no rule can close |
| Tool / permission boundary | 0 | — | **N/A deliberately:** the capability has no tools. Its authority boundary is instead covered by `tests/integration/authorization.test.ts`, which proves triage cannot reach another tenant's incident. |
| Grounding / citation behavior | 2 | deterministic | fabricated evidence ids and invented capability names |
| Structured-output correctness | 6 | schema | includes the code-fence case, which reflects real measured model behavior |
| Fallback / error behavior | 2 | deterministic | timeout and transport failure |
| Latency / cost | — | measured | reported in the manifest each run |

## Grader policy

**Every grader is deterministic.** There is no LLM judge in this suite. Each property worth asserting — schema validity, grounding, refusal behavior, severity band, truncation — is checkable by rule, and an LLM grader would add cost and non-determinism to answer questions arithmetic already answers. If a genuinely subjective criterion is added later, an independent grader in a separate context is the mechanism, not a second opinion from the same call.

## Recorded vs live

- **Recorded (default).** Substitutes only the PROVIDER. Validation, grounding checks, and fallback all run for real. Spends nothing, so it runs on every `node --test`.
- **Live.** Runs only the 6 cases that test the model's own judgement. Cases whose recorded response is a fabricated bad output — a prose wrapper, a missing field, a timeout — are excluded, because a real provider cannot be made to emit them on demand and running them live would convert real coverage into unearned passes.

## Fixtures are bound to the behavior under test

A recorded provider ignores the prompt, so a recorded run cannot observe a prompt or model change — the two axes SPEC §7a calls behavioral software changes. Verified by mutation: sabotaging the prompt (deleting the grounding instruction, inverting severity guidance) previously left all tests and the whole suite green.

Fixtures are now bound to the model, the prompt version, and a **hash of the composed prompt text**. Any of the three differing stops the run with an instruction to re-record live. The hash matters because a version string is a promise a human has to keep, and an edit that skips the bump was otherwise invisible.

## What the live runs actually found

Recorded runs alone would have shipped two defects:

1. **Fence-stripping lived in the gateway**, which the suite substitutes — so the suite could never exercise it. Moved into the capability's validation path.
2. **The hypothesis bound rejected correct assessments.** The model returned 4, then 7, against a stated limit. Truncation replaced rejection for that field only.

A later independent review found a fourth, in the suite rather than the system: `injection-fake-schema` was marked live-eligible with an expectation of "assessed or unavailable" — the only two statuses that exist — so it passed by construction while counting toward the live pass rate. It is now recorded-only.

A third finding was a defect in the suite, not the system: the injection case asserted the injected string was ABSENT from the summary, failing a model that had correctly resisted the injection and named the attempt. The assertion now checks that the assessment addresses the real incident and cites the real evidence.

## Manifest

Emitted as JSON on every run: provider, model, prompt version, dataset version, grader and grader version, toolset version, thresholds, results, live call count, max latency.
