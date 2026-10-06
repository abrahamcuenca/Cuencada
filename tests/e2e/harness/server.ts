/**
 * E2E harness entrypoint (run by Playwright's `webServer`, via tsx):
 *
 * 1. refuse to start unless `E2E=1`, and always when the process has
 *    `NODE_ENV=production`; the API config it builds forces `NODE_ENV=test`
 *    (it never reads the shell's NODE_ENV or other env into the config);
 * 2. wipe the run directory, reset + migrate + seed the `*_e2e` database;
 * 3. start the local object store (presigned PUT/GET) on loopback;
 * 4. build the REAL API from `apps/server/dist` with `buildApp`, injecting
 *    only the test-only mail sink and object store, and listen.
 *
 * Everything else (routes, auth, rate limits, jobs, chat sockets) is the
 * production code path. `apps/server/dist/index.js` is not used only because
 * it cannot take injected services; its shutdown handling is mirrored here.
 */
import { rmSync } from "node:fs";
import { buildApp } from "../../../apps/server/dist/app.js";
import { loadConfig } from "../../../apps/server/dist/config.js";
import { LocalObjectStore } from "./localObjectStore.js";
import { FileSinkMailer } from "./mailSink.js";
import { prepareE2eDatabase } from "./seed.js";
import { createSelfSignedCert } from "./tls.js";
import {
  API_PORT,
  E2E_DATABASE_URL,
  E2E_RUN_DIR,
  MAIL_DIR,
  STORAGE_DIR,
  STORAGE_ORIGIN,
  STORAGE_PORT,
  TLS_DIR,
  WEB_ORIGIN
} from "./settings.js";

/** Fixed, non-secret JWT key for the throwaway e2e database. */
const E2E_JWT_SECRET = "e2e-only-jwt-secret-not-used-anywhere-else-000";

function assertTestOnly(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("e2e harness: refusing to start with NODE_ENV=production");
  }
  if (process.env.E2E !== "1") throw new Error("e2e harness: set E2E=1 to start the test-only harness");
}

async function main(): Promise<void> {
  assertTestOnly();
  rmSync(E2E_RUN_DIR, { recursive: true, force: true });
  await prepareE2eDatabase(E2E_DATABASE_URL);

  const config = loadConfig({
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: String(API_PORT),
    LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? "warn",
    APP_BASE_URL: WEB_ORIGIN,
    CORS_ORIGIN: WEB_ORIGIN,
    DEV_ALLOWED_ORIGINS: WEB_ORIGIN,
    // The preview proxy is on loopback; specs give each browser context its
    // own X-Forwarded-For so per-IP rate limits do not couple the journeys.
    TRUST_PROXY: "loopback",
    DATABASE_URL: E2E_DATABASE_URL,
    JWT_SECRET: E2E_JWT_SECRET,
    // The preview is HTTPS, so the production cookie shape (`__Secure-`, Secure) applies.
    COOKIE_SECURE: "true",
    SUPPORT_EMAIL: "soporte@e2e.example.test",
    MEDIA_REQUIRE_APPROVAL: "false",
    S3_ENDPOINT: STORAGE_ORIGIN,
    S3_BUCKET: "e2e"
  });

  const storage = new LocalObjectStore({ origin: STORAGE_ORIGIN, dir: STORAGE_DIR, allowedOrigin: WEB_ORIGIN });
  const storageServer = await storage.listen(STORAGE_PORT, createSelfSignedCert(TLS_DIR));
  const app = await buildApp(config, { mailer: new FileSinkMailer(MAIL_DIR, config.NODE_ENV), storage });

  const shutdown = async (): Promise<void> => {
    storageServer.close();
    await app.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());

  await app.listen({ host: config.HOST, port: config.PORT });
  process.stdout.write(`e2e harness: API on ${config.PORT}, storage on ${STORAGE_PORT}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`e2e harness failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
