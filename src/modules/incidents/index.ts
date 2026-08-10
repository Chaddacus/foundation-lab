/**
 * Incidents — module registration. The spine imports THIS file only.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from '../../spine/database.ts';
import type { Route } from '../../spine/http.ts';
import type { Actor } from '../../spine/actor.ts';
import type { McpTool } from '../projects/adapters/mcp.ts';
import type { IncidentsCapability } from './contract.ts';
import { IncidentsRepository, migration } from './repository.ts';
import { IncidentsService, systemClock, type ServiceClock } from './service.ts';
import { incidentsRoutes } from './adapters/http.ts';
import { dispatchIncidentsTool, incidentsTools } from './adapters/mcp.ts';

export interface IncidentsModule {
  readonly name: 'incidents';
  readonly migration: Migration;
  readonly capability: IncidentsCapability;
  readonly routes: readonly Route[];
  readonly tools: readonly McpTool[];
  readonly callTool: (actor: Actor, toolName: string, args?: Record<string, unknown>) => unknown;
}

export function createIncidentsModule(db: DatabaseSync, clock: ServiceClock = systemClock): IncidentsModule {
  const capability = new IncidentsService(new IncidentsRepository(db), clock);
  return {
    name: 'incidents',
    migration,
    capability,
    routes: incidentsRoutes(capability),
    tools: incidentsTools,
    callTool: (actor, toolName, args) => dispatchIncidentsTool(capability, actor, toolName, args),
  };
}

export type { Incident, IncidentsCapability } from './contract.ts';
