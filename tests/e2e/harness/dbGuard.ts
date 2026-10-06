/**
 * Guards for the e2e database reset [SEC]. The harness runs `DROP DATABASE`,
 * `CREATE DATABASE` and migrations, and an SSH tunnel to the production
 * cluster may also be listening on loopback. So "loopback + `_e2e` name" is
 * not enough. The target must also:
 *
 * 1. use the test container's host port ({@link TEST_DB_PORT}), unless
 *    `E2E_ALLOW_DB_PORT` names the exact other port on purpose;
 * 2. carry the test-cluster marker: the custom setting
 *    `cuencada.test_cluster = 'cuencada-test'` on the cluster's `postgres`
 *    database. `scripts/test-db.sh up` sets it (and CI's e2e job sets it on
 *    its service container). Production never has it.
 *
 * The marker is a database-level setting (`ALTER DATABASE postgres SET …`),
 * so it can be added to an already-running container without recreating it.
 * Older containers get it on their next `scripts/test-db.sh up`; until then
 * the harness refuses with a message saying so (no weaker fallback).
 *
 * Pure (no server imports) so it can be unit-tested.
 */

/** Host port of `scripts/test-db.sh`'s container (and CI's service). */
export const TEST_DB_PORT = 55432;
/** Custom setting that marks a disposable test cluster. */
export const TEST_CLUSTER_SETTING = "cuencada.test_cluster";
/** Expected marker value. */
export const TEST_CLUSTER_MARKER = "cuencada-test";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Thrown when the e2e database target is not provably the test container. */
export class E2eDatabaseGuardError extends Error {
  override name = "E2eDatabaseGuardError";
}

/**
 * Static checks on the URL: loopback host, `*_e2e` name, test-container port.
 *
 * @param databaseUrl - Target URL.
 * @param env - Reads `E2E_ALLOW_DB_PORT` (an explicit, exact port override).
 * @returns The database name.
 * @throws E2eDatabaseGuardError (never echoes the URL: it carries a password).
 */
export function assertE2eDatabaseUrl(databaseUrl: string, env: Readonly<Record<string, string | undefined>> = process.env): string {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new E2eDatabaseGuardError("e2e: E2E_DATABASE_URL is not a valid URL");
  }
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!LOOPBACK_HOSTS.has(url.hostname)) throw new E2eDatabaseGuardError("e2e: the e2e database must be on a loopback host");
  if (!/^[a-z0-9_]+_e2e$/.test(name)) throw new E2eDatabaseGuardError("e2e: the e2e database name must match /^[a-z0-9_]+_e2e$/");
  const port = url.port === "" ? 5432 : Number(url.port);
  const override = env.E2E_ALLOW_DB_PORT;
  const allowed = override !== undefined && override.trim() !== "" ? Number(override) : TEST_DB_PORT;
  if (port !== allowed) {
    throw new E2eDatabaseGuardError(
      `e2e: the e2e database must be the test container on port ${TEST_DB_PORT} (got ${port}). Set E2E_ALLOW_DB_PORT to that exact port only for another disposable test cluster.`
    );
  }
  return name;
}

/** Runs one SQL query on the cluster's `postgres` database and returns the rows. */
export type MarkerQuery = (sql: string) => Promise<ReadonlyArray<Record<string, unknown>>>;

/**
 * Live check, before any DROP/CREATE: the connected cluster carries the
 * test-cluster marker.
 *
 * @param query - Executes SQL on the `postgres` database of the target cluster.
 * @throws E2eDatabaseGuardError when the marker is missing or different.
 */
export async function assertTestClusterMarker(query: MarkerQuery): Promise<void> {
  const rows = await query(`select current_setting('${TEST_CLUSTER_SETTING}', true) as marker`);
  const marker = rows[0]?.marker;
  if (marker !== TEST_CLUSTER_MARKER) {
    throw new E2eDatabaseGuardError(
      `e2e: refusing to touch this cluster: ${TEST_CLUSTER_SETTING} is not '${TEST_CLUSTER_MARKER}'. Run scripts/test-db.sh up (it marks the test container) or point E2E_DATABASE_URL at the test container.`
    );
  }
}
