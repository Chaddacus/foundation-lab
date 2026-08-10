/**
 * Application composition.
 *
 * Responsibility: build the whole application object graph — configuration, database,
 * capability modules, the composed route table, and the request listener — without
 * starting a server or a process.
 *
 * Place in the system: spine. This is the dependency-registration and route-composition
 * point named in SPEC §3.1. Adding a capability module still means editing four places in
 * this file — import, `routes`, `mounts`, and the `Application` type — and the static mount
 * reaches into each module's internal directory layout rather than asking the module for it.
 * With five modules that repetition is now real rather than hypothetical, and a registry is
 * the first refactor of slice 4. It is listed in SPEC §10 rather than quietly tolerated.
 *
 * Boundary: no business logic, and no process lifecycle. `main.ts` owns the process so this
 * function stays callable from a test.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { loadConfig, type Config } from './config.ts';
import { applyMigrations, openDatabase } from './database.ts';
import { createRequestListener, type Route } from './http.ts';
import { metaRoutes } from './meta.ts';
import { createStaticHandler, type StaticMount } from './static.ts';
import { getTracer } from './telemetry.ts';
import { createLogger, type Logger } from './logger.ts';
import { createCustomersModule, type CustomersModule } from '../modules/customers/index.ts';
import { createProjectsModule, type ProjectsModule } from '../modules/projects/index.ts';
import { createReleasesModule, type ReleasesModule } from '../modules/releases/index.ts';
import { createIncidentsModule, type IncidentsModule } from '../modules/incidents/index.ts';
import { createTriageModule, type TriageModule } from '../modules/triage/index.ts';
import { ClaudeCliGateway, type AiGateway } from './ai-gateway.ts';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export interface Application {
  readonly config: Config;
  readonly db: DatabaseSync;
  readonly routes: readonly Route[];
  readonly logger: Logger;
  readonly modules: {
    readonly customers: CustomersModule;
    readonly projects: ProjectsModule;
    readonly releases: ReleasesModule;
    readonly incidents: IncidentsModule;
    readonly triage: TriageModule;
  };
  readonly listener: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  readonly close: () => void;
}

/**
 * Capability names the triage grounding check validates against.
 *
 * Derived from what the application actually has, so a model naming a module that does not
 * exist is rejected rather than believed.
 */
const MODULE_NAMES: readonly string[] = ['customers', 'projects', 'releases', 'incidents'];

/**
 * Build the application.
 *
 * `gateway` is injectable so tests and the eval runner can substitute a recorded provider —
 * that substitution is what keeps a routine test run from spending subscription capacity.
 */
export function buildApp(config: Config = loadConfig(), gateway: AiGateway = new ClaudeCliGateway()): Application {
  const db = openDatabase(config);

  // Customers first: it owns the `customers` table that users reference, and it supplies
  // the authentication hook the request boundary needs.
  const customers = createCustomersModule(db, config);
  const projects = createProjectsModule(db);
  // Releases depends on the Projects CAPABILITY, not its storage — the tenant rule for
  // projects has exactly one owner.
  const releases = createReleasesModule(db, projects.capability);
  const incidents = createIncidentsModule(db);
  // Triage depends on the Incidents CAPABILITY and on the gateway INTERFACE, so it holds no
  // provider detail and no second copy of the incident tenant rule.
  const triage = createTriageModule(incidents.capability, gateway, () => MODULE_NAMES);

  applyMigrations(db, [
    customers.migration, projects.migration, releases.migration, incidents.migration,
  ]);

  const routes: readonly Route[] = [
    ...metaRoutes(config),
    ...customers.routes,
    ...projects.routes,
    ...releases.routes,
    ...incidents.routes,
    ...triage.routes,
  ];

  // Root serves the application shell; each module serves its own UI from its own directory.
  const mounts: readonly StaticMount[] = [
    { prefix: '/modules/customers/', root: join(SRC_ROOT, 'modules', 'customers', 'ui') },
    { prefix: '/modules/projects/', root: join(SRC_ROOT, 'modules', 'projects', 'ui') },
    { prefix: '/modules/releases/', root: join(SRC_ROOT, 'modules', 'releases', 'ui') },
    { prefix: '/modules/incidents/', root: join(SRC_ROOT, 'modules', 'incidents', 'ui') },
    { prefix: '/modules/triage/', root: join(SRC_ROOT, 'modules', 'triage', 'ui') },
    { prefix: '/', root: join(SRC_ROOT, 'web') },
  ];

  const logger = createLogger(config);
  const listener = createRequestListener(
    routes,
    config,
    getTracer(config),
    createStaticHandler(mounts),
    logger,
    customers.authenticate,
  );

  return {
    config,
    db,
    routes,
    logger,
    modules: { customers, projects, releases, incidents, triage },
    listener,
    close: () => db.close(),
  };
}
