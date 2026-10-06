import postgres from "postgres";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  assertCurrentDatabase,
  assertTestClusterMarker,
  E2eDatabaseGuardError,
  type GuardQuery,
  resolveE2eDatabase,
  TEST_CLUSTER_MARKER,
  TEST_CLUSTER_SETTING
} from "./dbGuard.js";

const TEST_URL = "postgresql://cuencada:secret@127.0.0.1:55432/cuencada_e2e";

describe("resolveE2eDatabase", () => {
  it("accepts the test container's loopback *_e2e database and returns canonical URLs", () => {
    const target = resolveE2eDatabase(TEST_URL, {});
    expect(target).toMatchObject({ host: "127.0.0.1", port: 55432, user: "cuencada", database: "cuencada_e2e" });
    expect(target.url).toBe(TEST_URL);
    expect(target.adminUrl).toBe("postgresql://cuencada:secret@127.0.0.1:55432/postgres");
  });

  it("re-encodes credentials instead of passing the raw URL through", () => {
    const target = resolveE2eDatabase("postgresql://e2e%40user:p%2Fa%3Fss@localhost:55432/x_e2e", {});
    expect(target.url).toBe("postgresql://e2e%40user:p%2Fa%3Fss@localhost:55432/x_e2e");
    expect(new URL(target.url).search).toBe("");
  });

  it.each([
    ["options (forged GUC)", `${TEST_URL}?options=-c%20cuencada.test_cluster%3Dcuencada-test`],
    ["database override", `${TEST_URL}?database=cuencada_test`],
    ["the marker as a connection param", `${TEST_URL}?cuencada.test_cluster=cuencada-test`],
    ["the full bypass", "postgresql://u:p@127.0.0.1:15432/x_e2e?database=cuencada&cuencada.test_cluster=cuencada-test"],
    ["an empty query", `${TEST_URL}?`]
  ])("refuses a query string: %s", (_label, url) => {
    expect(() => resolveE2eDatabase(url, { E2E_ALLOW_DB_PORT: "15432" })).toThrow(/query string or fragment/);
  });

  it("refuses a fragment", () => {
    expect(() => resolveE2eDatabase(`${TEST_URL}#database=cuencada`, {})).toThrow(/query string or fragment/);
    expect(() => resolveE2eDatabase(`${TEST_URL}#`, {})).toThrow(E2eDatabaseGuardError);
  });

  it("refuses another port (e.g. a tunnel to production on loopback) without the override", () => {
    expect(() => resolveE2eDatabase("postgresql://cuencada:secret@127.0.0.1:15432/cuencada_e2e", {})).toThrow(/port 55432/);
    expect(() => resolveE2eDatabase("postgresql://cuencada:secret@localhost/cuencada_e2e", {})).toThrow(/port 55432/);
  });

  it("accepts another port only when E2E_ALLOW_DB_PORT names exactly that port", () => {
    const url = "postgresql://cuencada:secret@127.0.0.1:15433/cuencada_e2e";
    expect(resolveE2eDatabase(url, { E2E_ALLOW_DB_PORT: "15433" }).port).toBe(15433);
    expect(() => resolveE2eDatabase(url, { E2E_ALLOW_DB_PORT: "15432" })).toThrow(E2eDatabaseGuardError);
  });

  it("refuses a non-loopback host, a non-postgres scheme or a name without the _e2e suffix", () => {
    expect(() => resolveE2eDatabase("postgresql://u:p@db.example.test:55432/cuencada_e2e", {})).toThrow(/loopback/);
    expect(() => resolveE2eDatabase("mysql://u:p@127.0.0.1:55432/cuencada_e2e", {})).toThrow(/postgresql/);
    expect(() => resolveE2eDatabase("postgresql://u:p@127.0.0.1:55432/cuencada", {})).toThrow(/_e2e/);
  });

  it("never echoes the URL (it carries the password)", () => {
    try {
      resolveE2eDatabase("postgresql://u:topsecret@127.0.0.1:15432/cuencada_e2e?x=1", {});
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain("topsecret");
    }
  });
});

describe("assertTestClusterMarker", () => {
  it("passes when the catalog query finds the database-level marker", async () => {
    const query = vi.fn<GuardQuery>().mockResolvedValue([{ ok: 1 }]);
    await expect(assertTestClusterMarker(query)).resolves.toBeUndefined();
    const [sql, params] = query.mock.calls[0] ?? [];
    expect(sql).toContain("pg_db_role_setting");
    expect(sql).not.toContain("current_setting");
    expect(params).toEqual(["postgres", `${TEST_CLUSTER_SETTING}=${TEST_CLUSTER_MARKER}`]);
  });

  it("refuses a cluster without the marker in the catalog", async () => {
    await expect(assertTestClusterMarker(async () => [])).rejects.toThrow(/scripts\/test-db\.sh up/);
  });
});

describe("assertCurrentDatabase", () => {
  it("passes on the expected database", async () => {
    await expect(assertCurrentDatabase(async () => [{ name: "cuencada_e2e" }], "cuencada_e2e")).resolves.toBeUndefined();
  });

  it("refuses a mismatch", async () => {
    await expect(assertCurrentDatabase(async () => [{ name: "cuencada" }], "cuencada_e2e")).rejects.toThrow(E2eDatabaseGuardError);
    await expect(assertCurrentDatabase(async () => [], "cuencada_e2e")).rejects.toThrow(E2eDatabaseGuardError);
  });
});

/**
 * Against the real test Postgres (the same cluster `pnpm test` already needs):
 * a per-connection GUC forged through the driver's `options` makes
 * `current_setting` report the marker, but the catalog check is not fooled.
 * The database checked is `cuencada_test`, which never carries the marker.
 */
describe("marker check against the test container", () => {
  const base = process.env.TEST_DATABASE_URL ?? "postgresql://cuencada:cuencada@127.0.0.1:55432/cuencada_test";
  const forged = postgres(base, {
    max: 1,
    onnotice: () => {},
    connection: { options: `-c ${TEST_CLUSTER_SETTING}=${TEST_CLUSTER_MARKER}` }
  });
  const query: GuardQuery = (sql, params = []) => forged.unsafe(sql, [...params]);

  afterAll(async () => {
    await forged.end();
  });

  it("the forged GUC is visible to current_setting on that connection (the attack)", async () => {
    const rows = await forged.unsafe(`select current_setting('${TEST_CLUSTER_SETTING}', true) as marker`);
    expect(rows[0]?.marker).toBe(TEST_CLUSTER_MARKER);
  });

  it("but the catalog check refuses a database without the database-level marker", async () => {
    await expect(assertTestClusterMarker(query, "cuencada_test")).rejects.toThrow(E2eDatabaseGuardError);
  });

  it("and current_database() reports the real database, so a mismatch is refused", async () => {
    await expect(assertCurrentDatabase(query, "cuencada_e2e")).rejects.toThrow(E2eDatabaseGuardError);
  });
});
