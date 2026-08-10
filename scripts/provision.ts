/**
 * Operator provisioning task.
 *
 * Responsibility: create the first customer and user in a deployed environment.
 *
 * Place in the system: an operator task run against a deployment, NOT an application
 * capability. Provisioning is exposed by no HTTP route and no MCP tool, because slice 2
 * introduced no admin role and therefore no authenticated caller entitled to create tenants.
 * Someone with shell access to the deployment is a different trust class from someone with
 * a session, and this script is the seam between them.
 *
 * It takes the password from an environment variable rather than an argument, so it does not
 * land in shell history or a process listing.
 *
 * Usage:
 *   FL_PROVISION_PASSWORD=... node scripts/provision.ts "<customer name>" <email>
 */

import { buildApp } from '../src/spine/app.ts';
import { loadConfig } from '../src/spine/config.ts';

const [customerName, email] = process.argv.slice(2);
const password = process.env.FL_PROVISION_PASSWORD ?? '';

if (customerName === undefined || email === undefined || password === '') {
  console.error('Usage: FL_PROVISION_PASSWORD=... node scripts/provision.ts "<customer>" <email>');
  process.exit(1);
}

if (password.length < 12) {
  // Not a policy — there is none — but a deployed environment should not be seeded with a
  // credential weaker than anything a person would choose.
  console.error('Refusing: the provisioning password must be at least 12 characters.');
  process.exit(1);
}

const config = loadConfig();
const app = buildApp(config);

try {
  const customer = app.modules.customers.provisioning.provisionCustomer(customerName);
  const user = await app.modules.customers.provisioning.provisionUser(customer.id, email, password);

  // Identifiers only. The password is never echoed, including on success.
  console.log(JSON.stringify({
    environment: config.environment,
    customerId: customer.id,
    userId: user.id,
    email: user.email,
  }));
} catch (error) {
  console.error(`Provisioning failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
} finally {
  app.close();
}
