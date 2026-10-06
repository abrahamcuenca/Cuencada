import { describe, expect, it, vi } from "vitest";
import { assertE2eDatabaseUrl, assertTestClusterMarker, E2eDatabaseGuardError, type MarkerQuery } from "./dbGuard.js";

const TEST_URL = "postgresql://cuencada:secret@127.0.0.1:55432/cuencada_e2e";

describe("assertE2eDatabaseUrl", () => {
  it("accepts the test container's loopback *_e2e database on port 55432", () => {
    expect(assertE2eDatabaseUrl(TEST_URL, {})).toBe("cuencada_e2e");
  });

  it("refuses another port (e.g. a tunnel to production on loopback) without the override", () => {
    expect(() => assertE2eDatabaseUrl("postgresql://cuencada:secret@127.0.0.1:15432/cuencada_e2e", {})).toThrow(E2eDatabaseGuardError);
    expect(() => assertE2eDatabaseUrl("postgresql://cuencada:secret@localhost/cuencada_e2e", {})).toThrow(/port 55432/);
  });

  it("accepts another port only when E2E_ALLOW_DB_PORT names exactly that port", () => {
    const url = "postgresql://cuencada:secret@127.0.0.1:15433/cuencada_e2e";
    expect(assertE2eDatabaseUrl(url, { E2E_ALLOW_DB_PORT: "15433" })).toBe("cuencada_e2e");
    expect(() => assertE2eDatabaseUrl(url, { E2E_ALLOW_DB_PORT: "15432" })).toThrow(E2eDatabaseGuardError);
  });

  it("refuses a non-loopback host or a name without the _e2e suffix", () => {
    expect(() => assertE2eDatabaseUrl("postgresql://u:p@db.example.test:55432/cuencada_e2e", {})).toThrow(/loopback/);
    expect(() => assertE2eDatabaseUrl("postgresql://u:p@127.0.0.1:55432/cuencada", {})).toThrow(/_e2e/);
  });

  it("never echoes the URL (it carries the password)", () => {
    try {
      assertE2eDatabaseUrl("postgresql://u:topsecret@127.0.0.1:15432/cuencada_e2e", {});
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain("topsecret");
    }
  });
});

describe("assertTestClusterMarker", () => {
  it("passes when the cluster carries the test marker", async () => {
    const query = vi.fn<MarkerQuery>().mockResolvedValue([{ marker: "cuencada-test" }]);
    await expect(assertTestClusterMarker(query)).resolves.toBeUndefined();
    expect(query.mock.calls[0]?.[0]).toContain("current_setting('cuencada.test_cluster', true)");
  });

  it("refuses a cluster without the marker (current_setting returns null)", async () => {
    await expect(assertTestClusterMarker(async () => [{ marker: null }])).rejects.toThrow(E2eDatabaseGuardError);
    await expect(assertTestClusterMarker(async () => [{ marker: "" }])).rejects.toThrow(/scripts\/test-db\.sh up/);
  });

  it("refuses a different marker value", async () => {
    await expect(assertTestClusterMarker(async () => [{ marker: "production" }])).rejects.toThrow(E2eDatabaseGuardError);
  });
});
