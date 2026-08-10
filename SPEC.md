# SPEC.md — Foundation Lab

**Status:** slice 3 in progress (Incidents, AI Incident Triage). This file is the canonical current specification for this repository. Documentation under `docs/` is subordinate to it. Historical plans and handoffs do not outrank this file or the live system.

## 1. Purpose

Foundation Lab is a compact project/change-management application. It is a qualification instrument for the Claude Engineering Foundation (Phase 11). It must be small enough to break deliberately and complete enough to exercise all ten Standards.

Foundation Lab is not a customer product. It carries no real customer data.

## 2. Accepted requirements (source: `REFERENCE_APPLICATION.md`)

Capability modules, in build order:

| Module | Slice | Status |
|---|---|---|
| Projects | 1 | built; tenant-authorized in slice 2 |
| Customers | 2 | built |
| Releases | 2 | built |
| Incidents | 3 | built |
| AI Triage (Incident Triage) | 3 | built, evaluated |

Slice plan ratified 2026-08-09. A checkpoint with the human approver follows slice 1.

## 3. Architecture

Spine plus capability modules (Standard 2).

```
src/
  spine/          application-wide coordination only
  modules/
    customers/    customers, users, authentication, sessions
    projects/     project lifecycle
    releases/     release candidates and their lifecycle
    incidents/    operational incidents, with an Elastic Case reference
    triage/       AI incident assessment (no storage of its own)
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

**MCP is served over stdio** by `src/spine/mcp-main.ts`, a process entry point peer to `main.ts` over the same module contracts. It is proven against a real `@modelcontextprotocol/sdk` client in `tests/contract/mcp-transport.test.ts`, including that tenant isolation survives the transport.

Authority model: the server authenticates ONCE at startup with a real credential and acts as exactly that user for every call. It cannot become another user, cannot escalate, and exposes no login, provisioning, or admin tool. It refuses to start without a credential rather than falling back to an anonymous identity.

## 4. Module contracts

### 4.0 Customers (`src/modules/customers/`)

Owned data: `customers`, `users`, `sessions`. No other module reads or writes them.

| Capability | Notes |
|---|---|
| `login` | the only capability accepting a credential; one of three public routes |
| `resolveSession` | the spine's authentication hook |
| `logout` | idempotent |
| `getCustomer` | the caller's own customer only |
| `listUsers` | the caller's customer only |

`provisionCustomer` and `provisionUser` exist on the service but are **exposed by no adapter**: slice 2 has no admin role, so no authenticated caller may create tenants or accounts. They are used by the local seed and by tests.

### 4.1 Projects (`src/modules/projects/`)

Owned data: the `projects` table. No other module writes it.

| Capability | Slice | Notes |
|---|---|---|
| `createProject` | 1 | validates the name; ownership comes from the session |
| `getProject` | 1 | by id |
| `listProjects` | 1 | |
| `updateProject` | 1 | name and description |
| `archiveProject` | 4 | deferred deliberately — it is the `feature/project-archive` worktree journey |

Project lifecycle status: `active` → `archived`. Slice 1 creates projects in `active` only; the transition ships in slice 4.

Ownership is taken from the authenticated session, never from a request body. `CreateProjectInput` has no `customerId` field at all, so a client cannot assign a project to another tenant.

### 4.2 Releases (`src/modules/releases/`)

Owned data: the `releases` table.

| Capability | Notes |
|---|---|
| `createRelease` | authorized by looking the project up through the Projects capability |
| `getRelease` | caller's tenant only |
| `listReleasesForProject` | caller's tenant only |
| `setReleaseStatus` | lifecycle transitions enforced by the domain |

Release lifecycle: `pending` → `deployed` → (`verified` \| `rolled_back`). `verified` and `rolled_back` are terminal — release status is evidence about what is running, and evidence that can be rewritten backwards is not evidence.

Releases does **not** read the projects table. It calls `ProjectsCapability.getProject`, which already applies the tenant rule, so that rule has exactly one owner.

### 4.3 Incidents (`src/modules/incidents/`)

Owned data: the `incidents` table.

| Capability | Notes |
|---|---|
| `createIncident` | title, free-text report, severity of record |
| `getIncident` / `listIncidents` | caller's tenant only |
| `updateIncident` | the ONLY path that changes severity or status of record |

`caseRef` holds an Elastic Case identifier and is nullable — `null` means "no Case yet", not "unknown". **Incidents are stored here, not read live from Kibana** (decision, 2026-08-10): the live Cases wiring lands with the Phase 12 drills, where Cases-as-incident-truth is what gets exercised. Storing a reference now makes that an adapter change rather than a remodelling.

A resolved incident cannot be reopened; the transition is refused rather than silently allowed.

### 4.4 Incident Triage (`src/modules/triage/`)

An AI capability with **no storage of its own** and no MCP tool. Contract: `docs/ai-capability-incident-triage.md`. Eval suite: `docs/eval-suite-incident-triage.md`.

`assessIncident` returns either a fully validated assessment or `unavailable` with a reason — never anything partial. **It cannot change an incident.** Severity and status of record move only through the Incidents capability, so the model proposes and deterministic software disposes.

Authorization is inherited, not reimplemented: the incident lookup happens before the prompt is composed, so a caller who cannot see an incident cannot even cause a model call.

Deliberately not exposed over MCP: an MCP client able to invoke triage could spend the subscription budget this capability is metered against, and that would need its own budget authority.

## 5. Data ownership and storage

SQLite via the built-in `node:sqlite` module. One file per environment, path from configuration. Chosen because it is real persistent storage with zero added dependency.

Each module owns a persistence abstraction over its own tables. Schema migrations live with the owning module.

## 6. Verification

Tier commands are declared in `.claude/verification.json`. FAST is a cheap breadth heartbeat. MODULE deeply verifies the affected capability. FULL is for release and architecture change.

Meaningful frontend work requires browser-grounded proof, and the evidence must be inspected, not merely produced.

## 7. Security and trust boundaries

- **Data classes present:** slice 2 introduces credentials, so INTERNAL is no longer the whole picture.
  - **RESTRICTED:** password verifiers, session identifiers, the session signing secret. MUST NOT appear in logs, telemetry, capability responses, screenshots, or test artifacts.
  - **CONFIDENTIAL:** user records (email, customer, role).
  - **INTERNAL:** projects, releases, deployment identity.

  Foundation Lab still holds no real customer records; the classes describe how the code must behave so the qualification exercises the real rules. `User` deliberately has no verifier field, so a verifier cannot leave the module even by accident — asserted in `tests/integration/authorization.test.ts`.
- **Secrets:** the repository stores secret **references**, never values. This machine's backend map (`global/secrets-backends.json`) resolves this directory scope to **`rbw://` (personal plane)**. This supersedes `REFERENCE_APPLICATION.md` §Secrets, which still names 1Password; that document is stale and is logged for the Phase 13 stale-paths audit.
- **AI provider:** Claude through the subscription-backed CLI, behind the Standard 9 gateway seam. No `ANTHROPIC_API_KEY` exists on this machine. A later swap to a metered key is a configuration and adapter change.
- **Authentication:** session-based. Passwords are hashed with scrypt (`node:crypto`); the session id is 256 bits, stored server-side, and carried in an `HttpOnly`, `SameSite=Strict` cookie signed with an HMAC. `Secure` is set in every environment except LOCAL, which is plain HTTP on loopback. Three routes are public: `POST /api/session` (login), `DELETE /api/session` (sign-out, public so an expired session can still clear its cookie), and `GET /api/session` (which answers `{authenticated:false}` for an anonymous caller and queries nothing). **Login is the only public route that accepts a credential.** Every other route is protected, and `public` defaults to false so a new route is protected unless it opts out. The exact public set is pinned by a test. The unverified actor header from slice 1 is **deleted**.
- **Authorization:** every capability is scoped to the caller's customer, enforced in the module service so HTTP and MCP inherit it identically. A resource belonging to another customer returns `not_found`, never `forbidden` — `forbidden` would confirm the id exists. Threat model: `docs/threat-model-authn-authz.md`.
- **CSRF:** `SameSite=Strict` plus a required `application/json` content type on state-changing requests, which a cross-site HTML form cannot send.
- **Audit:** authentication routes are marked `audit` in the route table, so every sign-in and every refusal is logged with the user id, outcome, and trace id. The attempted email's **presence** is recorded, never its value, so the log cannot become a list of who was targeted.
- **Login cost is bounded** per email address, for unknown addresses as well as known ones — scrypt blocks Node's only thread, so unbounded hashing was a denial-of-service path. See §10 for what remains unbounded.
- **Session secret:** LOCAL generates an ephemeral key at startup; DEV and SANDBOX **refuse to start** without one supplied at runtime from the secret backend. There is no default key.
- **Repository permissions:** the working copy is `chmod 700`. `/Users/Shared` is world-readable by default on macOS.

## 7a. AI engineering

- **Gateway seam:** `src/spine/ai-gateway.ts` is the only code that knows how a provider is invoked. Modules depend on the `AiGateway` interface. Today it shells the subscription-backed Claude CLI (D1: no API key exists on this machine); swapping to a metered key is a change inside the gateway plus configuration.
- **Model:** `claude-haiku-4-5-20251001` — the least expensive adequate model.
- **Architecture rung:** one call. No retrieval (all facts are supplied), no tools (the capability answers, it does not act).
- **Mandatory evals:** the `triage` module carries `"ai_eval": true` in `.claude/verification.json`. The suite runs inside the normal test run against a **recorded provider**, so routine verification spends no subscription capacity. Live runs are opt-in (`FL_EVAL_PROVIDER=live`) and capped at **40 provider calls per run, enforced in the runner**, per the budget approved on 2026-08-10.
- **Grounding is structural:** an assessment citing evidence that was not supplied, or naming a capability that does not exist, is rejected. That check is what makes "grounded" mean something rather than being a promise in a prompt.
- **Versioned behavior:** prompt, model, schema, validation, and fallback changes are behavioral software changes and run the suite before promotion. Current prompt version `triage-prompt-v2`.

## 8. Observability

OpenTelemetry to the local collector, then Elastic.

**Traces and logs are exported.** Both carry the correlation contract fields: `deployment.environment.name`, `service.name`, `app.module`, `service.version`, `vcs.ref.head.revision`, `app.artifact.digest`, and trace context. Structured logs embed `trace_id` when a request is sampled, and omit it entirely when it is not, rather than emitting the all-zero trace id.

**Metrics are NOT exported yet.** No metric exporter is configured, so latency/traffic/error/saturation signals do not exist. This is a real gap against the observability standard, not an intentional exclusion — see §10.

Health checks and FAST synthetics are separate concerns from instrumentation and do not substitute for it.

## 9. Environments

Local, DEV, and a sandbox production-like environment — three local Docker stacks on loopback, colocated with the Elastic stack. The sandbox is not real customer production; it exists to prove release gates and bounded self-healing safely. DEV and sandbox ship in slice 5.

## 10. Known limitations (current, honest)

1. `archiveProject` is unimplemented. Slice 4.
2. **No admin role.** Every user has identical rights within their customer. Tenant and account provisioning is reachable only from the local seed, not over any adapter.
3. The MCP server acts as a single hard-coded user chosen at startup. Per-caller identity over MCP needs an authority model that does not exist yet, and is not required before slice 5.
4. **No metrics are emitted.** Traces and logs are exported; metrics are not. This weakens the incident journey the reference application is meant to prove.
5. No AI capability and therefore no eval suite. Slice 3. Per the mandatory eval policy, the AI capability is NOT READY until its suite exists and passes.
6. Only the local environment exists. Slice 5.
7. No release artifact identity or promotion path yet. `vcsRef` and `artifactDigest` default to the labels `unknown` and `unbuilt`. Slice 5.
8. Browser proof runs on Chromium only. No browser support matrix is declared, so behavior in other engines is untested.
9. The spine's static mount still reaches into each module's internal `ui/` directory rather than asking the module for it, and `buildApp` still edits in four places per module. Now that three modules exist, a registry is justified and is the first refactor of slice 3.
10. Authentication carries no password policy, reset flow, or multi-factor option, and only login is rate limited. Accepted for a qualification instrument with no real users; recorded in the threat model's residual risks.
11. Sessions live in the application database, so horizontal scaling would need a shared store. Single-instance by design through slice 5.
12. **Login cost is bounded per email address, not globally.** An attacker using many distinct addresses can still consume scrypt capacity, because `scryptSync` blocks Node's only thread. A work queue or upstream rate limit belongs with slice 5.
13. The `__Host-` cookie prefix is not set, so cookie injection from a sibling host is not closed. Not reachable on loopback; required before DEV or SANDBOX are exposed.
14. There is no audit log retention or review process — outcomes are emitted, nothing consumes them yet.
15. **Incidents carry a Case reference but no live Kibana integration.** Deliberate for slice 3; the wiring lands with the Phase 12 drills.
16. **Triage evidence is derived from the incident report's own paragraphs.** There is no trace, log, or Case context yet, so grounding is real but narrow. Phase 12 adds further evidence sources without changing the contract.
17. **The live eval suite covers only model-judgement cases** — 6 of 19. Cases that depend on a fabricated provider response cannot be produced by a real provider on demand, and running them live would convert real coverage into unearned passes.
18. **No regression eval cases exist**, because no production escape has occurred. One is added per escape, per the standard.
19. Triage has no MCP tool, so an MCP client cannot request an assessment. Deliberate — it would need its own budget authority.

### Provenance of this list

Items in this list were found by independent fresh-context review of the slice-1 and slice-2 commits, not by the builder. Slice 2's review contributed items 12 and 13, and drove fixes for a malformed-cookie 500, an untested cookie signature check, missing authentication audit logging, an unbounded login-hashing path, and an MCP tool schema that still demanded the owning tenant.

### Provenance of this list

Items 1, 3, 4, 8, 9 and 10 were found by independent fresh-context review of the slice-1 commit, not by the builder. Two reviewers ran against `f86ce82`: an adversarial code review and a browser verification. Their material findings are fixed in the follow-up commit; these entries record what remains true after those fixes.
