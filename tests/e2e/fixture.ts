/**
 * Browser-proof fixture definition.
 *
 * Responsibility: describe the accounts and data the browser proof runs against, and seed
 * them into a fresh database.
 *
 * Why it is not a Playwright `globalSetup`: the web server is started BEFORE global setup
 * runs, so deleting and recreating the database there left the server holding a handle to
 * the deleted file. Every sign-in then failed while the file on disk looked correct — a
 * genuinely confusing failure. Seeding is now part of the server's own start command, so
 * one process owns the ordering and it cannot silently invert.
 *
 * TWO customers are seeded deliberately: a single-tenant fixture cannot distinguish a
 * working authorization filter from one that returns everything, so the browser proof would
 * be unable to observe a cross-tenant leak.
 */

import { rmSync } from 'node:fs';
import { buildApp } from '../../src/spine/app.ts';
import { loadConfig } from '../../src/spine/config.ts';

export const DATABASE = 'test-results/e2e.sqlite';
export const SESSION_SECRET = 'e2e-session-secret';

/**
 * A gateway that fails the test if anything calls a provider.
 *
 * The capability contract claims no automated test spends subscription capacity. That was
 * true only because authorization refused first — a property, not a structure. This makes
 * it structural: a regression that let a call through fails loudly instead of billing.
 */
const NEVER_CALLED = {
  provider: 'never-called',
  complete: async (): Promise<never> => {
    throw new Error('a test reached a real AI provider — tests must never spend subscription capacity');
  },
};

export const ACME = { email: 'ana@acme.test', password: 'e2e-acme-password', customer: 'Acme Industries' };
export const GLOBEX = { email: 'gil@globex.test', password: 'e2e-globex-password', customer: 'Globex Corporation' };

/** Reset and seed. Safe to call repeatedly; each run starts from a known state. */
export async function seedFixture(): Promise<void> {
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${DATABASE}${suffix}`, { force: true });
  }

  const app = buildApp(loadConfig({
    FL_DATABASE_PATH: DATABASE,
    FL_OTLP_ENDPOINT: '',
    FL_SESSION_SECRET: SESSION_SECRET,
  }), NEVER_CALLED);

  for (const account of [ACME, GLOBEX]) {
    const customer = app.modules.customers.provisioning.provisionCustomer(account.customer);
    await app.modules.customers.provisioning.provisionUser(customer.id, account.email, account.password);
  }

  // Globex owns a project so cross-tenant isolation is observable in the browser: if it
  // ever appears in Acme's list, the tenant filter is broken and the proof catches it.
  const globex = await app.modules.customers.capability.login({
    email: GLOBEX.email,
    password: GLOBEX.password,
  });
  app.modules.projects.capability.createProject(globex.actor, {
    name: 'Globex Confidential Project',
    description: 'Belongs to Globex. Acme must never see this.',
  });

  app.close();
}
