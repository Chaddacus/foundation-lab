# AI Capability Contract — Incident Triage

SPEC.md §12.2/§12.6 (foundation standard: `ai-engineering.md`). Complete before DEV. **A capability without a current contract and eval suite is NOT READY.**

Cost figures below were approved by the human approver on 2026-08-10, against D1's constraint that eval runs draw the same subscription capacity that ran out for a previous session.

## Identity

- **Owner / module:** `src/modules/triage/`
- **Purpose:** Turn an unstructured incident report — an alert summary, free-text notes, selected log lines — into a structured first assessment: severity, affected capability, a grounded summary, competing hypotheses, and a recommended next investigation. The justified ambiguity is *language*: reading prose written under pressure and relating it to system structure. Deterministic code cannot do that. Everything downstream of it — what severity means, who may see the incident, what happens next — stays deterministic.
- **Architecture rung:** **one call.** No retrieval: every fact the model may use is supplied by the caller in the request, so there is nothing to retrieve. No tools: the capability answers, it does not act. Anything above this rung would need to justify its coordination cost, and none can.

## Contracts

- **Input contract:** `TriageRequest` — `incidentId`, `title`, `report` (free text, ≤ 8000 chars), `evidence[]` (each with an `id` and `text`, ≤ 20 items), and `moduleNames[]` (the capabilities that exist). Validated **before** the model: lengths, counts, non-empty title and report, and unique evidence ids. Oversized or malformed input is rejected deterministically and never reaches the provider.
- **Structured output contract:** `TriageAssessment` —
  - `severity`: one of `SEV-0` … `SEV-3`
  - `affectedCapability`: string
  - `summary`: string, ≤ 600 chars
  - `hypotheses`: 1–6 strings (an over-long list is truncated, see validation below)
  - `recommendedNextInvestigation`: string
  - `evidenceRefs`: string[] — ids drawn from the supplied evidence
  - `confidence`: `high` | `medium` | `low`
- **Post-output validation (deterministic, after the model):**
  - JSON parses, and every field is present with the right type. **Valid JSON is not semantic correctness**, so the checks continue:
  - `severity` is in the enum.
  - `affectedCapability` is one of the supplied `moduleNames`, or the literal `unknown`. A hallucinated module name is a **rejection**, not a warning.
  - Every `evidenceRefs` entry matches a supplied evidence id. A citation to evidence that was never supplied is a **rejection** — this is the check that makes "grounded" mean something.
  - `hypotheses` is at least one non-empty entry. An over-long list is **truncated to 6, not rejected** — extra hypotheses are merely more than the interface wants, unlike a fabricated evidence reference or an out-of-enum severity, which are wrong and must reject. Live runs returned 4 then 7 against a stated limit, so a hard bound here would discard correct assessments for being too helpful.
  - `summary` within length.
  - Failure of any check is treated exactly as a provider failure: the fallback below applies.
- **Grounding sources, in authority order:** (1) the supplied `evidence[]`; (2) the `report` text; (3) the supplied `moduleNames`. The model is instructed to use nothing else, and the `evidenceRefs` check enforces it structurally rather than by trusting the instruction.

## Tools

**None.** The capability is a single call with no tool access. Forbidden explicitly: any file, shell, network, database, or MCP tool; any capability that mutates an incident, project, release, customer, or session.

This is not a limitation to be relaxed casually — a triage capability that could act would need an execution-time authorization model it does not have.

## Authority and side effects

- **Irreversible effects: none.** The capability returns an assessment. Deterministic code stores it as a **suggestion attached to an incident**, and it never overwrites the incident's recorded severity or status. A human or a later deterministic rule decides what to do with it.
- **The assessment is never presented as fact.** The UI must distinguish supplied data, grounded evidence, and AI interpretation (Standard 10).
- **Fallback / degradation:** provider unreachable, timeout, non-JSON output, schema-invalid output, or any post-output validation failure all produce the same result: `status: 'unavailable'` with a machine-readable reason, and **no assessment**. The incident remains untriaged. The capability never guesses, never partially fills an assessment, and never presents queued work as complete.

## Budgets and provider

- **Provider/model policy:** Claude-first. **Model: `claude-haiku-4-5-20251001`** — the least expensive adequate model, per the foundation's routing rule. Routed through the gateway seam at `src/spine/ai-gateway.ts`; no module contains provider invocation. Today the gateway shells the subscription-backed Claude CLI, because no `ANTHROPIC_API_KEY` exists on this machine (D1). Swapping to a metered API key is a change inside the gateway plus configuration — no business logic moves.
- **Latency target:** p95 ≤ 30 s per call. Set from measurement, not aspiration: live runs on this machine produced 16.8 s–22.8 s per call. An earlier 20 s target was written before measuring and would have been breached by a healthy system.
- **Timeout:** 60 s hard. **Retry:** exactly one, only for a transport failure or unparseable output — never for a semantically rejected assessment, because retrying a validation failure is how a wrong answer eventually gets through.
- **Cost budget — approved, and binding:**

  | Tier | Cases | Real provider calls per run | When |
  |---|---|---|---|
  | FAST | 3 golden | 3 | every FAST run, only when explicitly enabled |
  | MODULE | ~25 | ~25 | only when the capability changes |
  | FULL | — | 0 | reuses the MODULE result |

  **Hard stop: 40 real provider calls in a single suite run.** The runner counts calls and aborts with a clear message rather than continuing. This is enforced in code, not by intention.

  **Default is the fake provider.** Every automated test run uses recorded deterministic responses and spends nothing. Real-provider runs are opt-in via `FL_EVAL_PROVIDER=live`. This is what keeps a routine `node --test` from drawing subscription capacity.

## Versioned behavior

- **Prompt version:** `triage-prompt-v2` (v1 stated a 1–4 hypothesis range; v2 states 1–6 to match the validator)
- **Toolset version:** `none-v1`
- **Retrieval/chunking/embedding version:** N/A — no retrieval.
- Any change to the prompt, model, output schema, validation rules, or fallback behavior is a **behavioral software change** and runs the eval suite before DEV promotion.

## Evaluation

- **Eval suite:** `evals/incident-triage/` (cases + runner). Definition: `docs/eval-suite-incident-triage.md`.
- **Thresholds:** 100% structured-output validity; 100% injection resistance; 100% fallback correctness; ≥ 90% severity agreement on golden cases; 100% grounding (zero fabricated evidence references or module names).
- **verification.json:** the `triage` module profile carries `"ai_eval": true`. Its absence fails closed.

## Observability

Recorded per call: provider, model, prompt version, capability, latency, outcome, validation-failure reason, and whether the fake or live provider served it. **Never recorded:** the prompt text, the report text, the evidence text, or the raw response — incident reports are user content and the data-minimization rule applies to AI operations like everything else.
