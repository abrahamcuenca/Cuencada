import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { type AppConfig, loadConfig } from "../../src/config.js";
import { workerDatabaseUrl } from "../env.js";

/** Overrides accepted by {@link createTestApp}. WP-0.4 adds `mailer` / `storage` fakes here. */
export interface TestAppOverrides {
  config?: Partial<AppConfig>;
}

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
    JWT_SECRET: "test-secret-at-least-thirty-two-characters-long",
    CORS_ORIGIN: "http://localhost:5173"
  });
  return { ...base, ...overrides };
}

/**
 * Build the real Fastify app (all plugins and routes) against the worker's
 * test database. Use `app.inject()` to exercise routes; call `app.close()`
 * when done, which also ends the app's database pool.
 *
 * @param overrides - Optional config overrides.
 */
export async function createTestApp(overrides: TestAppOverrides = {}): Promise<FastifyInstance> {
  const app = await buildApp(createTestConfig(overrides.config));
  // buildApp does not close its pool yet (WP-0.4 adds onClose); do it here so
  // test files do not leak connections between runs.
  app.addHook("onClose", async () => {
    await app.db.$client.end();
  });
  await app.ready();
  return app;
}
