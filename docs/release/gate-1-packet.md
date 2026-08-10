# Human Gate #1 Packet — dev → main (second promotion)

**Decision requested:** authorize exact revision `98a16909a3d542076c5c69717abccff367615129` to move from `dev` to `main`.
**Requested:** 2026-08-10 · **Requested by:** foundation-lab-bot (builder identity; not the approver)

## The candidate

- Revision: `98a16909a3d542076c5c69717abccff367615129`
- Diff vs current `main`: 8 files changed, 189 insertions(+), 87 deletions(-)
- Six commits: the GHCR lowercase fix, removal of pre-gate deploy instructions, and the slice-6 design pass.

## What changed and why

**The first promotion earned its keep immediately.** The release workflow ran for the first time and failed — `repository name must be lowercase`, because `github.repository` preserves the owner's capitalisation. That was the risk this packet previously listed as *"the release workflow has never executed"*. It executed and was broken. Fixed here.

Also removed: a leftover step that printed the sandbox deploy procedure **inside the build job**, before the gate and carrying the bad image reference. Printing deploy instructions ahead of the approval implies the deployment can proceed without it.

**The slice-6 design pass** gave the application its own visual identity, deliberately constrained so the claim is testable: no TypeScript, no contract, no ARIA, no test id, no heading structure, and `foundation.css` untouched. The only markup change is `card` added to three `class` attributes. The same suite passes unchanged before and after.

## Evidence

- **Verification on this revision:** types clean · 268 node tests · 39 browser tests · AI evals 20/20 recorded · CI green on Linux.
- **DEV:** running the previous artifact; this candidate has not been deployed anywhere. That is expected — deployment is Gate #2.
- **Review:** the design pass was self-reviewed against a before/after comparison, which found two defects no test covers (see Risks). No independent adversarial review has run on these six commits.

## Risks & unknowns

1. **No independent review of this candidate.** Slices 1–3 each had one and each found defects my own verification passed. These six commits have not.
2. **The release workflow's fix is unverified.** It cannot run until it reaches `main`, which is what this approval does. If the lowercase fix is wrong, the next run fails the same way — with no production consequence, since the deploy job is gated behind Gate #2 and cannot start.
3. **Two defects in the design pass were caught only by looking**: a focus ring the same hue as the accent, and a dropped card measure leaving one form stretched across the full page. Both fixed. Both indicate that visual regressions here are not covered by assertions.
4. Everything in SPEC §10 (23 items) still stands, including no metrics exported and AI judgement-steering being undetectable by rule.

## Rollback point

Current `main` is `3421cf17b0326b8c0087bb20927ab487c1d668f2`. Nothing has been deployed from `main`, so reverting needs no unwinding downstream.

## What YES means

`98a16909a3d542076c5c69717abccff367615129` merges to `main` and the release workflow runs — building the artifact to GHCR with provenance attestation, for the first time successfully if the fix is right. **No deployment happens.** The `authorize-deploy` job will then wait on your `sandbox-prod` approval, which is Gate #2.

## What NO / not-yet means

The candidate stays in `dev`. The most defensible reason to say not-yet is risk 1 — I can run an independent adversarial review on these six commits first, and would recommend it if you want the same standard applied here as to slices 1–3.

---
**Approval record:** _(unsigned — for the human approver)_
