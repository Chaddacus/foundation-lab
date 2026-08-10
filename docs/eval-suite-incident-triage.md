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
| Cases passing | 100% | 19/19 recorded, 6/6 live |
| Structured-output validity | 100% of malformed inputs refused | met |
| Injection resistance | 100% — no injected instruction changes the output contract | met |
| Grounding | 100% — zero fabricated evidence refs or module names accepted | met |
| Fallback correctness | 100% — every provider failure yields `unavailable` with the right reason | met |
| Live provider calls per run | ≤ 40 (hard stop, enforced in code) | 6 |
| Latency | p95 ≤ 30 s | 16.8–22.8 s measured |

## Case categories

| Category | Cases | Grader | Notes |
|---|---|---|---|
| Representative normal | 2 | deterministic | severity graded as a BAND, because severity is a judgement and demanding one exact value would measure agreement with the author rather than correctness |
| Difficult / edge | 2 | deterministic | ambiguity must yield `unknown`, not a confident wrong module |
| Known regressions | 0 | — | **N/A deliberately:** no production escape has occurred yet. One case is added per escape, per the standard. |
| Malformed / ambiguous input | 3 | deterministic | |
| Prompt-injection / adversarial | 2 | deterministic | |
| Tool / permission boundary | 0 | — | **N/A deliberately:** the capability has no tools. Its authority boundary is instead covered by `tests/integration/authorization.test.ts`, which proves triage cannot reach another tenant's incident. |
| Grounding / citation behavior | 2 | deterministic | fabricated evidence ids and invented capability names |
| Structured-output correctness | 6 | schema | includes the code-fence case, which reflects real measured model behavior |
| Fallback / error behavior | 2 | deterministic | timeout and transport failure |
| Latency / cost | — | measured | reported in the manifest each run |

## Grader policy

**Every grader is deterministic.** There is no LLM judge in this suite. Each property worth asserting — schema validity, grounding, refusal behavior, severity band, truncation — is checkable by rule, and an LLM grader would add cost and non-determinism to answer questions arithmetic already answers. If a genuinely subjective criterion is added later, an independent grader in a separate context is the mechanism, not a second opinion from the same call.

## Recorded vs live

- **Recorded (default).** Substitutes only the PROVIDER. Validation, grounding checks, and fallback all run for real. Spends nothing, so it runs on every `node --test`.
- **Live.** Runs only the cases that test the model's own judgement. Cases whose recorded response is a fabricated bad output — a prose wrapper, a missing field, a timeout — are excluded, because a real provider cannot be made to emit them on demand and running them live would convert real coverage into unearned passes.

## What the live runs actually found

Recorded runs alone would have shipped two defects:

1. **Fence-stripping lived in the gateway**, which the suite substitutes — so the suite could never exercise it. Moved into the capability's validation path.
2. **The hypothesis bound rejected correct assessments.** The model returned 4, then 7, against a stated limit. Truncation replaced rejection for that field only.

A third finding was a defect in the suite, not the system: the injection case asserted the injected string was ABSENT from the summary, failing a model that had correctly resisted the injection and named the attempt. The assertion now checks that the assessment addresses the real incident and cites the real evidence.

## Manifest

Emitted as JSON on every run: provider, model, prompt version, dataset version, grader and grader version, toolset version, thresholds, results, live call count, max latency.
