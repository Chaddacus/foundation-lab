# Release Record — `main-4` (Phase 12 incident repair)

Durable provenance for the second release through both human gates: the fix for the Phase 12 SEV-1 login-flood incident. Companion to `release-record-main-3.md`.

**State: CLOSED** — 2026-08-10, on the merge of this record.

## Identity

| | |
|---|---|
| Service version | `main-4` |
| Source revision | `ce2c01fe762fcb203d11b5e3f2112215bcb76c1f` (`main`) |
| Artifact | `ghcr.io/chaddacus/foundation-lab@sha256:b2fb7f92f242cf186a2991b0be6c51a22f7ff07b0c1bd495d22a3a0cb4a1ab1b` |
| Attestation | SLSA v1 · built by `release.yml@refs/heads/main` · source `ce2c01f` · GitHub-hosted · verified against the repo |
| Platform | `linux/amd64` (emulated on the arm64 host) — SPEC §10 item 26 |

## The incident

Elastic Case (SEV-1): a flood of unauthenticated logins with distinct email addresses degraded authenticated reads on sandbox-prod from ~5 ms to a **~1.66 s median**. Root cause was SPEC §10 item 7 realised — per-email throttling plus `scryptSync` blocking the single Node thread. Detection finding kept in the Case: the first alert rule watched span *duration* and could not see event-loop queuing; corrected to the login-volume signal.

## Approvals

| Gate | Transition | Authorized | Evidence |
|---|---|---|---|
| #1 | `dev` → `main` | head `9091536`, approved 2026-08-10; merged as `ce2c01f` | ruleset `gate1-main` (PR, 1 review, last-push approval, stale dismissal, `verify` required, no bypass) |
| #2 | `main` → sandbox-prod | artifact `sha256:b2fb7f92…` on run `31417116912` | `sandbox-prod` environment required reviewer; `authorize-deploy` held until approved |

Both recorded by the assistant under explicit authorization from the approver (Chad Simon, repo owner). The `foundation-lab-bot` builder identity performed the merges but cannot supply an approving review — the property enforced by GitHub, stated precisely per the `main-3` correction.

## Verification

- Candidate: types clean · **275 node** · **44 browser** · evals **20/20** recorded · CI green.
- Two independent review rounds: round 7 found two concurrency blockers the async rewrite introduced (lockout TOCTOU; throttle bypass); round 8 **approved with one minor** (a pre-existing lockout-DoS, now disclosed) and mutation-verified all four new tests.
- Both blockers re-verified over real HTTP: 30 concurrent wrong guesses lock the account; 60 concurrent correct logins admit exactly 10.

## Live verification (the production repair)

- Backup of the vulnerable `main-3` taken and verified **before** deploying.
- Deployed to sandbox-prod; `verify-deployment.ts` **4/4**, reports `SANDBOX main-4 @ ce2c01f` — the digest check discriminates (falsified against a wrong digest earlier in the release line).
- **Original-failure retest on the repaired production env**, same flood (2988 attempts): victim read median **3.8 ms** under load, worst 13.1 ms — versus the 1.66 s that opened the Case.
- Elastic carries `main-4 @ ce2c01f` on live sandbox spans: the repair joins end to end — alert → Case → fix → gates → artifact → running process → trace.

## What shipped

The login-flood fix (async hashing + global shed gate), a DEV-tested bounded rollback runbook, and the Phase 11 cleanup carry-over (backup/restore, operator-procedure CI fix, `main-3` reconciliation).

## Residuals at release (disclosed, SPEC §10)

1. The global shed is blunt — under sustained flood it can shed legitimate logins.
2. `login` can return 503, a new outcome in its public contract (identical for known/unknown emails).
3. The per-account lockout is a per-victim DoS (five wrong passwords lock a known email 15 min) — pre-existing, not changed here.
4. amd64-on-arm64 emulation; no metrics exported; the loopback/synthetic-data framing that makes all of the above acceptable.

## Cleanup

Branches deleted both sides; both gate PRs (#17, #18) and the packet PR (#19) merged; the Gate #1 PR (#20) merged. Verification accounts left in the DEV/sandbox databases are synthetic loopback data. Session secrets and probe passwords scrubbed from the session scratchpad. This record is the retained provenance; the workflow run will expire.
