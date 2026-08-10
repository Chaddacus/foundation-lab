/**
 * Customers — module registration.
 *
 * Responsibility: the module's single public entry point. Builds its parts and hands the
 * spine a migration, routes, MCP tools, the capability, and the `authenticate` function the
 * request boundary uses to resolve every session.
 *
 * Place in the system: the Customers module boundary. The spine imports THIS file only.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from '../../spine/database.ts';
import type { Route } from '../../spine/http.ts';
import type { Actor } from '../../spine/actor.ts';
import type { Config } from '../../spine/config.ts';
import type { CustomersCapability } from './contract.ts';
import { CustomersRepository, migration } from './repository.ts';
import { CustomersService, systemAuthClock, type AuthClock } from './service.ts';
import { customersRoutes } from './adapters/http.ts';
import { customersTools, dispatchCustomersTool } from './adapters/mcp.ts';
import type { McpTool } from '../projects/adapters/mcp.ts';

export interface CustomersModule {
  readonly name: 'customers';
  readonly migration: Migration;
  readonly capability: CustomersCapability;
  /** Provisioning, which no adapter exposes. Used by the local seed and by tests. */
  readonly provisioning: CustomersService;
  readonly routes: readonly Route[];
  readonly tools: readonly McpTool[];
  readonly callTool: (actor: Actor, toolName: string, args?: Record<string, unknown>) => unknown;
  /** Resolve a verified session id to its actor. The spine's authentication hook. */
  readonly authenticate: (sessionId: string) => Actor | null;
}

export function createCustomersModule(
  db: DatabaseSync,
  config: Config,
  clock: AuthClock = systemAuthClock,
): CustomersModule {
  const service = new CustomersService(new CustomersRepository(db), clock);

  return {
    name: 'customers',
    migration,
    capability: service,
    provisioning: service,
    routes: customersRoutes(service, config),
    tools: customersTools,
    callTool: (actor, toolName, args) => dispatchCustomersTool(service, actor, toolName, args),
    authenticate: (sessionId) => service.resolveSession(sessionId),
  };
}

export type { Customer, User, CustomersCapability } from './contract.ts';
