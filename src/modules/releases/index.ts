/**
 * Releases — module registration.
 *
 * Responsibility: the module's single public entry point. Builds its parts and hands the
 * spine a migration, routes, MCP tools, and the capability.
 *
 * Place in the system: the Releases module boundary. It receives the Projects CAPABILITY,
 * not the projects repository or database rows — the dependency is on a public contract,
 * which is what makes the boundary in SPEC §3.2 real.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from '../../spine/database.ts';
import type { Route } from '../../spine/http.ts';
import type { Actor } from '../../spine/actor.ts';
import type { ProjectsCapability } from '../projects/contract.ts';
import type { McpTool } from '../projects/adapters/mcp.ts';
import type { ReleasesCapability } from './contract.ts';
import { ReleasesRepository, migration } from './repository.ts';
import { ReleasesService, systemClock, type ServiceClock } from './service.ts';
import { releasesRoutes } from './adapters/http.ts';
import { dispatchReleasesTool, releasesTools } from './adapters/mcp.ts';

export interface ReleasesModule {
  readonly name: 'releases';
  readonly migration: Migration;
  readonly capability: ReleasesCapability;
  readonly routes: readonly Route[];
  readonly tools: readonly McpTool[];
  readonly callTool: (actor: Actor, toolName: string, args?: Record<string, unknown>) => unknown;
}

export function createReleasesModule(
  db: DatabaseSync,
  projects: ProjectsCapability,
  clock: ServiceClock = systemClock,
): ReleasesModule {
  const capability = new ReleasesService(new ReleasesRepository(db), projects, clock);

  return {
    name: 'releases',
    migration,
    capability,
    routes: releasesRoutes(capability),
    tools: releasesTools,
    callTool: (actor, toolName, args) => dispatchReleasesTool(capability, actor, toolName, args),
  };
}

export type { Release, ReleasesCapability, CreateReleaseInput } from './contract.ts';
