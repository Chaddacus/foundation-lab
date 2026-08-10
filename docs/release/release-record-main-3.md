# Release Record — `main-3`

The retained provenance for the first release that passed both human gates. It exists so the release can be reconstructed and audited without reading a chat log, a workflow run that will expire, or a handoff that is a claim rather than truth.

**State: CLOSED** — 2026-08-10, on the merge of the reconciliation that contains this document. Until that merge it was IN CLEANUP: the governing checklist makes CLOSED contingent on documentation reconciliation completing, and an unmerged document asserting its own precondition is not evidence. Independent review caught the earlier version doing exactly that.

## Identity

| | |
|---|---|
| Service version | `main-3` |
| Source revision | `4487e5879d3989bd028f05c4a07380ef28c30684` (`main`) |
| Artifact | `ghcr.io/chaddacus/foundation-lab@sha256:7cad7e5d0a4b9ef9743ca17740aeac193c584173fa3056f36e8a9f0ef32b3f60` |
| Attestation | SLSA v1 predicate · built by `release.yml@refs/heads/main` · GitHub-hosted runner · verified against this repository |
| Platform | `linux/amd64` only — see limitation 26 |

## Approvals

| Gate | Transition | Authorized | Evidence |
|---|---|---|---|
| #1 | `dev` → `main` | head `959fa58`, approved 13:50:23Z; merged as `4487e58` at 13:52:18Z | ruleset `gate1-main`: PR required, one approving review, stale reviews dismissed, last-push approval, `verify` required, no bypass actors |
| #2 | `main` → sandbox-prod | artifact digest `sha256:7cad7e5d…` | `sandbox-prod` environment required reviewer; `authorize-deploy` on run `31395109475` held until approved |

Builder and approver are separate identities. The `foundation-lab-bot` App pushed every branch, opened every pull request, and merged into `dev`.

**Stated precisely, because the first version of this line was wrong:** the bot **cannot supply the approving review**, and `gate1-main` requires one, so it cannot promote anything unapproved. It **can** perform the merge once approval exists, and it did — PR #11 was merged to `main` by `foundation-lab-bot[bot]` after `Chaddacus` approved head `959fa58`. The earlier claim that it "cannot merge to `main`" and that "both halves are enforced by GitHub" was false, and the release this document records is what disproved it. Independent review found it by checking the release against the claim. See SPEC §10 item 29 for two further residual weaknesses in the approver's position.

## Verification at promotion

- Types clean · 268 node tests · 44 browser tests · AI evals 20/20 recorded · CI green on Linux.
- Independently reproduced by a fresh-context reviewer, not only reported by the builder. **The review transcripts are not retained in this repository** — the findings are recorded in commit messages, gate packets, and this document, but a future auditor cannot re-read the reviews themselves. That is a gap in a record whose stated purpose is auditability without a chat log.
- DEV ran the released artifact and was verified against it **before** Gate #2 was brought to the approver, because the Gate #2 packet requires exactly that and it had not been done.

## Live verification

The exact invocation, because the bare command does not prove this and the earlier version of this section cited one that does not exist in any recorded form:

```
FL_EXPECT_DIGEST=ghcr.io/chaddacus/foundation-lab@sha256:7cad7e5d0a4b… \
FL_EXPECT_REVISION=4487e5879d3989bd028f05c4a07380ef28c30684 \
FL_VERIFY_EMAIL=<account provisioned in that environment> \
FL_VERIFY_PASSWORD=<its password> \
node scripts/verify-deployment.ts http://127.0.0.1:4330

PASS  shell is served                                  200
PASS  capabilities refuse an unauthenticated caller    401
PASS  session probe answers without authentication     authenticated:false
PASS  release identity matches what was deployed       SANDBOX main-3 @ 4487e5879d3989bd028f05c4a07380ef28c30684
```

**Falsified before trusted, against sandbox itself:**

| Control | Result |
|---|---|
| wrong digest | FAIL — names running `sha256:7cad7e5d…` vs authorized `sha256:0000…` |
| wrong revision | FAIL — names running `4487e587…` vs authorized `0000…` |
| no expectations supplied | SKIPPED, not PASS — and the run exits non-zero |

The third row is a fix, not a design. The expectations were optional, so the identity check could report PASS having compared nothing, and every recorded form of the command — `.claude/verification.json`, the Gate #2 packet, and the procedure `authorize-deploy` prints to the operator — omitted them. A 4-of-4 result was therefore achievable while proving only that sign-in worked. Independent review found it; the script now fails closed and all three recorded forms carry the expectations.

DEV was re-verified against the same full identity after review found it had been deployed with a different `service.version` and a truncated revision, so its spans did not join to `main-3`. Both environments now report `main-3 @ 4487e5879d…`.

Telemetry from the live sandbox carries the correlation contract, joining the trace back to the approval:

```
deployment.environment.name  SANDBOX
service.name                 foundation-lab
service.version              main-3
vcs.ref.head.revision        4487e5879d3989bd028f05c4a07380ef28c30684
app.artifact.digest          ghcr.io/chaddacus/foundation-lab@sha256:7cad7e5d0a4b…
app.module                   spine · customers        (span level)
```

## What review found on the way through

Five independent adversarial review rounds ran across this work. **Every round found defects the preceding verification had passed.** The rounds covering this release found:

- a focused skip link completely hidden behind a sticky header — the first tab stop on the page, under a comment claiming it stayed visible;
- badge text below AA contrast on a newly introduced hover surface;
- a body font size that froze against the reader's own setting;
- a forced-colours justification describing a mechanism forced colours deletes;
- **a Gate #1 packet naming a revision that was not the head**, in a version whose opening line announced it was fixing that exact defect;
- **a forced-colours assertion that could not fail**, which two commits and one gate packet had cited as "mutation-checked".

The last two were about *evidence*, not behaviour: the fixes held up under attack, the proof that they held up did not.

## Known-weak at release

Carried deliberately and disclosed to the approver before the decision, not discovered afterwards:

1. The artifact is `linux/amd64` and the host is `arm64`, so DEV and sandbox both run it emulated. Release identity holds for the bytes; the execution environment is not the one the artifact was built for.
2. Rollback has never been exercised — there was no previous artifact to roll back to.
3. No backup existed before the first deployment. From here on, the volume `foundation-lab-sandbox_sandbox-data` is what to snapshot, and that procedure does not yet exist.
4. No metrics are exported; post-deployment health rests on traces, logs and manual checks.
5. The DEV session secret is still not resolved from the secret backend (limitation 27). SANDBOX's is.
6. **Neither environment can be re-verified from recorded material** (limitation 28): the verification accounts exist only in those environments' databases, and their passwords are in neither the repository nor the backend.
7. `sandbox-prod` allows admin bypass and does not prevent self-review, and the approver is the repository owner (limitation 29). Neither was exercised.

## Retention

This record is the durable artifact. The workflow run, its logs, and the local before/after design images in `artifacts/` are not: runs expire and `artifacts/` is gitignored. Anything that had to survive is written here.
