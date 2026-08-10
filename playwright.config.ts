/**
 * Playwright configuration for browser-grounded proof.
 *
 * Standard 4 requires real interaction evidence for meaningful frontend work. This config
 * starts a real server against a throwaway database so the UI is proven against the actual
 * application, not a mock.
 *
 * Artifacts land in `test-results/`, which is gitignored: routine generated proof belongs in
 * artifact storage, not in Git.
 */

import { defineConfig, devices } from '@playwright/test';

const PORT = 4319;

export default defineConfig({
  testDir: './tests/e2e',
  // A failing browser test is a defect to investigate, never something to rerun until green.
  retries: 0,
  // Serial, single worker: the tests share one server and one database, and the empty-state
  // test must run before anything creates a project. The ordering is deliberate, not luck.
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Seed THEN serve, in one command. Playwright starts the web server before its own
    // global setup, so seeding in a setup hook deleted the database out from under the
    // already-running server.
    command: 'node tests/e2e/seed.ts && node src/spine/main.ts',
    url: `http://127.0.0.1:${PORT}/api/meta`,
    reuseExistingServer: false,
    env: {
      FL_PORT: String(PORT),
      FL_DATABASE_PATH: 'test-results/e2e.sqlite',
      // Telemetry off for UI proof: the exporter is not what these tests are proving.
      FL_OTLP_ENDPOINT: '',
      FL_VCS_REF: 'e2e-local',
      // Fixed so signed-in sessions survive a server restart between local runs.
      FL_SESSION_SECRET: 'e2e-session-secret',
    },
  },
});
