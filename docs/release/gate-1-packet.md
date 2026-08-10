# Human Gate #1 Packet — dev → main (second promotion)

**Decision requested:** authorize exact revision `99c233d8eb230dd79094663a8964416bf9307fbb` to move from `dev` to `main`.
**Requested:** 2026-08-10 · **Requested by:** foundation-lab-bot (builder identity; not the approver)

> Re-grounded against `dev` HEAD. The previous version named a revision that was no longer the head, for a transition described as `dev → main` — approval binds to an exact revision, so a packet naming a different one is not a basis for a decision.

## The candidate

- Revision: `99c233d8eb230dd79094663a8964416bf9307fbb`
- Diff vs current `main` (`3421cf17b0326b8c0087bb20927ab487c1d668f2`): 12 files changed, 473 insertions(+), 210 deletions(-)
- 11 commits: the GHCR lowercase fix, removal of pre-gate deploy instructions, the slice-6 design pass, and the fixes for what independent review found in it.

## What is in it

**The slice-6 design pass** gave the application its own visual identity, constrained so the claim is testable: no TypeScript, no contract, no ARIA, no test id, no heading structure, and `foundation.css` untouched.

**The fixes for what that pass broke.** Independent adversarial review returned one blocker and four majors, all introduced by the pass and none visible to the existing suite:

- The sticky header **completely covered the focused skip link** — the first tab stop on the page — under a comment claiming it remained visible. WCAG 2.2 AA 2.4.11.
- The new row-hover background dropped success and warning badge text to **4.37–4.50:1**, below the AA threshold. Both were fine on white; introducing a surface changes what the foreground may be.
- A fixed pixel body size **froze body copy against the reader's own font-size setting** while rem headings kept scaling.
- The forced-colours justification was false: forced colours strips `box-shadow`, so the selection indicator it described did nothing.

**A new spec covering what nothing else could:** occlusion via `elementFromPoint`, contrast computed against the surface actually behind the text, root-font-size response, and forced-colours rendering. Mutation-checked — reintroducing each defect fails a test.

**The release pipeline fix**, verified before this promotion rather than after it.

## Evidence

- **Verification on this revision:** types clean · 268 node tests · 44 browser tests · AI evals 20/20 recorded · CI green on Linux.
- **The release build succeeds.** Run `31389073928` completed its `build` job dispatched on a branch, before any promotion. The previous packet claimed this was impossible until promotion; it was not, and that risk is now eliminated rather than carried.
- **Gate #2 fired and blocked correctly** for the first time on that run, waiting on the human reviewer. The run was cancelled — it was dispatched to verify the build, and a feature-branch artifact is not a deployment decision.
- **Independent review:** ran on the eight commits preceding these fixes; every finding is resolved above. It has **not** re-run on the fixes themselves.
- **SPEC:** current, with §9a corrected and two gaps added to §10.

## Risks & unknowns

1. **The review has not re-run on its own fixes.** Each prior round found defects the previous verification passed, and this round found four in a change I had called provably non-breaking.
2. **Sandbox-prod has never run.** Its first deployment is also its first exposure. That is Gate #2, not this one.
3. **Rollback is untested** because nothing has been deployed there to roll back to.
4. **No metrics are exported**, so post-deployment health rests on traces, logs and manual checks.
5. **AI judgement-steering is undetectable by rule** — an injected incident report can steer severity within a schema-valid, fully grounded answer.
6. **Design-pass evidence is not durably retained**; the images that found two defects are gitignored and local.
7. Everything else in SPEC §10, now 25 items.

## Rollback point

Current `main` is `3421cf17b0326b8c0087bb20927ab487c1d668f2`. Nothing has been deployed from `main`, so reverting needs no downstream unwinding.

## What YES means

`99c233d8eb230dd79094663a8964416bf9307fbb` merges to `main` and the release workflow runs, building and attesting the artifact. **No deployment happens.** `authorize-deploy` then waits on your `sandbox-prod` approval, which is Gate #2 and a separate decision against a digest that will exist by then.

## What NO / not-yet means

The candidate stays in `dev`. The most defensible reason to say not-yet is risk 1 — I can re-run independent review on the fixes first, and would not argue against it.

---
**Approval record:** _(unsigned — for the human approver)_
