import { randomBytes } from "node:crypto";

/**
 * Connection settings and database naming shared by the Vitest global setup
 * and the per-worker helpers. Everything here points at the disposable
 * podman/CI Postgres (`scripts/test-db.sh up`), never at a real database.
 *
 * Several test runs (e.g. Phase-1 worktrees) may share one container, so every
 * database the harness creates is namespaced by a run id:
 *
 *   cuencada_tpl_<epochSeconds>_<hex6>            migrated template for one run
 *   cuencada_test_<epochSeconds>_<hex6>_<poolId>  one per Vitest worker
 *
 * The timestamp lets a later run recognise databases abandoned by a crashed run.
 */

const DEFAULT_TEST_DATABASE_URL = "postgresql://cuencada:cuencada@127.0.0.1:55432/cuencada_test";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Set to "1" to allow a non-loopback test cluster (e.g. a remote CI service). */
export const ALLOW_REMOTE_ENV = "CUENCADA_TEST_DB_ALLOW_REMOTE";

/**
 * Throw unless `rawUrl` names a loopback host and a database whose name ends
 * in `_test`. Turns "only ever point tests at the disposable cluster" from a
 * convention into a guarantee, since the harness creates and drops databases.
 *
 * @param rawUrl - Candidate `TEST_DATABASE_URL`.
 * @param allowRemote - Skip the loopback check (explicit opt-out).
 * @returns The validated URL.
 */
export function assertSafeTestDatabaseUrl(rawUrl: string, allowRemote: boolean): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    throw new Error("TEST_DATABASE_URL is not a valid URL", { cause: error });
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!databaseName.endsWith("_test")) {
    throw new Error(`Refusing to run tests: TEST_DATABASE_URL database "${databaseName}" must end in "_test".`);
  }
  if (!allowRemote && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      `Refusing to run tests: TEST_DATABASE_URL host "${url.hostname}" is not loopback. Set ${ALLOW_REMOTE_ENV}=1 to override.`
    );
  }
  return rawUrl;
}

/** Admin connection to the test cluster's maintenance database (validated). */
export const TEST_DATABASE_URL = assertSafeTestDatabaseUrl(
  process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL,
  process.env[ALLOW_REMOTE_ENV] === "1"
);

/** Key under which globalSetup `provide`s the run id to workers. */
export const RUN_ID_KEY = "testRunId";

declare module "vitest" {
  export interface ProvidedContext {
    testRunId: string;
  }
}

const RUN_ID_PATTERN = /^\d{10}_[0-9a-f]{6}$/;

/**
 * Matches exactly the databases this harness creates (templates have no pool
 * suffix, worker databases must have one). Named groups: `runId`, `seconds`.
 */
export const HARNESS_DATABASE_PATTERN =
  /^cuencada_(?:tpl_(?<tplRun>(?<tplSeconds>\d{10})_[0-9a-f]{6})|test_(?<testRun>(?<testSeconds>\d{10})_[0-9a-f]{6})_\d+)$/;

/** Parse a harness database name into its run id and creation time, or `null` for any other database. */
export function parseHarnessDatabaseName(name: string): { runId: string; createdAtSeconds: number } | null {
  const groups = HARNESS_DATABASE_PATTERN.exec(name)?.groups;
  const runId = groups?.tplRun ?? groups?.testRun;
  const seconds = groups?.tplSeconds ?? groups?.testSeconds;
  if (!runId || !seconds) return null;
  return { runId, createdAtSeconds: Number(seconds) };
}

/** New run id: `<epochSeconds>_<6 hex chars>`. */
export function createRunId(now: Date = new Date()): string {
  return `${Math.floor(now.getTime() / 1000)}_${randomBytes(3).toString("hex")}`;
}

function assertRunId(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error(`Invalid test run id: ${runId}`);
  return runId;
}

/** Template database for a run. */
export function templateDatabaseName(runId: string): string {
  return `cuencada_tpl_${assertRunId(runId)}`;
}

/**
 * Worker database for a run. `VITEST_POOL_ID` is unique among the workers of
 * one run at any moment, so each worker gets an isolated database.
 */
export function workerDatabaseName(runId: string, poolId: string = process.env.VITEST_POOL_ID ?? "1"): string {
  if (!/^\d+$/.test(poolId)) throw new Error(`Unexpected VITEST_POOL_ID: ${poolId}`);
  return `cuencada_test_${assertRunId(runId)}_${poolId}`;
}

/**
 * Return a copy of `baseUrl` that targets `databaseName` on the same server.
 *
 * @param baseUrl - Any Postgres URL for the test cluster.
 * @param databaseName - Database to connect to instead.
 */
export function withDatabase(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

/** Quote a Postgres identifier that has already been validated by the caller. */
export function quoteIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
