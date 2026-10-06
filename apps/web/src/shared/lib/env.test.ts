import { describe, expect, it } from "vitest";
import { EnvConfigError, resolveApiBaseUrl } from "./env";

const ORIGIN = "https://cuencada.com";

describe("resolveApiBaseUrl", () => {
  it("defaults to /api on the page origin when unset or blank", () => {
    expect(resolveApiBaseUrl(undefined, ORIGIN)).toBe("https://cuencada.com/api");
    expect(resolveApiBaseUrl("  ", ORIGIN)).toBe("https://cuencada.com/api");
  });

  it("accepts an absolute https URL and strips the trailing slash", () => {
    expect(resolveApiBaseUrl("https://api.cuencada.com/v1/", ORIGIN)).toBe("https://api.cuencada.com/v1");
  });

  it("throws EnvConfigError for protocol-relative, non-http, credentialed or query URLs", () => {
    for (const bad of ["//evil.example/api", "javascript:alert(1)", "ftp://cuencada.com", "https://u:p@cuencada.com/api", "/api?x=1"]) {
      expect(() => resolveApiBaseUrl(bad, ORIGIN), bad).toThrow(EnvConfigError);
    }
  });
});
