# Backup and restore — deployed environments

The procedure that must exist before anything mutates a deployed environment. It was written because the first sandbox release shipped without one, and that was disclosed to the approver as a known-weak item rather than discovered afterwards.

**Tested, not merely written.** The drill in "Proof" below was run against the live sandbox-prod on 2026-08-10.

## Take a backup

```
node scripts/backup-environment.ts <container> <database-path-in-container> <output-dir>
```

For sandbox-prod:

```
node scripts/backup-environment.ts foundation-lab-sandbox-app-1 \
  /app/data/foundation-lab.sandbox.sqlite ./backups
```

It does not stop the service. It uses SQLite's own `VACUUM INTO` rather than copying the file, because the database runs in WAL mode: the `.sqlite` file on disk is not the whole database, and a mid-write copy yields a torn snapshot that still opens cleanly — the worst possible failure, because nothing looks wrong until a restore.

**The backup is verified before the command exits**: `integrity_check` on the snapshot itself, a row-count comparison against the live database, and a non-empty file. It exits non-zero and says not to rely on the file if any of those fail. An unverified backup is a file that will be discovered useless at the worst moment.

Output records what the snapshot is a copy *of* — environment, service version, revision, artifact digest — so a restore is a decision about a known point rather than a guess.

## Restore

```
node scripts/restore-environment.ts <container> <database-path-in-container> <backup-file>
```

**This interrupts service and destroys whatever the environment currently holds.** It is deliberately not clever: no partial restore, no merge, no repair.

Two properties worth knowing:

- It verifies the backup **before stopping anything**. Discovering a corrupt backup with the service already down turns a recoverable situation into an outage.
- It stops the container rather than replacing the file underneath a live process. A running process holds a handle to the old inode, so an in-place swap leaves the service serving pre-restore data while the file on disk says otherwise. It also deletes the `-wal` and `-shm` files, which otherwise describe transactions against a database that no longer exists.

Restoring is not verifying. Run `scripts/verify-deployment.ts` with the expected digest and revision afterwards, as the script's own closing message says.

## Proof — the drill run on sandbox-prod, 2026-08-10

A backup procedure that has never been restored from is a belief. The claim here is that a restore *reverts*, so the drill mutates the environment and checks the mutation is gone:

| Step | Observed |
|---|---|
| Backup taken | `integrity ok`, 81 920 bytes, `{customers:1, projects:1, sessions:5, users:1}`, from `SANDBOX main-3 @ 4487e587…` |
| Mutation | provisioned a second customer and created a project named `MUST NOT SURVIVE THE RESTORE` → `projects: 2, customers: 2` |
| Restore | `projects: 1, customers: 1` |
| Reverted? | project list is `["Live sandbox capability check"]` — the drill project is gone |
| Account created after the backup | sign-in returns **401**; it no longer exists |
| Environment healthy after restart | `verify-deployment.ts` 4 of 4, `SANDBOX main-3 @ 4487e5879d…` |

## What this does not cover

1. **The database only.** Container images are addressed by digest and re-pullable, and the session secret lives in the secret backend, so the database is the only state that cannot be reconstructed. Nothing else is captured.
2. **No schedule and no retention policy.** Backups are taken by an operator before a mutating change. Nothing runs them automatically and nothing prunes them.
3. **No off-host copy.** Backups land wherever the operator points them, on the same machine as the environment. A host failure loses both.
4. **Restore is not rollback of the artifact.** This returns *data* to a point in time. Returning to a previous *release* is a separate action against a previous digest, and there is now more than one digest for the first time.
5. **Point-in-time recovery does not exist.** You can return to a backup, not to an arbitrary moment.
