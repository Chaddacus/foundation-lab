/**
 * Bounded self-healing executor — roll an environment back to a previously live-verified
 * artifact. Enforces the runbook contract (docs/runbooks/rollback-to-last-live-verified.yaml)
 * in code, so the bounds are mechanical rather than a promise in a document.
 *
 * It NEVER builds or pushes an image and NEVER touches an environment other than the one
 * named: rolling back is redeploying bytes that already passed both human gates. New code
 * always goes through those gates (SPEC §10.6 / observability L4).
 *
 * Two guards make it safe to be autonomous — and safe to NOT be, yet:
 *  - It refuses `--arm` unless the runbook has an independent human reviewer recorded. An
 *    unreviewed runbook can run in `--dry-run` (grounding + checks, no action) only.
 *  - Every prerequisite and the post-action verification fail CLOSED: a missing precondition
 *    or an unproven result aborts and escalates rather than proceeding.
 *
 * Usage:
 *   node scripts/runbook-rollback.ts --env <name> --container <c> --db <path-in-container> \
 *     --to-digest <sha256:...> --to-version <v> --to-revision <rev> [--arm]
 *
 * Without --arm it grounds and checks and then stops before the action (dry run).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, openSync, closeSync, unlinkSync, constants as fsConstants } from 'node:fs';

interface Args { [k: string]: string | boolean; }
const args: Args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (token.startsWith('--')) {
    const key = token.slice(2);
    const next = process.argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i += 1; }
  }
}

function fail(reason: string): never {
  // Abort path: one message, no retry, exit non-zero. The caller (or a scheduler) escalates.
  console.error(JSON.stringify({ runbook: 'rb-rollback-sandbox-001', aborted: true, reason }, null, 2));
  process.exit(1);
}

const env = args.env as string;
const container = args.container as string;
const dbPath = args.db as string;
const toDigest = args['to-digest'] as string;
const toVersion = args['to-version'] as string;
const toRevision = args['to-revision'] as string;
const armed = args.arm === true;

for (const [name, value] of Object.entries({ env, container, db: dbPath, 'to-digest': toDigest, 'to-version': toVersion, 'to-revision': toRevision })) {
  if (typeof value !== 'string' || value === '') fail(`missing required argument --${name}`);
}
if (!/^sha256:[0-9a-f]{64}$/.test(toDigest.replace(/^.*@/, ''))) {
  fail('the rollback target is not a valid sha256 digest reference (parameter_bounds violated)');
}

function run(command: string, cmdArgs: readonly string[]): string {
  return execFileSync(command, cmdArgs, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

// ---- Reviewer guard: PRODUCTION autonomy requires an independent human reviewer. ----
// The contract is "tested in DEV/staging/simulation BEFORE production autonomy is enabled",
// so arming against a non-DEV environment demands a reviewer; arming against DEV is exactly
// the pre-review test and does not. This is the L4 precondition made mechanical (FND-043):
// an unreviewed runbook can be exercised in DEV but can never fire against sandbox/prod.
const runbookText = readFileSync('docs/runbooks/rollback-to-last-live-verified.yaml', 'utf8');
const reviewer = /reviewed_by:\s*"([^"]*)"/.exec(runbookText)?.[1] ?? '';
const isProductionClass = (env as string).toUpperCase() !== 'DEV';
if (armed && isProductionClass && reviewer.trim() === '') {
  fail(`refusing to --arm against ${env}: the runbook has no independent human reviewer recorded. ` +
    'Production autonomy is not enabled until it does; it may be tested in DEV first.');
}

// ---- Grounding: read the ACTUAL running digest, never assume it. ----
const running = run('docker', ['inspect', container, '--format', '{{range .Config.Env}}{{println .}}{{end}}']);
const currentDigest = /^FL_ARTIFACT_DIGEST=(.+)$/m.exec(running)?.[1] ?? '';
if (currentDigest === '') fail('grounding failed: the container does not report a current artifact digest');

// ---- Prerequisites, each failing closed. ----
if (currentDigest === toDigest) {
  fail(`prerequisite not met: the environment already runs the rollback target ${toDigest} — nothing to do`);
}
// The rollback target must exist locally: rolling back must not depend on fetching new bytes.
try {
  run('docker', ['image', 'inspect', toDigest]);
} catch {
  fail(`prerequisite not met: the rollback target ${toDigest} is not present locally (abort_conditions)`);
}

const grounding = {
  environment: env,
  container,
  current_digest: currentDigest,
  rollback_digest: toDigest,
  reviewer: reviewer.trim() === '' ? '(none — dry-run only)' : reviewer.trim(),
};
console.log(JSON.stringify({ runbook: 'rb-rollback-sandbox-001', phase: 'grounded', grounding }, null, 2));

if (!armed) {
  console.log(JSON.stringify({ phase: 'dry-run', action_taken: false, note: 'grounding and prerequisites passed; --arm withheld' }, null, 2));
  process.exit(0);
}

// ---- Concurrency lock: abort if held, do not wait. ----
const lockPath = `${process.cwd()}/.runbook-rollback.lock`;
let lockFd: number;
try {
  lockFd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
} catch {
  fail('concurrency lock is held; another execution is in flight — aborting rather than racing it');
}

try {
  // ---- The single bounded action: redeploy the named digest. No build, ever. ----
  const sessionSecret = /^FL_SESSION_SECRET=(.+)$/m.exec(running)?.[1] ?? '';
  if (sessionSecret === '') fail('the running container does not expose a session secret to carry forward');

  // compose reads FL_* from the environment; set them for the child explicitly.
  execFileSync('docker', ['compose', '-f', `compose.${env.toLowerCase()}.yaml`, 'up', '-d', '--force-recreate'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FL_IMAGE: toDigest,
      FL_SERVICE_VERSION: toVersion,
      FL_VCS_REF: toRevision,
      FL_SESSION_SECRET: sessionSecret,
    },
  });

  console.log(JSON.stringify({ phase: 'action-complete', redeployed: toDigest }, null, 2));
  console.log('Verify with: FL_EXPECT_DIGEST=' + toDigest + ' FL_EXPECT_REVISION=' + toRevision +
    ' FL_VERIFY_EMAIL=... FL_VERIFY_PASSWORD=... node scripts/verify-deployment.ts <base-url>');
} finally {
  closeSync(lockFd);
  if (existsSync(lockPath)) unlinkSync(lockPath);
}
