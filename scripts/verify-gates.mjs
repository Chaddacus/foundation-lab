/**
 * Gate preflight verifier — fail-closed proof that a repository's human gates are actually
 * configured on the server, not merely described in a document.
 *
 * Why this exists (Phase 13, cross-model audit finding C1): the foundation shipped the two
 * human gates as prose plus "set these in GitHub" setup guidance. A repository could omit the
 * server-side controls and still look compliant, and the release process could not tell a
 * human-authenticated approval from text written by the builder. This turns the gates from a
 * claim into a check: it reads a repository's DECLARED gate config (`gate-config.json`) and
 * asserts the LIVE GitHub ruleset and environment protections match or exceed it, exiting
 * non-zero on any drift, weakening, or absence — and on any inability to read the live state.
 *
 * It is fail-closed by construction: every check must positively observe the required control.
 * A missing rule, a bypass actor, a weaker parameter, an unreadable API, or a required check
 * with no bound source are all failures, not passes. "Could not verify" is never "verified".
 *
 * It does NOT mutate anything. It is read-only, and it is the preflight a gate packet must run
 * and attach — an authorization decision references its output, never this file's prose.
 *
 * Usage:
 *   node verify-gates.mjs <owner/repo> [path/to/gate-config.json]
 * Requires an authenticated `gh` CLI with read access to the repo's rulesets and environments.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const repo = process.argv[2];
const configPath = process.argv[3] ?? 'gate-config.json';

if (repo === undefined) {
  console.error('Usage: node verify-gates.mjs <owner/repo> [gate-config.json]');
  process.exit(2);
}

/** Query the GitHub API through gh. Throws (→ fail-closed) if the call cannot be made. */
function gh(path) {
  const out = execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(out);
}

const spec = JSON.parse(readFileSync(configPath, 'utf8'));
const failures = [];
const checks = [];
const pass = (name, detail) => checks.push({ name, ok: true, detail });
const fail = (name, detail) => { checks.push({ name, ok: false, detail }); failures.push(`${name}: ${detail}`); };

// ---- Branch ruleset (Gate #1) ----
let rulesets;
try {
  rulesets = gh(`repos/${repo}/rulesets`);
} catch (error) {
  fail('rulesets readable', `could not list rulesets (${error instanceof Error ? error.message.split('\n')[0] : error})`);
  report();
}

for (const wantName of Object.keys(spec.rulesets ?? {})) {
  const want = spec.rulesets[wantName];
  const summary = (rulesets ?? []).find((r) => r.name === wantName);
  if (summary === undefined) { fail(`ruleset ${wantName} exists`, 'not present on the repository'); continue; }

  let full;
  try { full = gh(`repos/${repo}/rulesets/${summary.id}`); }
  catch (error) { fail(`ruleset ${wantName} readable`, String(error).split('\n')[0]); continue; }

  if (full.enforcement !== 'active') fail(`ruleset ${wantName} active`, `enforcement=${full.enforcement}`);
  else pass(`ruleset ${wantName} active`, 'active');

  // No bypass actors: a bypass actor is a hole straight through the gate.
  if ((full.bypass_actors ?? []).length !== 0) fail(`ruleset ${wantName} no bypass`, `${full.bypass_actors.length} bypass actor(s)`);
  else pass(`ruleset ${wantName} no bypass`, 'none');

  const targets = full.conditions?.ref_name?.include ?? [];
  for (const ref of want.applies_to ?? []) {
    if (targets.includes(ref)) pass(`ruleset ${wantName} targets ${ref}`, 'ok');
    else fail(`ruleset ${wantName} targets ${ref}`, `targets ${JSON.stringify(targets)}`);
  }

  const ruleByType = Object.fromEntries((full.rules ?? []).map((r) => [r.type, r.parameters ?? {}]));

  for (const type of want.require_rule_types ?? []) {
    if (ruleByType[type] !== undefined) pass(`ruleset ${wantName} has ${type}`, 'present');
    else fail(`ruleset ${wantName} has ${type}`, 'rule type absent');
  }

  const pr = want.pull_request;
  if (pr !== undefined) {
    const p = ruleByType['pull_request'];
    if (p === undefined) fail(`ruleset ${wantName} pull_request`, 'no pull_request rule');
    else {
      if ((p.required_approving_review_count ?? 0) >= pr.min_approvals) pass(`${wantName} approvals`, `${p.required_approving_review_count} ≥ ${pr.min_approvals}`);
      else fail(`${wantName} approvals`, `${p.required_approving_review_count} < ${pr.min_approvals}`);
      if (pr.dismiss_stale_on_push && p.dismiss_stale_reviews_on_push !== true) fail(`${wantName} dismiss stale`, 'not enabled');
      else pass(`${wantName} dismiss stale`, String(p.dismiss_stale_reviews_on_push));
      if (pr.require_last_push_approval && p.require_last_push_approval !== true) fail(`${wantName} last-push approval`, 'not enabled — the pusher could self-approve');
      else pass(`${wantName} last-push approval`, String(p.require_last_push_approval));
      if (pr.require_code_owner_review) {
        if (p.require_code_owner_review === true) pass(`${wantName} code-owner review`, 'true');
        else fail(`${wantName} code-owner review`, 'not enabled — CODEOWNERS on governance paths is unenforced (C3)');
      }
    }
  }

  for (const rc of want.required_checks ?? []) {
    const sc = ruleByType['required_status_checks'];
    const present = (sc?.required_status_checks ?? []).find((c) => c.context === rc.context);
    if (present === undefined) { fail(`${wantName} check ${rc.context}`, 'not required'); continue; }
    if (rc.require_source_binding && present.integration_id === undefined) {
      fail(`${wantName} check ${rc.context} source-bound`, 'no integration_id — the builder could self-report this check');
    } else pass(`${wantName} check ${rc.context}`, rc.require_source_binding ? `bound to integration ${present.integration_id}` : 'required');
  }
}

// ---- Deployment environment (Gate #2) ----
for (const envName of Object.keys(spec.environments ?? {})) {
  const want = spec.environments[envName];
  let env;
  try { env = gh(`repos/${repo}/environments/${envName}`); }
  catch (error) { fail(`environment ${envName} exists`, String(error).split('\n')[0]); continue; }

  const rules = env.protection_rules ?? [];
  const reviewers = rules.find((r) => r.type === 'required_reviewers');
  if (want.required_reviewers) {
    if (reviewers && (reviewers.reviewers ?? []).length > 0) pass(`${envName} required reviewers`, `${reviewers.reviewers.length}`);
    else fail(`${envName} required reviewers`, 'none configured');
  }
  if (want.prevent_self_review) {
    if (reviewers?.prevent_self_review === true) pass(`${envName} prevent self-review`, 'true');
    else fail(`${envName} prevent self-review`, `${reviewers?.prevent_self_review} — approver could approve their own deploy`);
  }
  if (want.disallow_admin_bypass) {
    if (env.can_admins_bypass === false) pass(`${envName} admin bypass disabled`, 'false');
    else fail(`${envName} admin bypass disabled`, `can_admins_bypass=${env.can_admins_bypass}`);
  }
  if (want.protected_branches_only) {
    if (env.deployment_branch_policy?.protected_branches === true) pass(`${envName} protected-branches only`, 'true');
    else fail(`${envName} protected-branches only`, 'not restricted to protected branches');
  }
}

report();

function report() {
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(42)} ${c.detail}`);
  if (checks.length === 0) { console.error('\nNo checks ran — nothing was verified, which is a failure, not a pass.'); process.exit(1); }
  if (failures.length > 0) {
    console.error(`\nGate preflight FAILED: ${failures.length} control(s) missing or weaker than declared. This repository's gates are NOT verified.`);
    process.exit(1);
  }
  console.log(`\nGate preflight PASSED: ${checks.length} controls verified against live GitHub state.`);
}
