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
    projects/     domain, persistence, contract, adapters, tests
  web/            static frontend assets served by the spine
```

### 3.1 Spine ownership

The spine owns, and owns only: process bootstrap, configuration loading and validation, dependency registration, top-level route composition, the global error boundary, and OpenTelemetry initialization. The spine MUST NOT hold business logic.

### 3.2 Module ownership

Each module owns its domain behavior, its persistence abstraction, its internal implementation, its feature-specific validation, its public capability contract, and its own tests.

Cross-module consumers use the public contract only. They do not reach into module internals and do not mutate another module's tables.

### 3.3 API/MCP first

Business capabilities are implemented once in the module. HTTP/REST and MCP are adapters over the same contract. Business logic MUST NOT be duplicated between them. A contract-parity test enforces this.

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
- **Authorization:** the authorization boundary is a spine-registered seam in slice 1 and is implemented against real customer ownership in slice 2. Slice 1 MUST NOT be read as having a tested authorization model.
- **Repository permissions:** the working copy is `chmod 700`. `/Users/Shared` is world-readable by default on macOS.

## 8. Observability

OpenTelemetry to the local collector, then Elastic. Every signal carries the correlation contract fields: `deployment.environment.name`, `service.name`, `app.module`, `service.version`, `vcs.ref.head.revision`, `app.artifact.digest`, and W3C trace context.

Health checks and FAST synthetics are separate concerns from instrumentation and do not substitute for it.

## 9. Environments

Local, DEV, and a sandbox production-like environment — three local Docker stacks on loopback, colocated with the Elastic stack. The sandbox is not real customer production; it exists to prove release gates and bounded self-healing safely. DEV and sandbox ship in slice 5.

## 10. Known limitations (current, honest)

1. Authorization is a seam, not an implementation. Slice 2.
2. `archiveProject` is unimplemented. Slice 4.
3. No AI capability and therefore no eval suite. Slice 3. Per the mandatory eval policy, the AI capability is NOT READY until its suite exists and passes.
4. Only the local environment exists. Slice 5.
5. No release artifact identity or promotion path yet. Slice 5.
