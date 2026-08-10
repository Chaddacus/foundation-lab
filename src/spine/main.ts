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

/**
 * Last-resort process handlers.
 *
 * These should be unreachable: the request boundary in `http.ts` catches parsing, handler,
 * and serialization failures. If one fires it means the boundary has a hole, so it is
 * logged as an error with full identity rather than silently swallowed.
 *
 * The process still exits. Continuing after an unknown fault risks serving from corrupted
 * state, and hiding the fault to stay alive is exactly what the constitution forbids —
 * the fix is to close the boundary hole, not to keep running past it.
 */
for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(event, (error: unknown) => {
    app.logger.error(error instanceof Error ? error.message : String(error), {
      module: 'spine',
      operation: event,
      error_type: 'unhandled',
    });
    process.exit(1);
  });
}

server.listen(config.port, config.bindAddress, () => {
  app.logger.info('foundation-lab listening', {
    module: 'spine',
    operation: 'startup',
    port: config.port,
    bind_address: config.bindAddress,
  });
});

/** Drain in-flight requests and flush spans before exiting, so shutdown loses no evidence. */
async function shutdown(signal: string): Promise<void> {
  app.logger.info('shutting down', { module: 'spine', operation: 'shutdown', signal });
  server.close();
  app.close();
  await stopTelemetry();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
