# Human Gate #2 Packet — main → sandbox-prod

**Decision requested:** authorize one exact artifact digest to deploy to the sandbox production-like environment.
**Requested by:** foundation-lab-bot (builder identity; not the approver)

> **The digest is deliberately not filled in here.** Gate #2 binds to an exact artifact, and the artifact is produced by the release run this gate belongs to. A packet naming a digest written in advance would be approving bytes that did not exist when it was written. The `authorize-deploy` job names the digest in its own output; approve there.

## How this gate is enforced

The `sandbox-prod` GitHub Environment carries `required_reviewers` and a protected-branch policy, verified present via the API rather than assumed. The `authorize-deploy` job cannot start until a person approves that exact run.

It fired for the first time on run `31389073928` and correctly blocked, waiting on the human reviewer. That run was cancelled: it had been dispatched to verify the build, and a feature-branch artifact is not a deployment decision.

## The artifact

- Built once by `release.yml` from `main`, addressed by **digest**, never by tag — a tag can be repointed at different bytes.
- The base image is pinned by digest, and the build refuses a dirty working tree.
- **Provenance attestation is produced** (`actions/attest-build-provenance`), so the artifact carries proof of what built it and from where. An earlier version of this packet said attestation was "not supported in this setup"; that was true before the release workflow existed and is now false.

## Evidence available at approval time

- **`main` CI:** `verify.yml` runs on every push and pull request to `main` — types, 268 node tests, 44 browser tests, and the recorded AI eval suite. An earlier version of this packet said "there is no CI in this repository"; that is no longer true.
- **The build job's own output** names the digest and source revision.
- **DEV validation:** the DEV environment runs a previously built artifact and reports its digest at `/api/meta`. Confirm the digest under approval has been exercised in DEV before approving it for sandbox.

## What is genuinely still weak

1. **Sandbox-prod has never run.** Its first deployment is also its first exposure; any environment-specific defect surfaces then.
2. **Rollback is written but untested**, because no previous artifact has ever been deployed there to roll back to.
3. **No backup exists or can exist** before the first deployment. From the second onward, the SQLite volume `foundation-lab-sandbox_sandbox-data` is what to snapshot, and that procedure does not yet exist.
4. **No metrics are exported**, so post-deployment health rests on traces, logs and manual checks.
5. The sandbox is production-*like*. It holds no real data, which is what makes exercising this gate safe at all.

## Deployment, after approval

`authorize-deploy` authorizes rather than deploys: sandbox-prod is loopback-only on the operator machine and unreachable from a hosted runner. The job prints the exact command, which uses the approved digest and takes the session secret from the secret backend at launch — unlocking that backend is a human act and nothing in this repository attempts it.

**LIVE VERIFIED is declared only after** `node scripts/verify-deployment.ts http://127.0.0.1:4330` passes, which checks that the running deployment reports the exact digest that was approved. Deploying is not verifying.

---
**Approval record:** _(the approval is the environment approval on the release run; this document is its basis)_
