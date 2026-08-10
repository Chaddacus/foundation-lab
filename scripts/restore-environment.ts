/**
 * Environment restore — put a verified snapshot back and prove the environment came back.
 *
 * Responsibility: stop the service, replace its database with a named backup, start it, and
 * verify it answers. It is deliberately not clever: no partial restores, no merging, no
 * "repair". A restore returns the environment to a known point, or it fails loudly.
 *
 * Place in the system: the other half of `backup-environment.ts`, and the reason that script
 * exists. A backup procedure that has never been restored from is a belief, not a control —
 * the release record listed "rollback is written but untested" for exactly this reason.
 *
 * Usage:
 *   node scripts/restore-environment.ts <container> <database-path-in-container> <backup-file>
 *
 * SERVICE INTERRUPTION: this stops and starts the container. It is destructive to whatever
 * the environment currently holds. It refuses to run against a backup it cannot verify first.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const [container, databasePath, backupFile] = process.argv.slice(2);

if (container === undefined || databasePath === undefined || backupFile === undefined) {
  console.error(
    'Usage: node scripts/restore-environment.ts <container> <database-path-in-container> <backup-file>',
  );
  process.exit(1);
}

if (!existsSync(backupFile)) {
  console.error(`No such backup: ${backupFile}`);
  process.exit(1);
}

function run(command: string, args: readonly string[]): string {
  return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// Beside the database rather than in /tmp: /tmp is tmpfs here, which `docker cp` cannot
// write into, and which would not survive the restart this procedure performs anyway.
const dataDirectory = databasePath.slice(0, databasePath.lastIndexOf('/'));
const staged = `${dataDirectory}/restore-staged.sqlite`;

// Verify BEFORE stopping anything. Discovering a corrupt backup with the service already
// down converts a recoverable situation into an outage.
run('docker', ['cp', backupFile, `${container}:${staged}`]);
const integrity = run('docker', [
  'exec', container, 'node', '-e',
  `const { DatabaseSync } = require('node:sqlite');` +
    `const db = new DatabaseSync(${JSON.stringify(staged)});` +
    `console.log(db.prepare('PRAGMA integrity_check').get().integrity_check); db.close();`,
]).trim();

if (integrity !== 'ok') {
  run('docker', ['exec', container, 'rm', '-f', staged]);
  console.error(`Refusing to restore: backup integrity_check returned "${integrity}".`);
  process.exit(1);
}

console.log(`backup verified (integrity ${integrity}) — stopping ${container}`);

// The container is stopped rather than left running: replacing the file under a live
// connection leaves the running process holding a handle to the old inode, so the service
// would keep serving the pre-restore data while the file on disk says otherwise.
run('docker', ['stop', container]);
run('docker', ['start', container]);

// The staged copy lives in the volume, so it survives the restart and does not need
// re-copying. Replace the database, and delete the WAL and shared-memory files with it: left
// behind, they describe transactions against a database that no longer exists.
run('docker', ['exec', container, 'node', '-e',
  `const fs = require('node:fs');` +
    `for (const suffix of ['-wal', '-shm']) { try { fs.unlinkSync(${JSON.stringify(databasePath)} + suffix); } catch {} }` +
    `fs.copyFileSync(${JSON.stringify(staged)}, ${JSON.stringify(databasePath)});` +
    `fs.unlinkSync(${JSON.stringify(staged)});`,
]);

// The app opened the old file before we replaced it, so restart once more to pick it up.
run('docker', ['restart', container]);

const counts = run('docker', [
  'exec', container, 'node', '-e',
  `const { DatabaseSync } = require('node:sqlite');` +
    `const db = new DatabaseSync(${JSON.stringify(databasePath)});` +
    `const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();` +
    `const out = {};` +
    `for (const t of tables) out[t.name] = db.prepare('SELECT COUNT(*) AS n FROM "' + t.name + '"').get().n;` +
    `db.close(); console.log(JSON.stringify(out));`,
]).trim();

console.log(JSON.stringify({ restored_from: backupFile, counts: JSON.parse(counts) }, null, 2));
console.log(
  '\nRestored. This is NOT live verification — run scripts/verify-deployment.ts against the\n' +
  'environment with its expected digest and revision before calling it healthy.',
);
