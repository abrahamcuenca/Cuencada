/**
 * Connection settings shared by the Vitest global setup and the per-worker
 * helpers. Everything here points at the disposable podman/CI Postgres
 * (`scripts/test-db.sh up`), never at a development or production database.
 */

/** Admin connection to the test cluster's maintenance database. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://cuencada:cuencada@127.0.0.1:55432/cuencada_test";

/** Database that holds the migrated schema and is cloned once per worker. */
export const TEMPLATE_DATABASE_NAME = "cuencada_template";

/** Prefix of the per-worker databases; the Vitest pool id is appended. */
export const WORKER_DATABASE_PREFIX = "cuencada_test_";

/** Matches only the databases this harness creates, so cleanup never touches anything else. */
export const WORKER_DATABASE_PATTERN = /^cuencada_test_\d+$/;

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

/**
 * Name of the database owned by the current Vitest worker.
 *
 * Vitest sets `VITEST_POOL_ID` to a small integer that is unique among the
 * workers running at the same time, so each worker gets an isolated database.
 */
export function workerDatabaseName(): string {
  const poolId = process.env.VITEST_POOL_ID ?? "1";
  if (!/^\d+$/.test(poolId)) {
    throw new Error(`Unexpected VITEST_POOL_ID: ${poolId}`);
  }
  return `${WORKER_DATABASE_PREFIX}${poolId}`;
}

/** Full connection URL for the current worker's database. */
export function workerDatabaseUrl(): string {
  return withDatabase(TEST_DATABASE_URL, workerDatabaseName());
}

/** Quote a Postgres identifier that has already been validated by the caller. */
export function quoteIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
