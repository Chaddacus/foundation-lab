/**
 * Browser-proof global setup.
 *
 * Why this exists: the e2e server uses a real SQLite file. Without removing it between runs
 * the suite passes on a clean machine and fails on the second run, because the empty-state
 * test would find leftover projects. That is a flaky test, and flakiness is a defect —
 * this removes the cause instead of tolerating a retry.
 */

import { rmSync } from 'node:fs';

export default function globalSetup(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`test-results/e2e.sqlite${suffix}`, { force: true });
  }
}
