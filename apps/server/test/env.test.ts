import { describe, expect, it } from "vitest";
import {
  assertSafeTestDatabaseUrl,
  createRunId,
  HARNESS_DATABASE_PATTERN,
  parseHarnessDatabaseName,
  templateDatabaseName,
  workerDatabaseName
} from "./env.js";

describe("assertSafeTestDatabaseUrl", () => {
  it("accepts a loopback URL whose database ends in _test", () => {
    const url = "postgresql://u:p@127.0.0.1:55432/cuencada_test";
    expect(assertSafeTestDatabaseUrl(url, false)).toBe(url);
    expect(assertSafeTestDatabaseUrl("postgresql://u:p@localhost/x_test", false)).toBeTruthy();
    expect(assertSafeTestDatabaseUrl("postgresql://u:p@[::1]:5432/x_test", false)).toBeTruthy();
  });

  it("throws when the database name does not end in _test", () => {
    expect(() => assertSafeTestDatabaseUrl("postgresql://u:p@127.0.0.1/cuencada", false)).toThrow(/must end in "_test"/);
  });

  it("throws when the host is not loopback and no opt-out is given", () => {
    expect(() => assertSafeTestDatabaseUrl("postgresql://u:p@db.example.com/cuencada_test", false)).toThrow(
      /not loopback/
    );
  });

  it("accepts a remote host only with the explicit opt-out", () => {
    expect(assertSafeTestDatabaseUrl("postgresql://u:p@db.example.com/cuencada_test", true)).toBeTruthy();
  });

  it("keeps the _test requirement even with the opt-out", () => {
    expect(() => assertSafeTestDatabaseUrl("postgresql://u:p@db.example.com/prod", true)).toThrow();
  });
});

describe("database naming", () => {
  it("namespaces template and worker databases by run id", () => {
    const runId = createRunId(new Date("2026-10-06T00:00:00Z"));

    expect(runId).toMatch(/^1791244800_[0-9a-f]{6}$/);
    expect(templateDatabaseName(runId)).toBe(`cuencada_tpl_${runId}`);
    expect(workerDatabaseName(runId, "3")).toBe(`cuencada_test_${runId}_3`);
  });

  it("recognises harness databases but not the maintenance database", () => {
    expect(HARNESS_DATABASE_PATTERN.test("cuencada_tpl_1791244800_abcdef")).toBe(true);
    expect(HARNESS_DATABASE_PATTERN.test("cuencada_test_1791244800_abcdef_2")).toBe(true);
    expect(HARNESS_DATABASE_PATTERN.test("cuencada_test")).toBe(false);
    expect(HARNESS_DATABASE_PATTERN.test("cuencada_tpl_1791244800_abcdef_2")).toBe(false);
    expect(HARNESS_DATABASE_PATTERN.test("cuencada_test_1791244800_abcdef")).toBe(false);
    expect(HARNESS_DATABASE_PATTERN.test("cuencada")).toBe(false);
  });

  it("parses the run id and creation time from a harness database name", () => {
    expect(parseHarnessDatabaseName("cuencada_test_1791244800_abcdef_2")).toEqual({
      runId: "1791244800_abcdef",
      createdAtSeconds: 1791244800
    });
    expect(parseHarnessDatabaseName("cuencada_tpl_1791244800_abcdef")?.runId).toBe("1791244800_abcdef");
    expect(parseHarnessDatabaseName("postgres")).toBeNull();
  });

  it("throws for a malformed run id or pool id", () => {
    expect(() => templateDatabaseName("x; drop database y")).toThrow();
    expect(() => workerDatabaseName("1791244800_abcdef", "1 or 1")).toThrow();
  });
});
