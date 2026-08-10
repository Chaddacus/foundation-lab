/**
 * Local development seed.
 *
 * Responsibility: create two customers with one user each, so LOCAL and the browser proof
 * have something to sign in as.
 *
 * Place in the system: a script, not application code. It calls the Customers module's
 * provisioning methods, which no adapter exposes — there is no admin role, so tenant and
 * account creation is deliberately not reachable over HTTP or MCP.
 *
 * TWO customers, not one: a single-tenant fixture cannot tell a working authorization
 * filter apart from one that returns everything. Anything exercised against this seed can
 * observe a cross-tenant leak.
 *
 * The passwords here are fixed, public, and for LOCAL only. They are not secrets and are
 * not a secret-handling exception: no deployed environment uses this script, and DEV and
 * SANDBOX refuse to start without a real session secret supplied at runtime.
 */

import { buildApp } from '../src/spine/app.ts';
import { loadConfig } from '../src/spine/config.ts';

const config = loadConfig();

if (config.environment !== 'LOCAL') {
  console.error(`Refusing to seed ${config.environment}. This script is for LOCAL only.`);
  process.exit(1);
}

const app = buildApp(config);
const provisioning = app.modules.customers.provisioning;

const SEED = [
  { customer: 'Acme Industries', email: 'ana@acme.test', password: 'acme-local-password' },
  { customer: 'Globex Corporation', email: 'gil@globex.test', password: 'globex-local-password' },
];

for (const entry of SEED) {
  const customer = provisioning.provisionCustomer(entry.customer);
  const user = await provisioning.provisionUser(customer.id, entry.email, entry.password);

  const actor = { id: user.id, customerId: customer.id };
  const project = app.modules.projects.capability.createProject(actor, {
    name: `${entry.customer} platform`,
    description: `Seeded project owned by ${entry.customer}.`,
  });
  app.modules.releases.capability.createRelease(actor, {
    projectId: project.id,
    version: '1.0.0',
    vcsRef: 'seed0000',
    artifactDigest: 'sha256:seed',
    environment: 'DEV',
  });

  console.log(`seeded ${entry.customer}: sign in as ${entry.email} / ${entry.password}`);
}

app.close();
