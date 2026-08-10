# Human Gate #1 Packet — dev → main

**Decision requested:** authorize exact revision `05f1e93191311e4fd6113ab2f07be9195ad32d17` to move from `dev` to `main`.
**Requested:** 2026-08-10 · **Requested by:** foundation-lab-bot (builder identity; not the approver)

## The candidate

- Revision: `05f1e93191311e4fd6113ab2f07be9195ad32d17` ("Slice 5: release artifact, DEV and sandbox stacks, operator provisioning")
- Diff vs current `main` (`a20b820828ffff7f7fdb63bf11e6da7fd78d83f0`):  26 files changed, 874 insertions(+), 39 deletions(-)
- This is the whole of slices 1–5. `main` currently holds slice 3 and has never received slices 4–5.

Functional summary in plain language: a project and change-management application with
authenticated, per-customer isolated access. Users sign in; each customer sees only its own
projects, releases, incidents and users. Projects can be created, edited and archived;
releases record what was built and where it went; incidents can be reported and analysed by
a Claude-backed triage capability whose output is advisory and clearly labelled as
interpretation. The same capabilities are reachable over HTTP and over MCP.

Included, one line each:

- Slice 1 — application spine and Projects capability, with OpenTelemetry correlation.
- Slice 2 — authentication, session management, and per-customer authorization.
- Slice 3 — Incidents module and AI Incident Triage with a mandatory eval suite.
- Slice 4 — project archive, built through the parallel-worktree journey.
- Slice 5 — release artifact identity, DEV and sandbox-prod stacks.
- Plus three rounds of independent-review fixes, listed under Review below.

## Evidence

- **DEV deployment:** `foundation-lab-dev` on 127.0.0.1:4320, running artifact
  `foundation-lab@sha256:a56ad282e6afa2b9e985a2c1db61effe950b0ab2b37e7d92e351c5340bf4209a`.
  `/api/meta` on the live deployment reports that exact digest, revision `05f1e93`, version
  `0.5.0` — confirmed, not assumed.
- **Verification run on this revision:** types clean; 268 node tests; 39 browser tests;
  AI eval suite 20/20 recorded and 6/6 live. Commands are declared in
  `.claude/verification.json`.
- **Live telemetry:** DEV spans in Elastic carry `deployment.environment.name=DEV`,
  `service.version=0.5.0`, `vcs.ref.head.revision=05f1e93` and the artifact digest, so any
  signal from this deployment can be joined back to this candidate.
- **Review:** three independent fresh-context adversarial reviews (slices 1, 2, 3) plus one
  browser verification. All material findings fixed and re-verified; the fixes are their own
  commits. Residuals are in SPEC §10.
- **SPEC:** current as of this revision.

## Risks & unknowns

Not empty, and not softened:

1. **No metrics are emitted.** Traces and logs only. This weakens the incident journey the
   application exists to prove.
2. **An injected incident report can steer the AI's judgement** within its output contract.
   Format subversion is refused; a plausible-but-steered severity is not detectable by any
   deterministic rule. The assessment is advisory and never changes state.
3. **Login cost is bounded per email address, not globally.** Many distinct addresses can
   still consume hashing capacity.
4. **The `__Host-` cookie prefix is not set.** Not reachable on loopback; required before any
   non-loopback exposure.
5. **Browser proof is Chromium-only.** No support matrix is declared.
6. **The sandbox-prod environment has never run.** Its stack is defined and its configuration
   validates, but no release has been deployed to it — that is Gate #2, deliberately not done.
7. Slices 1–3 were committed directly to `main` before the branch model was corrected in
   slice 4, so `main`'s history does not reflect the dev-first flow for those slices.

Full list: SPEC §10, 21 items.

## Rollback point

Current `main` is `a20b820828ffff7f7fdb63bf11e6da7fd78d83f0`. If this promotion is wrong, reset `main` to that revision.
No deployment has occurred from `main`, so nothing downstream needs unwinding.

## What YES means

`05f1e93191311e4fd6113ab2f07be9195ad32d17` merges to `main`. **No production deployment happens from this approval** —
deploying to sandbox-prod is Gate #2 and is requested separately.

## What NO / not-yet means

The candidate stays in `dev` and nothing changes. If the answer is not-yet, the most likely
blockers are risk 1 (no metrics) and risk 6 (sandbox-prod unexercised); both are addressable
without altering the candidate's application behavior.

---
**Approval record:** _(unsigned — to be completed by the human approver)_
approved by \<human\> on \<date\> for exactly `05f1e93191311e4fd6113ab2f07be9195ad32d17` → `main`.
Any material change to the candidate voids this approval.
