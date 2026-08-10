# Human Gate #1 Packet — dev → main (second promotion)

**Decision requested:** authorize the head of PR #11 to merge from `dev` into `main`.
**Requested:** 2026-08-10 · **Requested by:** foundation-lab-bot (builder identity; not the approver)

> **STATUS: APPROVED AND EXECUTED, 2026-08-10.** `959fa58` merged to `main` as `4487e58`. **Everything below is preserved exactly as the approver read it** — a gate packet is the record of what a decision was made on, so its risk list is not updated to reflect what later became true. For current state see `SPEC.md`; for what the release actually did, see `release-record-main-3.md`.

## Which exact revision this binds to

**This file deliberately does not hardcode the candidate SHA.** Two earlier versions did, and both went stale the moment they were committed: writing the SHA into the packet creates a new commit, which becomes the new head, which the packet then misnames. The second version's own opening line announced it was fixing exactly that defect while reintroducing it.

The authoritative revision is **the head commit GitHub displays on PR #11 when you approve**. That is a stronger binding than a number in a document, not a weaker one, because it is mechanically enforced: ruleset `gate1-main` requires approval of the most recent push and dismisses stale reviews, so any commit landing after your approval revokes it automatically. A frozen SHA in Markdown enforces nothing.

To confirm the candidate matches this packet before approving:

```
gh pr view 11 --repo Chaddacus/foundation-lab --json headRefOid,commits
git fetch origin && git diff --stat origin/main...origin/dev
```

## What is in it

**The slice-6 design pass** gave the application its own visual identity, constrained so the claim is testable: no TypeScript, no contract, no ARIA, no test id, no heading structure, and `foundation.css` untouched.

**The fixes for what that pass broke.** Independent adversarial review returned one blocker and four majors, all introduced by the pass and none visible to the existing suite:

- The sticky header **completely covered the focused skip link** — the first tab stop on the page — under a comment claiming it remained visible. WCAG 2.2 AA 2.4.11.
- The new row-hover background dropped success and warning badge text to **4.37–4.50:1**, below the AA threshold. Both were fine on white; introducing a surface changes what the foreground may be.
- A fixed pixel body size **froze body copy against the reader's own font-size setting** while rem headings kept scaling.
- The forced-colours justification was false: forced colours strips `box-shadow`, so the selection indicator it described did nothing.

**A new spec covering what nothing else could:** occlusion via `elementFromPoint`, contrast computed against the surface actually behind the text, root-font-size response, and forced-colours rendering.

**The fixes for what review found in those fixes** — see below.

**The release pipeline fix**, verified before this promotion rather than after it.

## Independent review has now re-run on the fixes

It found the blocker above and one major, plus four minors. Both material findings were about **evidence, not behaviour** — the fixes themselves held up under attack:

- **The forced-colours assertion could not fail.** It read only the selected row and required a bottom border wider than zero, which every row already has from the base table rule. Deleting the entire forced-colours block left all five tests green. The fix was correct; the test measured something adjacent to its own name. It now compares the selected row against an unselected one in the same render, and **fails when the rule is removed** — re-verified after the change, not assumed.
- **`SPEC.md` and the spec file both gave a false reason** for leaving `scroll-padding` untested ("no fixture page is long enough to scroll" — the page is ~1300px against a 720px viewport and scrolls). The conclusion was right and the stated reason was wrong, inside a commit whose whole premise was correcting claims stronger than the code supported.

Minors, all fixed: an undefended `position: fixed` (the real rationale is scroll behaviour, now recorded); a forced-colours `.badge` rule that was a measurable no-op and would have overridden `.badge--suggested`'s dashed AI-provenance border had stylesheet load order changed; a dead class in markup; and a contrast test whose surface list was narrower than its title.

Review also **independently reproduced** every verification number below, and confirmed the contrast fix is complete — it computed all 24 foreground/surface pairs that can occur, lowest 4.93:1.

## Evidence

- **Verification on this candidate:** types clean · 268 node tests · 44 browser tests · AI evals 20/20 recorded · CI green on Linux.
- **Reproduced independently** by the reviewer in a separate context, not merely reported by the builder.
- **The release build succeeds.** Run `31389073928` completed its `build` job dispatched on a branch, before any promotion. An earlier packet claimed this was impossible until promotion; it was not, and that risk is eliminated rather than carried.
- **Gate #2 fired and blocked correctly** for the first time on that run, waiting on the human reviewer. The run was cancelled — it was dispatched to verify the build, and a feature-branch artifact is not a deployment decision.
- **SPEC:** current, with §9a corrected, §10 at 25 items, and a duplicated stale provenance section removed.

## Risks & unknowns

1. **Sandbox-prod has never run.** Its first deployment is also its first exposure. That is Gate #2, not this one.
2. **Rollback is untested** because nothing has been deployed there to roll back to.
3. **No metrics are exported**, so post-deployment health rests on traces, logs and manual checks.
4. **AI judgement-steering is undetectable by rule** — an injected incident report can steer severity within a schema-valid, fully grounded answer.
5. **Design-pass evidence is not durably retained**; the images that found two defects are gitignored and local.
6. **Five review rounds have each found something.** This round's findings were confined to evidence quality rather than behaviour, which is the first time that has been true — but it is one data point, not a trend.
7. Everything else in SPEC §10, now 25 items.

## Rollback point

Current `main` is `3421cf17b0326b8c0087bb20927ab487c1d668f2`. Nothing has been deployed from `main`, so reverting needs no downstream unwinding.

## What YES means

The PR merges to `main` and the release workflow runs, building and attesting the artifact. **No deployment happens.** `authorize-deploy` then waits on your `sandbox-prod` approval, which is Gate #2 and a separate decision against a digest that will exist by then.

## What NO / not-yet means

The candidate stays in `dev`. Nothing is deployed and nothing is lost.

---
**Approval record:** _(unsigned — for the human approver)_
