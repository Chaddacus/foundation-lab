# Human Gate #2 Packet — main → sandbox-prod

**Decision requested:** authorize exact artifact
`foundation-lab@sha256:a56ad282e6afa2b9e985a2c1db61effe950b0ab2b37e7d92e351c5340bf4209a`
to deploy to the sandbox production-like environment.
**Requested:** 2026-08-10 · **Requested by:** foundation-lab-bot (builder identity; not the approver)

> **This packet is NOT yet actionable.** It depends on Gate #1, which has not been granted.
> The artifact below was built from `dev`; `main` does not yet contain this revision. It is
> prepared now so both decisions can be seen together, and it MUST be re-grounded and
> re-issued against the true `main` head once Gate #1 is approved.

## The artifact

- Source: `dev` @ `05f1e93191311e4fd6113ab2f07be9195ad32d17` — **pending** promotion to `main` under Gate #1.
- Artifact: `sha256:a56ad282e6afa2b9e985a2c1db61effe950b0ab2b37e7d92e351c5340bf4209a`
  — built once, from a clean tree, base image pinned by digest. This is the same artifact
  currently validated in DEV; no rebuild happens for the sandbox deployment.
- Provenance/attestation: **not supported in this setup.** Images are local to this Docker
  daemon with no registry and no signing. The digest is a content address, which gives
  immutability but not attestation of who built it.

## Evidence

- **`main` CI:** none exists. There is no CI in this repository — verification runs locally
  and its commands are declared in `.claude/verification.json`. That is a genuine gap for a
  promotion gate and is stated rather than glossed.
- **DEV validation of this artifact:** deployed at 127.0.0.1:4320; `/api/meta` on the live
  deployment reports this exact digest; sign-in, project creation and listing exercised
  against it; DEV spans confirmed in Elastic carrying the digest, revision and version.
- **Sandbox pre-flight:** the environment has **never run**. There is no current live version,
  no health history, and no in-flight incidents — because there is nothing deployed. First
  deployment is therefore also first exposure.

## Backup & rollback

- **Fresh backup: none exists, and none is possible.** Sandbox has no data to back up before
  its first deployment. From the second deployment onward the SQLite volume
  `foundation-lab-sandbox_sandbox-data` is the thing to snapshot, and that procedure does not
  yet exist.
- **Rollback path:** redeploy the previous artifact digest by setting `FL_IMAGE` and running
  `docker compose -f compose.sandbox.yaml up -d`. Estimated under a minute. **Untested** —
  there is no previous artifact to roll back to.

## Deployment plan

1. Confirm Gate #1 approved and `main` contains `05f1e93191311e4fd6113ab2f07be9195ad32d17`.
2. Re-issue this packet against the true `main` head.
3. Supply `FL_SESSION_SECRET` from the secret backend at launch (a human act; nothing here
   unlocks it), plus `FL_IMAGE`, `FL_VCS_REF` and `FL_SERVICE_VERSION`.
4. `docker compose -f compose.sandbox.yaml up -d` — loopback-only on 127.0.0.1:4330.
5. Provision the first tenant with `scripts/provision.ts` inside the container.
6. Post-deploy verification: confirm `/api/meta` reports this exact digest; run the FAST tier
   against the deployment; confirm SANDBOX-tagged telemetry reaches Elastic.
7. LIVE VERIFIED is declared only after that evidence passes — not at deploy time.

## Risks & unknowns

1. **No CI.** Nothing independently re-verifies the artifact outside this machine.
2. **No attestation.** The digest proves immutability, not authorship.
3. **No tested rollback.** The procedure is written but has never been executed.
4. **First deployment to an environment that has never run.** Any environment-specific defect
   surfaces here for the first time.
5. **No metrics**, so post-deployment health rests on traces, logs and manual checks.
6. The sandbox is production-*like*, not production. It holds no real data, which lowers the
   consequence of every risk above — and is the reason this gate is safe to exercise at all.

## What YES means

This exact artifact deploys to sandbox-prod in the stated window. LIVE VERIFIED is declared
only after live evidence passes.

---
**Approval record:** _(unsigned — not actionable until Gate #1 is granted and this packet is
re-issued against the true `main` head)_
