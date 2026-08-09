/**
 * Process bootstrap.
 *
 * Responsibility: start telemetry, build the application, listen, and shut down cleanly.
 *
 * Place in the system: spine, and the only file that owns process lifecycle. Everything it
 * uses is importable and testable without running a process.
 */

import { createServer } from 'node:http';
import { loadConfig } from './config.ts';
import { startTelemetry } from './telemetry.ts';
import { buildApp } from './app.ts';

const config = loadConfig();
// Telemetry starts before the app so the first request is already instrumented.
const stopTelemetry = startTelemetry(config);
const app = buildApp(config);
const server = createServer(app.listener);

server.listen(config.port, '127.0.0.1', () => {
  // Structured startup line: the fields a reader needs to identify exactly what is running.
  console.log(JSON.stringify({
    level: 'info',
    message: 'foundation-lab listening',
    environment: config.environment,
    port: config.port,
    service_version: config.serviceVersion,
    vcs_ref: config.vcsRef,
  }));
});

/** Drain in-flight requests and flush spans before exiting, so shutdown loses no evidence. */
async function shutdown(signal: string): Promise<void> {
  console.log(JSON.stringify({ level: 'info', message: 'shutting down', signal }));
  server.close();
  app.close();
  await stopTelemetry();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
