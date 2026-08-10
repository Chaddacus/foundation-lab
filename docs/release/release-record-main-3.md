# Release Record — `main-3`

The retained provenance for the first release that passed both human gates. It exists so the release can be reconstructed and audited without reading a chat log, a workflow run that will expire, or a handoff that is a claim rather than truth.

**State: CLOSED** — 2026-08-10.

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
| #1 | `dev` → `main` | the exact head of PR #11, `959fa58` | ruleset `gate1-main`: PR required, one approving review, stale reviews dismissed, last-push approval, `verify` required, no bypass actors |
| #2 | `main` → sandbox-prod | artifact digest `sha256:7cad7e5d…` | `sandbox-prod` environment required reviewer; `authorize-deploy` on run `31395109475` held until approved |

Builder and approver are separate identities. The `foundation-lab-bot` App pushed every branch, opened every pull request, and merged into `dev`; it cannot approve a pull request and cannot merge to `main`. Both halves are enforced by GitHub, not by convention.

## Verification at promotion

- Types clean · 268 node tests · 44 browser tests · AI evals 20/20 recorded · CI green on Linux.
- Independently reproduced by a fresh-context reviewer, not only reported by the builder.
- DEV ran the released artifact and was verified against it **before** Gate #2 was brought to the approver, because the Gate #2 packet requires exactly that and it had not been done.

## Live verification

`node scripts/verify-deployment.ts http://127.0.0.1:4330` — **4 of 4 pass**, including that the running deployment reports the authorized digest and revision.

The digest check was falsified before being trusted: re-run against a deliberately wrong digest it fails and names both the running and expected artifact.

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

## Retention

This record is the durable artifact. The workflow run, its logs, and the local before/after design images in `artifacts/` are not: runs expire and `artifacts/` is gitignored. Anything that had to survive is written here.
