/**
 * Environment backup — produce a restorable, verified snapshot of a deployed environment's
 * database.
 *
 * Responsibility: take a consistent copy of the SQLite database out of a running container,
 * prove the copy is intact, and record what it is a copy of. It does not stop the service.
 *
 * Place in the system: an operator task, and the precondition for any change that mutates a
 * deployed environment. Phase 12 injects faults into sandbox-prod; without this there is no
 * way back, which is why the release record listed "no backup procedure exists" as a
 * known-weak item rather than leaving it implied.
 *
 * Why `VACUUM INTO` and not a file copy: the database runs in WAL mode, so the `.sqlite` file
 * on disk is not the whole database and copying it mid-write yields a torn snapshot that
 * still opens. `VACUUM INTO` asks SQLite itself for a consistent copy at a single point.
 *
 * Usage:
 *   node scripts/backup-environment.ts <container> <database-path-in-container> <output-dir>
 *
 * The snapshot is verified before this exits: integrity check, plus a row-count comparison
 * against the live database. An unverified backup is not a backup — it is a file that will
 * be discovered to be useless at the worst possible moment.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [container, databasePath, outputDir] = process.argv.slice(2);

if (container === undefined || databasePath === undefined || outputDir === undefined) {
  console.error(
    'Usage: node scripts/backup-environment.ts <container> <database-path-in-container> <output-dir>',
  );
  process.exit(1);
}

/** Run a command, returning stdout. Throws with the command's own stderr on failure. */
function run(command: string, args: readonly string[]): string {
  return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Evaluate an expression against a database inside the container.
 *
 * The container is the only place the runtime and the database file are guaranteed to agree,
 * so counts and integrity checks are taken there rather than against a host copy that might
 * have been produced by a different SQLite version.
 */
function inContainer(script: string): string {
  return run('docker', ['exec', container, 'node', '-e', script]).trim();
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
// Staged beside the database, not in /tmp: /tmp is a tmpfs mount in these containers and
// `docker cp` cannot read out of it. The data directory is a named volume, which it can.
const dataDirectory = databasePath.slice(0, databasePath.lastIndexOf('/'));
const snapshotInContainer = `${dataDirectory}/backup-${stamp}.sqlite`;
const destination = join(outputDir, `${container}-${stamp}.sqlite`);

mkdirSync(outputDir, { recursive: true });

// A single point-in-time copy, taken by SQLite rather than by the filesystem.
inContainer(
  `const { DatabaseSync } = require('node:sqlite');` +
    `const db = new DatabaseSync(${JSON.stringify(databasePath)});` +
    `db.exec("VACUUM INTO '" + ${JSON.stringify(snapshotInContainer)} + "'");` +
    `db.close();`,
);

const liveCounts = inContainer(
  `const { DatabaseSync } = require('node:sqlite');` +
    `const db = new DatabaseSync(${JSON.stringify(databasePath)});` +
    `const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();` +
    `const counts = {};` +
    `for (const t of tables) counts[t.name] = db.prepare('SELECT COUNT(*) AS n FROM "' + t.name + '"').get().n;` +
    `db.close(); console.log(JSON.stringify(counts));`,
);

// Verify the SNAPSHOT, not the live database — the point is to learn whether the artifact we
// are keeping is usable, and it is the only thing a restore will have.
const snapshotIntegrity = inContainer(
  `const { DatabaseSync } = require('node:sqlite');` +
    `const db = new DatabaseSync(${JSON.stringify(snapshotInContainer)});` +
    `console.log(db.prepare('PRAGMA integrity_check').get().integrity_check); db.close();`,
);

const snapshotCounts = inContainer(
  `const { DatabaseSync } = require('node:sqlite');` +
    `const db = new DatabaseSync(${JSON.stringify(snapshotInContainer)});` +
    `const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();` +
    `const counts = {};` +
    `for (const t of tables) counts[t.name] = db.prepare('SELECT COUNT(*) AS n FROM "' + t.name + '"').get().n;` +
    `db.close(); console.log(JSON.stringify(counts));`,
);

run('docker', ['cp', `${container}:${snapshotInContainer}`, destination]);
run('docker', ['exec', container, 'rm', '-f', snapshotInContainer]);

const failures: string[] = [];
if (snapshotIntegrity !== 'ok') failures.push(`snapshot integrity_check returned "${snapshotIntegrity}"`);
if (snapshotCounts !== liveCounts) {
  failures.push(`row counts differ — live ${liveCounts}, snapshot ${snapshotCounts}`);
}
if (statSync(destination).size === 0) failures.push('the copied file is empty');

// What the backup is a copy OF. A snapshot whose provenance is unknown cannot be restored
// with any confidence about what it restores the environment to.
const identity = inContainer(
  `console.log(JSON.stringify({ environment: process.env.FL_ENV, version: process.env.FL_SERVICE_VERSION,` +
    ` revision: process.env.FL_VCS_REF, artifact: process.env.FL_ARTIFACT_DIGEST }));`,
);

console.log(JSON.stringify({
  backup: destination,
  bytes: statSync(destination).size,
  integrity: snapshotIntegrity,
  counts: JSON.parse(snapshotCounts),
  taken_from: JSON.parse(identity),
  verified: failures.length === 0,
  failures,
}, null, 2));

if (failures.length > 0) {
  console.error('\nBackup verification FAILED. Do not rely on this file.');
  process.exit(1);
}
