# Human Gate #2 Packet — main → sandbox-prod

**Decision requested:** authorize one exact artifact digest to deploy to the sandbox production-like environment.
**Requested by:** foundation-lab-bot (builder identity; not the approver)

> **STATUS: APPROVED AND EXECUTED, 2026-08-10.** See the Outcome section at the end. **The risk list below is preserved exactly as the approver read it** and is therefore written in the tense of a decision not yet made.

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

### DEV validation actually performed — 2026-08-10

The artifact built by the first release run from `main` (`4487e58`) was deployed to DEV and verified, rather than approved on the strength of the build alone:

- Artifact: `ghcr.io/chaddacus/foundation-lab@sha256:7cad7e5d0a4b9ef9743ca17740aeac193c584173fa3056f36e8a9f0ef32b3f60`
- Provenance attestation verifies against the repository: SLSA v1 predicate, built by `release.yml@refs/heads/main`, source revision `4487e58`, GitHub-hosted runner.
- `node scripts/verify-deployment.ts http://127.0.0.1:4320` — **4 of 4 pass**, including that the running deployment reports the exact expected digest and revision.
- That last check was **falsified before being trusted**: re-run with a deliberately wrong digest, it fails and names both the running and the expected artifact. The check discriminates.

## What is genuinely still weak

1. **The artifact is `linux/amd64` only, and the target host is `arm64`.** It was built on a GitHub-hosted x86 runner with no platform matrix, so both DEV and sandbox-prod run it under emulation on this machine. Release identity is intact — the digest deployed is the digest built and attested — but "DEV validates the artifact intended for production" holds for the *bytes*, not for the *execution environment*. A defect that only appears on one architecture would not be caught here, and DEV would not catch it either, because DEV is emulated too. Found while performing the DEV validation above; the fix is a multi-platform build, which is a change to `release.yml` and therefore a future promotion, not this one.
2. **The DEV session secret is not in the secret backend.** `compose.dev.yaml` instructs the operator to supply it with `rbw get foundation-lab-dev-session`, and no such entry exists — `rbw list` returns no `foundation-lab` entry at all. The value in the running container was carried forward from the previous deployment rather than resolved from the backend. No secret value was printed, stored in the repository, or written to a log, but the reference-not-value discipline in SPEC §7 is currently satisfied by the *file* and not by the *practice*. Creating the entry is a human act on an unlocked personal backend.
3. **Sandbox-prod has never run.** Its first deployment is also its first exposure; any environment-specific defect surfaces then.
4. **Rollback is written but untested**, because no previous artifact has ever been deployed there to roll back to.
5. **No backup exists or can exist** before the first deployment. From the second onward, the SQLite volume `foundation-lab-sandbox_sandbox-data` is what to snapshot, and that procedure does not yet exist.
6. **No metrics are exported**, so post-deployment health rests on traces, logs and manual checks.
7. The sandbox is production-*like*. It holds no real data, which is what makes exercising this gate safe at all.

## Deployment, after approval

`authorize-deploy` authorizes rather than deploys: sandbox-prod is loopback-only on the operator machine and unreachable from a hosted runner. The job prints the exact command, which uses the approved digest and takes the session secret from the secret backend at launch — unlocking that backend is a human act and nothing in this repository attempts it.

**LIVE VERIFIED is declared only after** `node scripts/verify-deployment.ts http://127.0.0.1:4330` passes, which checks that the running deployment reports the exact digest that was approved. Deploying is not verifying.

## Outcome — 2026-08-10

**Approved and executed.** Gate #2 authorized `sha256:7cad7e5d…` on run `31395109475`; the deployment ran locally against that digest and `verify-deployment.ts` passed 4 of 4. Sandbox-prod is **LIVE VERIFIED**.

The full provenance is retained in `release-record-main-3.md`, which is the durable record — this packet is the basis of the decision, not the record of the release.

Two things worth carrying into the next use of this gate:

- The deployment could not proceed until `foundation-lab-sandbox-session` existed in the secret backend. That entry did not exist, which is risk 2 above blocking the thing it warned about. The operator created it; automation did not, and should not.
- Provisioning a verification account is part of deploying a fresh environment. `verify-deployment.ts` refuses to call a skipped check a pass, so a new environment cannot be declared LIVE VERIFIED until an account exists to prove authenticated identity with.

---
**Approval record:** _(the approval is the environment approval on the release run; this document is its basis)_
