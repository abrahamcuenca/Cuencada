import { describe, expect, it } from "vitest";
import { resolveMigrationUrl } from "./migrate.js";

describe("resolveMigrationUrl", () => {
  it("prefers MIGRATE_DATABASE_URL over DATABASE_URL", () => {
    expect(resolveMigrationUrl({ MIGRATE_DATABASE_URL: "postgres://migrate", DATABASE_URL: "postgres://app" })).toBe(
      "postgres://migrate"
    );
  });

  it("falls back to DATABASE_URL when MIGRATE_DATABASE_URL is unset or empty", () => {
    expect(resolveMigrationUrl({ DATABASE_URL: "postgres://app" })).toBe("postgres://app");
    expect(resolveMigrationUrl({ MIGRATE_DATABASE_URL: "", DATABASE_URL: "postgres://app" })).toBe("postgres://app");
  });

  it("throws when neither is set", () => {
    expect(() => resolveMigrationUrl({})).toThrow(/MIGRATE_DATABASE_URL/);
  });
});
