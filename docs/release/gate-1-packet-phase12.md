# Human Gate #1 Packet — dev → main (Phase 12 incident repair)

**Decision requested:** authorize the head of the Gate #1 PR to merge from `dev` into `main`.
**Requested:** 2026-08-10 · **Requested by:** foundation-lab-bot (builder identity; not the approver)

(The previous gate's record is `gate-1-packet.md`, frozen and marked executed. This is a new decision.)

## Which revision this binds to

This packet deliberately does not hardcode the candidate SHA. It binds to **the head commit GitHub shows on the Gate #1 PR when you approve**, enforced by the `gate1-main` ruleset (approval of the most recent push; stale reviews dismissed). Confirm before approving:

```
gh pr view <n> --repo Chaddacus/foundation-lab --json headRefOid
git fetch origin && git diff --stat origin/main...origin/dev
```

At preparation time `dev` is `71d37b5`, 17 commits ahead of `main` (`4487e58`), 37 files, +1316/−182.

## What is in it

The repair for the Phase 12 incident, plus the Phase 11 post-release cleanup that landed on `dev` but was never promoted.

**The incident (Elastic Case, SEV-1).** A flood of unauthenticated logins with distinct email addresses degraded authenticated reads on sandbox-prod from ~5 ms to a **~1.66 s median**. Root cause was a disclosed limitation (SPEC §10 item 7) realised: per-email throttling plus `scryptSync` blocking the single Node thread.

**The fix, at root cause.** Password hashing moved off the main thread (async scrypt) so a flood no longer freezes unrelated requests, plus a global hash-concurrency gate that sheds excess as a retryable 503. The distinct-address residual §10 item 7 left open is now bounded.

**Two concurrency blockers the fix itself introduced, then fixed.** Independent review (round seven) found the sync→async rewrite broke two atomicity properties the synchronous code had for free: the account lockout (a stale-read race meant the failure counter never advanced under concurrency) and the per-email throttle (a check-then-count straddling the await was bypassed by concurrent arrivals). Both are now atomic — an SQL increment, and an atomic reserve-with-refund. A third issue I caught myself — the throttle initially punished legitimate repeated logins — is fixed by refunding the slot on success.

**A bounded rollback runbook**, DEV-tested (FND-042/043): fail-closed on a missing reviewer or absent target, and a real armed rollback that executed and verified. It refuses to arm against production because it has no independent reviewer — the honest L4 state.

**Phase 11 cleanup carry-over:** the backup/restore procedure (proved by restoring), the operator-procedure CI fix, and the release-record reconciliation.

## Evidence

- **Verification on this candidate:** types clean · **275 node tests** · **44 browser tests** · AI evals 20/20 recorded · CI green on Linux.
- **Original-failure retest** on the fixed artifact in DEV: victim read median **2.1 ms** under the same flood (was 1.66 s).
- **Both blockers re-verified over real HTTP:** 30 concurrent wrong guesses lock the account; 60 concurrent correct logins admit exactly 10.
- **Independent review:** two rounds. Round seven found both blockers; round eight **approved with one minor** (a pre-existing lockout-DoS, now disclosed), and mutation-verified all four new tests.

## Risks & unknowns

1. **The fix has not run on sandbox-prod.** Deploying it there is Gate #2, and it is the production repair the incident actually needs — until then, sandbox still runs the vulnerable `main-3`.
2. **The global shed is blunt:** under sustained flood it can shed legitimate logins. Disclosed in SPEC §10 item 7.
3. **`login` can now return 503** — a new outcome in its public contract, identical for known and unknown emails (not an oracle).
4. **Account lockout is a per-victim DoS** (five wrong passwords lock a known email 15 min). Pre-existing, not changed here, now disclosed.
5. **The artifact is amd64 on an arm64 host** (emulated), and everything else in SPEC §10.

## What YES means

The PR merges to `main` and the release workflow builds and attests a new artifact carrying the fix. **No deployment happens.** Gate #2 then waits on your `sandbox-prod` approval to deploy it — that is the production repair, and a separate decision against a digest that will exist by then.

## What NO / not-yet means

The candidate stays in `dev`. Sandbox continues to run the vulnerable artifact; the incident's production exposure remains until Gate #2.

---
**Approval record:** _(unsigned — for the human approver)_
