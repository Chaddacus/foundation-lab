/**
 * Projects — module registration.
 *
 * Responsibility: the module's single public entry point. Builds the module's parts and
 * hands the spine everything it needs: a migration, routes, MCP tools, and the capability.
 *
 * Place in the system: the Projects module boundary. The spine imports THIS file only.
 * Nothing outside the module imports `service.ts`, `repository.ts`, or `domain.ts` — that
 * is what makes the boundary in SPEC §3.2 real rather than aspirational.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from '../../spine/database.ts';
import type { Route } from '../../spine/http.ts';
import type { Actor } from '../../spine/actor.ts';
import type { ProjectsCapability } from './contract.ts';
import { ProjectsRepository, migration } from './repository.ts';
import { ProjectsService, systemClock, type ServiceClock } from './service.ts';
import { projectsRoutes } from './adapters/http.ts';
import { dispatchProjectsTool, projectsTools, type McpTool } from './adapters/mcp.ts';

export interface ProjectsModule {
  readonly name: 'projects';
  readonly migration: Migration;
  readonly capability: ProjectsCapability;
  readonly routes: readonly Route[];
  readonly tools: readonly McpTool[];
  readonly callTool: (actor: Actor, toolName: string, args?: Record<string, unknown>) => unknown;
}

/**
 * Construct the Projects module.
 *
 * The clock is injectable so tests can pin timestamps and ids; production uses the system
 * clock by default.
 */
export function createProjectsModule(db: DatabaseSync, clock: ServiceClock = systemClock): ProjectsModule {
  const capability = new ProjectsService(new ProjectsRepository(db), clock);

  return {
    name: 'projects',
    migration,
    capability,
    routes: projectsRoutes(capability),
    tools: projectsTools,
    callTool: (actor, toolName, args) => dispatchProjectsTool(capability, actor, toolName, args),
  };
}

export type { ProjectsCapability } from './contract.ts';
export type { Project, CreateProjectInput, UpdateProjectInput } from './contract.ts';
