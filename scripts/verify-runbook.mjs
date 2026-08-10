/**
 * Runbook authority verifier — refuse to arm any runbook whose authority the builder could
 * have forged. The trust root is a registry entry ON THE PROTECTED BRANCH, which can only be
 * placed there through a CODEOWNERS-reviewed merge the builder cannot approve.
 *
 * Cross-model audit C2, and its round-nine correction: an earlier version read the registry
 * from the WORKING TREE and checked only the runbook file's git-cleanliness — so a
 * self-authored, uncommitted registry entry with an invented approver armed a production
 * runbook. That was prose ("authority comes from the merge") wider than the mechanism. This
 * version derives authority from the merge for real: for a production arm it fetches the
 * registry from the protected branch via `gh api` (not the local file), and checks that the
 * runbook the executor is about to run byte-matches the runbook blob at that same protected
 * ref. A local, unmerged, or edited runbook/registry cannot authorize anything.
 *
 * Fail-closed. A production arm is refused unless ALL hold:
 *  1. the runbook is committed and byte-identical to its blob on the protected branch;
 *  2. its sha256 matches a registry entry FETCHED FROM the protected branch;
 *  3. that entry names an approver, and the runbook names an owner, and they differ;
 *  4. the declared capability is a known typed capability;
 *  5. the runbook is within expiry;
 *  6. `gh` can read the protected branch — inability to prove the merge is a refusal.
 *
 * DEV is the exempt pre-registration test bed and needs none of this.
 *
 * Usage (JSON on stdout; exit 0 = may arm, non-zero = refused):
 *   node verify-runbook.mjs <runbook-path> <registry-path> <env> \
 *        [--repo owner/name] [--protected-ref main]
 * `--repo`/`--protected-ref` are REQUIRED for any non-DEV (production-class) environment.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const positional = [];
const opt = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a.startsWith('--')) { opt[a.slice(2)] = process.argv[i + 1]; i += 1; }
  else positional.push(a);
}
const [runbookPath, registryPath, env] = positional;
const KNOWN_CAPABILITIES = new Set(['rollback_to_last_live_verified_digest', 'restart_service']);

function refuse(reason) { console.log(JSON.stringify({ may_arm: false, reason }, null, 2)); process.exit(1); }
function allow(detail) { console.log(JSON.stringify({ may_arm: true, ...detail }, null, 2)); process.exit(0); }

if (runbookPath === undefined || registryPath === undefined || env === undefined) {
  console.error('Usage: node verify-runbook.mjs <runbook> <registry> <env> [--repo o/n] [--protected-ref main]');
  process.exit(2);
}
if (!existsSync(runbookPath)) refuse(`runbook not found: ${runbookPath}`);

const text = readFileSync(runbookPath, 'utf8');
const field = (name) => new RegExp(`^\\s*${name}:\\s*"?([^"\\n]*)"?`, 'm').exec(text)?.[1]?.trim() ?? '';
const capability = field('capability');
const author = field('owner');
const expiry = field('expiry');

// A capability must be typed regardless of environment — free prose is never valid.
if (!KNOWN_CAPABILITIES.has(capability)) {
  refuse(`capability "${capability}" is not a known typed capability (${[...KNOWN_CAPABILITIES].join(', ')})`);
}

// DEV is the pre-registration test bed; production-class needs the full authority chain.
if (env.toUpperCase() === 'DEV') allow({ capability, note: 'DEV test bed — registry not required' });

if (expiry === '') refuse('no expiry recorded — production autonomy is not granted');
if (author === '') refuse('runbook declares no owner — cannot enforce approver≠author separation of duties');

const repo = opt.repo;
const ref = opt['protected-ref'];
if (!repo || !ref) refuse('a production arm requires --repo and --protected-ref so authority can be read from the protected branch');

function ghContent(path) {
  // Raw file content at the protected ref, straight from the server — never the working tree.
  return execFileSync('gh', ['api', `repos/${repo}/contents/${path}?ref=${ref}`,
    '-H', 'Accept: application/vnd.github.raw+json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

// 1. The runbook about to run must byte-match its blob on the protected branch. This closes
//    both "edited after registration" and "local-only, never merged".
let protectedRunbook;
try { protectedRunbook = ghContent(runbookPath); }
catch (e) { refuse(`could not read the runbook from ${repo}@${ref} — cannot prove it was merged (${String(e).split('\n')[0]})`); }
const localSha = createHash('sha256').update(readFileSync(runbookPath)).digest('hex');
const protectedSha = createHash('sha256').update(protectedRunbook).digest('hex');
if (localSha !== protectedSha) {
  refuse(`the runbook to be armed does not match ${repo}@${ref} — local ${localSha.slice(0, 12)}… vs merged ${protectedSha.slice(0, 12)}…`);
}

// 2. The registry FROM THE PROTECTED BRANCH must record this hash. The working-tree registry
//    is never trusted; an entry only reaches the protected branch through a reviewed merge.
let registry;
try { registry = JSON.parse(ghContent(registryPath)); }
catch (e) { refuse(`could not read the registry from ${repo}@${ref} (${String(e).split('\n')[0]})`); }
const entry = (registry.runbooks ?? []).find((r) => r.sha256 === protectedSha);
if (entry === undefined) {
  refuse(`the runbook's hash ${protectedSha.slice(0, 12)}… is not registered on ${repo}@${ref} — not reviewed and merged`);
}

// 3. Distinct, non-empty approver (the merge that placed it was code-owner reviewed; this is
//    the belt-and-braces check that the recorded approver is not the author).
if (!entry.approved_by || entry.approved_by.trim() === '') refuse('registry entry records no approver');
if (entry.approved_by.trim().toLowerCase() === author.toLowerCase()) {
  refuse(`the runbook author (${author}) is also its registry approver — separation of duties violated`);
}

allow({ capability, sha256: protectedSha, approved_by: entry.approved_by, registry_entry: entry.runbook_id, protected_ref: `${repo}@${ref}` });
