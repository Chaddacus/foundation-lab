/**
 * Application composition.
 *
 * Responsibility: build the whole application object graph — configuration, database,
 * capability modules, the composed route table, and the request listener — without
 * starting a server or a process.
 *
 * Place in the system: spine. This is the dependency-registration and route-composition
 * point named in SPEC §3.1. Adding a capability module means one import and one entry in
 * `modules` here; nothing else in the spine changes.
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
import { createProjectsModule, type ProjectsModule } from '../modules/projects/index.ts';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export interface Application {
  readonly config: Config;
  readonly db: DatabaseSync;
  readonly routes: readonly Route[];
  readonly modules: { readonly projects: ProjectsModule };
  readonly listener: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  readonly close: () => void;
}

/**
 * Compose the application.
 *
 * Migrations run here so that building the app always yields a usable schema — a test and
 * the server reach the same state by the same path.
 */
export function buildApp(config: Config = loadConfig()): Application {
  const db = openDatabase(config);
  const projects = createProjectsModule(db);

  applyMigrations(db, [projects.migration]);

  const routes: readonly Route[] = [...metaRoutes(config), ...projects.routes];
  // Root serves the application shell; each module serves its own UI from its own directory.
  const mounts: readonly StaticMount[] = [
    { prefix: '/modules/projects/', root: join(SRC_ROOT, 'modules', 'projects', 'ui') },
    { prefix: '/', root: join(SRC_ROOT, 'web') },
  ];
  const listener = createRequestListener(routes, config, getTracer(config), createStaticHandler(mounts));

  return {
    config,
    db,
    routes,
    modules: { projects },
    listener,
    close: () => db.close(),
  };
}
