/**
 * Deployment verification.
 *
 * Responsibility: prove that a RUNNING environment is the artifact that was authorized, and
 * that it works — against the deployment, not against a source tree.
 *
 * Place in the system: an operator/verification task. It is the difference between "we
 * deployed" and LIVE VERIFIED, which the standard says are not the same claim.
 *
 * Usage:
 *   FL_EXPECT_DIGEST=... FL_EXPECT_REVISION=... node scripts/verify-deployment.ts <base-url>
 *
 * The expectations are optional. Without them this still checks the deployment answers and
 * enforces authentication; with them it also proves the running bytes are the authorized
 * ones, which is the check that matters after a promotion.
 */

const baseUrl = process.argv[2];

if (baseUrl === undefined) {
  console.error('Usage: node scripts/verify-deployment.ts <base-url>');
  process.exit(1);
}

const checks: { name: string; ok: boolean; detail: string }[] = [];

async function check(name: string, run: () => Promise<string>): Promise<void> {
  try {
    checks.push({ name, ok: true, detail: await run() });
  } catch (error) {
    checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
}

await check('shell is served', async () => {
  const response = await fetch(`${baseUrl}/`);
  if (!response.ok) throw new Error(`shell responded ${response.status}`);
  return `${response.status}`;
});

// Authentication must be enforced by the DEPLOYMENT, not merely by the code in a test.
await check('capabilities refuse an unauthenticated caller', async () => {
  const response = await fetch(`${baseUrl}/api/projects`);
  if (response.status !== 401) throw new Error(`expected 401, got ${response.status}`);
  return '401';
});

await check('session probe answers without authentication', async () => {
  const response = await fetch(`${baseUrl}/api/session`, { headers: { 'content-type': 'application/json' } });
  const { data } = await response.json();
  if (data?.authenticated !== false) throw new Error('session probe did not answer honestly');
  return 'authenticated:false';
});

// The identity check needs a session, because /api/meta is protected. Supplying credentials
// is optional; without them the identity check is reported as SKIPPED rather than passed —
// a check that cannot run must never look like one that succeeded.
const email = process.env.FL_VERIFY_EMAIL;
const password = process.env.FL_VERIFY_PASSWORD;
const expectedDigest = process.env.FL_EXPECT_DIGEST;
const expectedRevision = process.env.FL_EXPECT_REVISION;

if (email !== undefined && password !== undefined) {
  await check('release identity matches what was deployed', async () => {
    const login = await fetch(`${baseUrl}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (login.status !== 201) throw new Error(`sign-in failed: ${login.status}`);
    const cookie = login.headers.getSetCookie()[0].split(';')[0];

    const meta = await fetch(`${baseUrl}/api/meta`, { headers: { cookie, 'content-type': 'application/json' } });
    const { data } = await meta.json();

    if (expectedDigest !== undefined && data.artifactDigest !== expectedDigest) {
      throw new Error(`running artifact ${data.artifactDigest} is NOT the authorized ${expectedDigest}`);
    }
    if (expectedRevision !== undefined && data.vcsRef !== expectedRevision) {
      throw new Error(`running revision ${data.vcsRef} is NOT the authorized ${expectedRevision}`);
    }
    return `${data.environment} ${data.serviceVersion} @ ${data.vcsRef}`;
  });
} else {
  checks.push({
    name: 'release identity matches what was deployed',
    ok: false,
    detail: 'SKIPPED — set FL_VERIFY_EMAIL and FL_VERIFY_PASSWORD. A skipped check is not a pass.',
  });
}

for (const result of checks) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name.padEnd(48)} ${result.detail}`);
}

if (checks.some((result) => !result.ok)) {
  console.error('\nDeployment verification failed. This environment is not LIVE VERIFIED.');
  process.exit(1);
}
