/**
 * Runbook authority verifier — refuse to arm any runbook whose authority the builder could
 * have forged. The trust root is the human-reviewed gate, not a field the builder can type.
 *
 * Cross-model audit C2: a runbook's `owner`, `reviewed_by`, and approval fields were ordinary
 * editable strings, so the same agent could author a runbook, claim a human reviewed it, and
 * describe a deployment as "rollback". This binds a runbook's *content hash* to an entry in a
 * registry that can only change through a CODEOWNERS-reviewed merge — the identical property
 * that makes the two human gates unforgeable. The builder can write a registry entry in a PR;
 * it cannot merge that PR without an approving human review it is structurally barred from
 * giving. So production authority comes from the merge, not from the runbook's own prose.
 *
 * A production arm is refused unless ALL hold (fail-closed):
 *  1. the runbook file is committed and clean (no post-registration edits in the working tree);
 *  2. its sha256 matches the registered hash in the CODEOWNERS-protected registry;
 *  3. the registry records an approver who is not the runbook's author;
 *  4. the declared capability is a known typed capability (not free prose);
 *  5. the runbook is within its expiry.
 *
 * Usage (returns JSON on stdout; exit 0 = may arm, non-zero = refused):
 *   node verify-runbook.mjs <runbook.yaml> <registry.json> <env>
 * `env` DEV is exempt from the registry requirement (DEV is the pre-registration test bed);
 * any other environment is production-class and requires the full chain.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const [runbookPath, registryPath, env] = process.argv.slice(2);
const KNOWN_CAPABILITIES = new Set(['rollback_to_last_live_verified_digest', 'restart_service']);

function refuse(reason) {
  console.log(JSON.stringify({ may_arm: false, reason }, null, 2));
  process.exit(1);
}
function allow(detail) {
  console.log(JSON.stringify({ may_arm: true, ...detail }, null, 2));
  process.exit(0);
}

if (runbookPath === undefined || registryPath === undefined || env === undefined) {
  console.error('Usage: node verify-runbook.mjs <runbook.yaml> <registry.json> <env>');
  process.exit(2);
}
if (!existsSync(runbookPath)) refuse(`runbook not found: ${runbookPath}`);

const text = readFileSync(runbookPath, 'utf8');
const field = (name) => new RegExp(`^\\s*${name}:\\s*"?([^"\\n]*)"?`, 'm').exec(text)?.[1]?.trim() ?? '';
const capability = field('capability');
const author = field('owner');
const reviewer = field('reviewed_by');
const expiry = field('expiry');

// A capability must be typed regardless of environment — a free-prose action is never valid.
if (!KNOWN_CAPABILITIES.has(capability)) {
  refuse(`capability "${capability}" is not a known typed capability (${[...KNOWN_CAPABILITIES].join(', ')})`);
}

// DEV is the pre-registration test bed; production-class needs the full authority chain.
if (env.toUpperCase() === 'DEV') allow({ capability, note: 'DEV test bed — registry not required' });

// Expiry (best-effort lexical compare on ISO dates; empty = never granted autonomy).
if (expiry === '') refuse('no expiry recorded — production autonomy is not granted');

function git(...args) {
  try { return execFileSync('git', args, { encoding: 'utf8' }).trim(); }
  catch { return null; }
}

// 1. Committed and clean — an edited-but-uncommitted runbook must not arm.
const status = git('status', '--porcelain', '--', runbookPath);
if (status === null) refuse('not inside a git repository — cannot establish the runbook is committed');
if (status !== '') refuse('the runbook file has uncommitted changes — arm only a committed, registered runbook');

// 2. Hash matches a registry entry.
if (!existsSync(registryPath)) refuse(`no runbook registry at ${registryPath}`);
const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
const sha = createHash('sha256').update(readFileSync(runbookPath)).digest('hex');
const entry = (registry.runbooks ?? []).find((r) => r.sha256 === sha);
if (entry === undefined) {
  refuse(`the runbook's content hash ${sha.slice(0, 12)}… is not in the registry — it was never reviewed and registered, or it was edited after registration`);
}

// 3. Approver is a real, distinct identity — the author cannot approve their own runbook.
if (!entry.approved_by || entry.approved_by.trim() === '') refuse('registry entry records no approver');
if (author && entry.approved_by.trim().toLowerCase() === author.trim().toLowerCase()) {
  refuse(`the runbook author (${author}) is also its registry approver — separation of duties violated`);
}

allow({ capability, sha256: sha, approved_by: entry.approved_by, reviewer, registry_entry: entry.runbook_id });
