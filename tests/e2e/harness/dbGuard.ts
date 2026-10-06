/**
 * Guards for the e2e database reset [SEC]. The harness runs `DROP DATABASE`,
 * `CREATE DATABASE` and migrations, and an SSH tunnel to the production
 * cluster may also be listening on loopback. So "loopback + `_e2e` name" is
 * not enough. The target must also:
 *
 * 1. be a plain URL: **no query string and no fragment**. postgres-js turns
 *    query params into connection settings (`?options=-c x=y`,
 *    `?cuencada.test_cluster=…`, `?database=…`), which could forge the
 *    marker per connection or swap the database. Every connection the
 *    harness opens (drop/create, migrate, seed, API) uses the canonical URL
 *    rebuilt here from the parsed host, port, user, password and database;
 *    the raw URL is never passed through;
 * 2. use the test container's host port ({@link TEST_DB_PORT}), unless
 *    `E2E_ALLOW_DB_PORT` names the exact other port on purpose;
 * 3. carry the test-cluster marker **in the catalog**: a database-level
 *    setting `cuencada.test_cluster = 'cuencada-test'` on the cluster's
 *    `postgres` database, read from `pg_db_role_setting` (never from
 *    `current_setting`, which a connection can set for itself).
 *    `scripts/test-db.sh up` sets it (CI's e2e job sets it on its service
 *    container). Production never has it;
 * 4. after connecting, `current_database()` must be the expected `_e2e`
 *    database (see {@link assertCurrentDatabase}).
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
/** Database whose catalog settings carry the marker. */
export const MARKER_DATABASE = "postgres";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const E2E_DATABASE_NAME = /^[a-z0-9_]+_e2e$/;

/** Thrown when the e2e database target is not provably the test container. */
export class E2eDatabaseGuardError extends Error {
  override name = "E2eDatabaseGuardError";
}

/** A checked e2e database target. URLs are canonical: rebuilt from fields, no query, no fragment. */
export interface E2eDatabaseTarget {
  host: string;
  port: number;
  user: string;
  database: string;
  /** Canonical URL of the `_e2e` database (migrate, seed, API). */
  url: string;
  /** Canonical URL of the cluster's `postgres` database (marker check, drop/create). */
  adminUrl: string;
}

function canonicalUrl(host: string, port: number, user: string, password: string, database: string): string {
  const auth = `${encodeURIComponent(user)}${password === "" ? "" : `:${encodeURIComponent(password)}`}@`;
  return `postgresql://${auth}${host}:${port}/${encodeURIComponent(database)}`;
}

/**
 * Static checks on the URL and the canonical connection URLs built from it.
 *
 * @param databaseUrl - `E2E_DATABASE_URL`.
 * @param env - Reads `E2E_ALLOW_DB_PORT` (an explicit, exact port override).
 * @throws E2eDatabaseGuardError (never echoes the URL: it carries a password).
 */
export function resolveE2eDatabase(databaseUrl: string, env: Readonly<Record<string, string | undefined>> = process.env): E2eDatabaseTarget {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new E2eDatabaseGuardError("e2e: E2E_DATABASE_URL is not a valid URL");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new E2eDatabaseGuardError("e2e: E2E_DATABASE_URL must be a postgresql:// URL");
  }
  // `url.search`/`url.hash` are "" for a bare "?"/"#", so check the raw string too.
  if (url.search !== "" || url.hash !== "" || databaseUrl.includes("?") || databaseUrl.includes("#")) {
    throw new E2eDatabaseGuardError("e2e: E2E_DATABASE_URL must not have a query string or fragment (they become connection settings)");
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) throw new E2eDatabaseGuardError("e2e: the e2e database must be on a loopback host");
  let database: string;
  try {
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new E2eDatabaseGuardError("e2e: the e2e database name is not valid");
  }
  if (!E2E_DATABASE_NAME.test(database)) throw new E2eDatabaseGuardError("e2e: the e2e database name must match /^[a-z0-9_]+_e2e$/");
  const port = url.port === "" ? 5432 : Number(url.port);
  const override = env.E2E_ALLOW_DB_PORT;
  const allowed = override !== undefined && override.trim() !== "" ? Number(override) : TEST_DB_PORT;
  if (port !== allowed) {
    throw new E2eDatabaseGuardError(
      `e2e: the e2e database must be the test container on port ${TEST_DB_PORT} (got ${port}). Set E2E_ALLOW_DB_PORT to that exact port only for another disposable test cluster.`
    );
  }
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  return {
    host: url.hostname,
    port,
    user,
    database,
    url: canonicalUrl(url.hostname, port, user, password, database),
    adminUrl: canonicalUrl(url.hostname, port, user, password, MARKER_DATABASE)
  };
}

/** Runs one SQL query (with positional parameters) and returns the rows. */
export type GuardQuery = (sql: string, params?: readonly string[]) => Promise<ReadonlyArray<Record<string, unknown>>>;

/** Catalog lookup of the marker; a per-connection `SET`/`options` cannot satisfy it. */
export const MARKER_CATALOG_SQL =
  "select 1 as ok from pg_db_role_setting s join pg_database d on d.oid = s.setdatabase where d.datname = $1 and s.setrole = 0 and $2 = any(s.setconfig)";

/**
 * Live check, before any DROP/CREATE: the cluster's catalog carries the
 * test-cluster marker on {@link MARKER_DATABASE} (database-level, all roles).
 *
 * @param query - Executes SQL on the target cluster.
 * @param markerDatabase - Database whose settings are checked (tests only override it).
 * @throws E2eDatabaseGuardError when the marker is missing.
 */
export async function assertTestClusterMarker(query: GuardQuery, markerDatabase: string = MARKER_DATABASE): Promise<void> {
  const rows = await query(MARKER_CATALOG_SQL, [markerDatabase, `${TEST_CLUSTER_SETTING}=${TEST_CLUSTER_MARKER}`]);
  if (rows.length === 0) {
    throw new E2eDatabaseGuardError(
      `e2e: refusing to touch this cluster: the database '${markerDatabase}' has no catalog setting ${TEST_CLUSTER_SETTING}=${TEST_CLUSTER_MARKER}. Run scripts/test-db.sh up (it marks the test container) or point E2E_DATABASE_URL at the test container.`
    );
  }
}

/**
 * After connecting to the e2e database (migrate, seed, API): the server
 * must report the expected database.
 *
 * @param query - Executes SQL on the open connection.
 * @param expected - The checked `_e2e` database name.
 * @throws E2eDatabaseGuardError on a mismatch.
 */
export async function assertCurrentDatabase(query: GuardQuery, expected: string): Promise<void> {
  const rows = await query("select current_database() as name");
  const name = rows[0]?.name;
  if (name !== expected) {
    throw new E2eDatabaseGuardError("e2e: connected to a different database than the checked e2e database; refusing to continue");
  }
}
