/**
 * Customers — MCP adapter.
 *
 * Responsibility: expose the caller-scoped read capabilities as bounded MCP tools.
 *
 * Place in the system: an adapter at the edge of the Customers module, peer to the HTTP
 * adapter, calling the same service.
 *
 * Boundary — deliberate omissions, not oversights:
 * - **No login tool.** An MCP client authenticates through the host application; a tool
 *   that exchanged a password for a session would create a second, weaker credential path.
 * - **No user- or customer-provisioning tool.** Slice 2 has no admin role, so no
 *   authenticated caller is entitled to create tenants or accounts.
 *
 * Both omissions are covered by the coverage-parity test, which is told they are intentional.
 */

import type { Actor } from '../../../spine/actor.ts';
import { AppError } from '../../../spine/errors.ts';
import type { CustomersCapability } from '../contract.ts';
import type { McpTool } from '../../projects/adapters/mcp.ts';

export const customersTools: readonly McpTool[] = [
  {
    name: 'get_customer',
    description: "Fetch the calling actor's own customer record by id.",
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Customer id.' } },
      required: ['id'],
      additionalProperties: false,
    },
    sideEffect: 'read',
  },
  {
    name: 'list_users',
    description: "List the users belonging to the calling actor's customer.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    sideEffect: 'read',
  },
];

export function dispatchCustomersTool(
  customers: CustomersCapability,
  actor: Actor,
  toolName: string,
  args: Record<string, unknown> = {},
): unknown {
  switch (toolName) {
    case 'get_customer':
      return customers.getCustomer(actor, args.id as string);

    case 'list_users':
      return customers.listUsers(actor);

    default:
      throw AppError.validation(`Unknown tool "${toolName}".`);
  }
}
