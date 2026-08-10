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
 *   FL_EXPECT_DIGEST=... FL_EXPECT_REVISION=... \
 *   FL_VERIFY_EMAIL=... FL_VERIFY_PASSWORD=... node scripts/verify-deployment.ts <base-url>
 *
 * All four are REQUIRED. The expectations were once optional, which meant the identity check
 * could report PASS having compared nothing — a 4-of-4 result that proved only that sign-in
 * worked. Proving the running bytes are the authorized ones is the entire point of running
 * this after a promotion, so it fails closed instead.
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

// The identity check needs a session, because /api/meta is protected, and it needs the
// expected identity, because otherwise it compares nothing. All four inputs are REQUIRED:
// without them the check is reported as SKIPPED rather than passed — a check that cannot run
// must never look like one that succeeded, and a check that runs while comparing nothing is
// worse, because it produces a green result that reads as proof.
const email = process.env.FL_VERIFY_EMAIL;
const password = process.env.FL_VERIFY_PASSWORD;
const expectedDigest = process.env.FL_EXPECT_DIGEST;
const expectedRevision = process.env.FL_EXPECT_REVISION;

const missing = [
  email === undefined ? 'FL_VERIFY_EMAIL' : undefined,
  password === undefined ? 'FL_VERIFY_PASSWORD' : undefined,
  // The expectations are what make this an IDENTITY check rather than a sign-in check.
  // They were optional, and the check reported PASS without them having compared anything —
  // so a 4-of-4 result could be produced while proving nothing about which artifact was
  // running. Independent review found the declared LIVE VERIFIED command omitted them.
  expectedDigest === undefined ? 'FL_EXPECT_DIGEST' : undefined,
  expectedRevision === undefined ? 'FL_EXPECT_REVISION' : undefined,
].filter((name) => name !== undefined);

if (missing.length === 0) {
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

    if (data.artifactDigest !== expectedDigest) {
      throw new Error(`running artifact ${data.artifactDigest} is NOT the authorized ${expectedDigest}`);
    }
    if (data.vcsRef !== expectedRevision) {
      throw new Error(`running revision ${data.vcsRef} is NOT the authorized ${expectedRevision}`);
    }
    return `${data.environment} ${data.serviceVersion} @ ${data.vcsRef}`;
  });
} else {
  checks.push({
    name: 'release identity matches what was deployed',
    ok: false,
    detail: `SKIPPED — set ${missing.join(', ')}. A skipped check is not a pass.`,
  });
}

for (const result of checks) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name.padEnd(48)} ${result.detail}`);
}

if (checks.some((result) => !result.ok)) {
  console.error('\nDeployment verification failed. This environment is not LIVE VERIFIED.');
  process.exit(1);
}
