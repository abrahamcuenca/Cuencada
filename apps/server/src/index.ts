/**
 * Server entrypoint: load config, build the app, listen, and shut down
 * gracefully on SIGTERM/SIGINT (stop accepting, finish in-flight requests,
 * drain jobs, close the DB pool).
 */
import { buildApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";

/** Hard limit for a graceful shutdown before the process exits anyway. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

function loadConfigOrExit(): ReturnType<typeof loadConfig> {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      // Names the offending keys only, never their values.
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

const config = loadConfigOrExit();
const app = await buildApp(config);

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  const forceExit = setTimeout(() => {
    app.log.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, "graceful shutdown timed out; exiting");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, "error during shutdown");
    process.exit(1);
  }
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, (received) => {
    void shutdown(received);
  });
}

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.fatal({ err: error }, "failed to start");
  await app.close();
  process.exit(1);
}
