import { type App, type AppDeps, buildApp } from "../../src/app.js";
import { type AppConfig, loadConfig } from "../../src/config.js";
import type { Clock } from "../../src/lib/clock.js";
import type { LogStream } from "../../src/logging.js";
import type { Mailer } from "../../src/lib/mailer/types.js";
import type { StorageService } from "../../src/lib/storage/types.js";
import { workerDatabaseUrl } from "./db.js";
import { FakeMailer, FakeStorage } from "./fakes.js";

/** Overrides accepted by {@link createTestApp}. */
export interface TestAppOverrides {
  config?: Partial<AppConfig>;
  /** Defaults to a new {@link FakeMailer}; pass your own to assert on its outbox. */
  mailer?: Mailer;
  /** Defaults to a new {@link FakeStorage}. */
  storage?: StorageService;
  clock?: Clock;
  /** Capture the app's pino output (tests log nothing otherwise). */
  logStream?: LogStream;
  /**
   * Register extra routes before `ready()` (test-only fixtures such as a
   * route that throws). They inherit the real guard and error handler.
   */
  routes?: (app: App) => void | Promise<void>;
}

/** Test JWT secret (also used by tests that sign tokens by hand). */
export const TEST_JWT_SECRET = "test-secret-at-least-thirty-two-characters-long";

/**
 * Validated application config for tests, pointing at the current worker's
 * database. Built from an explicit env object (not `process.env`) so a local
 * `.env` can never redirect tests to a real database.
 *
 * @param overrides - Fields to replace after validation.
 */
export function createTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: workerDatabaseUrl(),
    JWT_SECRET: TEST_JWT_SECRET,
    APP_BASE_URL: "http://localhost:5173",
    CORS_ORIGIN: "http://localhost:5173"
  });
  return { ...base, ...overrides };
}

/**
 * Build the real Fastify app (all plugins and routes) against the worker's
 * test database, with a fake mailer and fake storage by default. Use
 * `app.inject()` to exercise routes; `app.close()` also ends the app's pool.
 *
 * @param overrides - Optional config overrides and injected services.
 */
export async function createTestApp(overrides: TestAppOverrides = {}): Promise<App> {
  const deps: AppDeps = {
    mailer: overrides.mailer ?? new FakeMailer(),
    storage: overrides.storage ?? new FakeStorage()
  };
  if (overrides.clock !== undefined) deps.clock = overrides.clock;
  if (overrides.logStream !== undefined) deps.logStream = overrides.logStream;
  const app = await buildApp(createTestConfig(overrides.config), deps);
  if (overrides.routes !== undefined) await overrides.routes(app);
  await app.ready();
  return app;
}
