# SPEC.md — Foundation Lab

**Status:** slice 1 in progress (spine + Projects). This file is the canonical current specification for this repository. Documentation under `docs/` is subordinate to it. Historical plans and handoffs do not outrank this file or the live system.

## 1. Purpose

Foundation Lab is a compact project/change-management application. It is a qualification instrument for the Claude Engineering Foundation (Phase 11). It must be small enough to break deliberately and complete enough to exercise all ten Standards.

Foundation Lab is not a customer product. It carries no real customer data.

## 2. Accepted requirements (source: `REFERENCE_APPLICATION.md`)

Capability modules, in build order:

| Module | Slice | Status |
|---|---|---|
| Projects | 1 | in progress |
| Customers | 2 | not started |
| Releases | 2 | not started |
| Incidents | 3 | not started |
| AI Triage (Incident Triage) | 3 | not started |

Slice plan ratified 2026-08-09. A checkpoint with the human approver follows slice 1.

## 3. Architecture

Spine plus capability modules (Standard 2).

```
src/
  spine/          application-wide coordination only
  modules/
    projects/     domain, persistence, contract, adapters, module-owned UI
  web/            application shell served by the spine
tests/
  unit/           pure rules
  integration/    real storage and a real server
  contract/       API/MCP parity
  e2e/            browser proof
```

Tests live in one top-level structure rather than beside each module. Module ownership is expressed by the source layout; the test tree mirrors proving layers.

### 3.1 Spine ownership

The spine owns, and owns only: process bootstrap, configuration loading and validation, dependency registration, top-level route composition, the global error boundary, and OpenTelemetry initialization. The spine MUST NOT hold business logic.

### 3.2 Module ownership

Each module owns its domain behavior, its persistence abstraction, its internal implementation, its feature-specific validation, its public capability contract, and its own tests.

Cross-module consumers use the public contract only. They do not reach into module internals and do not mutate another module's tables.

### 3.3 API/MCP first

Business capabilities are implemented once in the module. HTTP/REST and MCP are adapters over the same contract. Business logic MUST NOT be duplicated between them.

`tests/contract/projects-parity.test.ts` defends this by running both adapters over a shared corpus of deliberately discriminating inputs — nullish, absent, wrong-typed, whitespace, and extra-field cases — and requiring identical outcomes, plus checking that the adapters cover the same capability set, derived from the service's own methods rather than a hand-written list.

The strength and the limit of that check, stated honestly: it caught an injected HTTP-only default that the earlier hand-picked cases missed, and it caught a real id-validation rule that existed only in the MCP adapter. It is a corpus, not a proof — a divergence reachable only by an input outside the corpus would still pass.

**The MCP adapter has no transport.** Its tools and dispatcher are contract-tested, but no stdio server serves them, so MCP is currently unreachable by any client. See §10.

## 4. Module contracts

### 4.1 Projects (`src/modules/projects/`)

Owned data: the `projects` table. No other module writes it.

| Capability | Slice | Notes |
|---|---|---|
| `createProject` | 1 | validates name and customer reference |
| `getProject` | 1 | by id |
| `listProjects` | 1 | |
| `updateProject` | 1 | name and description |
| `archiveProject` | 4 | deferred deliberately — it is the `feature/project-archive` worktree journey |

Project lifecycle status: `active` → `archived`. Slice 1 creates projects in `active` only; the transition ships in slice 4.

## 5. Data ownership and storage

SQLite via the built-in `node:sqlite` module. One file per environment, path from configuration. Chosen because it is real persistent storage with zero added dependency.

Each module owns a persistence abstraction over its own tables. Schema migrations live with the owning module.

## 6. Verification

Tier commands are declared in `.claude/verification.json`. FAST is a cheap breadth heartbeat. MODULE deeply verifies the affected capability. FULL is for release and architecture change.

Meaningful frontend work requires browser-grounded proof, and the evidence must be inspected, not merely produced.

## 7. Security and trust boundaries

- **Data classes present:** INTERNAL only. Foundation Lab holds no CONFIDENTIAL or RESTRICTED data and no real customer records.
- **Secrets:** the repository stores secret **references**, never values. This machine's backend map (`global/secrets-backends.json`) resolves this directory scope to **`rbw://` (personal plane)**. This supersedes `REFERENCE_APPLICATION.md` §Secrets, which still names 1Password; that document is stale and is logged for the Phase 13 stale-paths audit.
- **AI provider:** Claude through the subscription-backed CLI, behind the Standard 9 gateway seam. No `ANTHROPIC_API_KEY` exists on this machine. A later swap to a metered key is a configuration and adapter change.
- **Authorization:** there is none. The actor header is unverified and is therefore accepted **only in LOCAL**; DEV and SANDBOX refuse every request until real authentication exists. An earlier version accepted the header in all environments and described that as fail-closed — it was the opposite, and one forged header granted full cross-tenant access. Real authentication and ownership checks land in slice 2.
- **Repository permissions:** the working copy is `chmod 700`. `/Users/Shared` is world-readable by default on macOS.

## 8. Observability

OpenTelemetry to the local collector, then Elastic.

**Traces and logs are exported.** Both carry the correlation contract fields: `deployment.environment.name`, `service.name`, `app.module`, `service.version`, `vcs.ref.head.revision`, `app.artifact.digest`, and trace context. Structured logs embed `trace_id` when a request is sampled, and omit it entirely when it is not, rather than emitting the all-zero trace id.

**Metrics are NOT exported yet.** No metric exporter is configured, so latency/traffic/error/saturation signals do not exist. This is a real gap against the observability standard, not an intentional exclusion — see §10.

Health checks and FAST synthetics are separate concerns from instrumentation and do not substitute for it.

## 9. Environments

Local, DEV, and a sandbox production-like environment — three local Docker stacks on loopback, colocated with the Elastic stack. The sandbox is not real customer production; it exists to prove release gates and bounded self-healing safely. DEV and sandbox ship in slice 5.

## 10. Known limitations (current, honest)

1. **There is no authentication and no authorization.** The actor header is unverified, so it is honoured only in LOCAL; DEV and SANDBOX refuse all traffic. Any identified LOCAL caller can read and write every project. Slice 2.
2. `archiveProject` is unimplemented. Slice 4.
3. **MCP is unreachable.** The adapter and its tools exist and are contract-tested; no stdio transport serves them to a client. Exercising it requires launching with `--mcp-config <app> --strict-mcp-config`.
4. **No metrics are emitted.** Traces and logs are exported; metrics are not. This weakens the incident journey the reference application is meant to prove.
5. No AI capability and therefore no eval suite. Slice 3. Per the mandatory eval policy, the AI capability is NOT READY until its suite exists and passes.
6. Only the local environment exists. Slice 5.
7. No release artifact identity or promotion path yet. `vcsRef` and `artifactDigest` default to the labels `unknown` and `unbuilt`. Slice 5.
8. Browser proof runs on Chromium only. No browser support matrix is declared, so behavior in other engines is untested.
9. No CSRF defense: requests are not checked for content-type or `Origin`, so a cross-origin form can write as the LOCAL development actor. Loopback binding limits the exposure; this must be closed before any non-loopback deployment.
10. The spine's static mount reaches into the Projects module's internal directory layout rather than asking the module for it. Slice 2 introduces the second module and with it a registry.

### Provenance of this list

Items 1, 3, 4, 8, 9 and 10 were found by independent fresh-context review of the slice-1 commit, not by the builder. Two reviewers ran against `f86ce82`: an adversarial code review and a browser verification. Their material findings are fixed in the follow-up commit; these entries record what remains true after those fixes.
