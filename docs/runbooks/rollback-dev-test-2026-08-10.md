# Runbook DEV test — `rb-rollback-sandbox-001`

The evidence the runbook's `tested:` block points at. A runbook is not production-eligible until it has run in DEV/simulation; this is that run. It does **not** enable production autonomy — that additionally needs an independent human reviewer, which the runbook does not yet have.

Tested 2026-08-10 against DEV (`foundation-lab-dev-app-1`, `127.0.0.1:4320`) by `scripts/runbook-rollback.ts`.

## FND-043 — fails closed when a precondition is missing

| Case | Invocation | Result |
|---|---|---|
| No reviewer, production target | `--env SANDBOX --arm` | **abort, exit 1** — "refusing to --arm against SANDBOX: no independent human reviewer". Production autonomy is not enabled. |
| Rollback target absent locally | `--env DEV --to-digest sha256:aaaa… --arm` | **abort, exit 1** — "the rollback target is not present locally". A rollback must not depend on fetching new bytes. |
| Grounding only | `--env DEV …` (no `--arm`) | dry run: grounded, prerequisites passed, **no action taken**. |

Also enforced in code and not separately shown: target equal to the current digest aborts ("nothing to do"); a non-`sha256:` target is rejected as a parameter-bounds violation; the concurrency lock aborts rather than races a second execution.

## FND-042 — bounded rollback executes and verifies, without deploying new code

DEV was running the not-yet-gated fix candidate `fix-flood-dev @ 55342656…`. The runbook rolled it back to the **last live-verified** artifact:

```
node scripts/runbook-rollback.ts --env DEV --container foundation-lab-dev-app-1 \
  --db /app/data/foundation-lab.dev.sqlite \
  --to-digest ghcr.io/chaddacus/foundation-lab@sha256:7cad7e5d0a4b… \
  --to-version main-3 --to-revision 4487e5879d3989bd028f05c4a07380ef28c30684 --arm
```

- Grounding read the actual running digest (`55342656…`) rather than assuming it.
- The action redeployed the named digest via compose. **No image was built or pushed** — the executor never invokes a build; it redeploys bytes that already passed both human gates.
- Post-action `verify-deployment.ts`: **4/4**, `DEV main-3 @ 4487e5879d…`. The environment reports the rollback digest, so the action is proven, not assumed.

## What this test does not establish

- **Production autonomy.** That needs the reviewer field filled by someone who is not the author, and re-testing before the `expiry` date. Until then the runbook is DEV-tested and production-refused, which is the correct L4 state, not a gap to paper over.
- **The rollback does not fix the login-flood defect.** Rolling back to `main-3` returns to the artifact that *has* the defect. Rollback is a mitigation for a bad deployment, not for this incident — this incident needs the new code in PR #17 through the two gates. The runbook was tested here because Phase 12 requires one bounded runbook exercised end to end, not because it is this incident's remedy.
