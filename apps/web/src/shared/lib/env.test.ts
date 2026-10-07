import { describe, expect, it } from "vitest";
import { EnvConfigError, resolveApiBaseUrl, resolveMediaUploadOrigin } from "./env";

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

  it("rejects absolute http: in production but allows https: and same-origin paths", () => {
    expect(() => resolveApiBaseUrl("http://api.cuencada.com", ORIGIN, true)).toThrow(EnvConfigError);
    expect(resolveApiBaseUrl("https://api.cuencada.com", ORIGIN, true)).toBe("https://api.cuencada.com");
    expect(resolveApiBaseUrl("/api", "http://localhost:4173", true)).toBe("http://localhost:4173/api");
    expect(resolveApiBaseUrl("http://127.0.0.1:3006/api", ORIGIN, false)).toBe("http://127.0.0.1:3006/api");
  });
});

describe("resolveMediaUploadOrigin", () => {
  it("returns null when unset or blank (uploads are refused)", () => {
    expect(resolveMediaUploadOrigin(undefined)).toBeNull();
    expect(resolveMediaUploadOrigin("  ")).toBeNull();
  });

  it("normalises an origin and allows a bare trailing slash", () => {
    expect(resolveMediaUploadOrigin("https://cuencada.us-east-1.linodeobjects.com/", true)).toBe("https://cuencada.us-east-1.linodeobjects.com");
    expect(resolveMediaUploadOrigin("http://127.0.0.1:9000")).toBe("http://127.0.0.1:9000");
  });

  it("rejects http: in production", () => {
    expect(() => resolveMediaUploadOrigin("http://bucket.example", true)).toThrow(EnvConfigError);
  });

  it("throws EnvConfigError for malformed values, other schemes, credentials, paths and queries", () => {
    for (const bad of ["bucket.example", "ftp://bucket.example", "https://u:p@bucket.example", "https://bucket.example/cuencada", "https://bucket.example/?x=1"]) {
      expect(() => resolveMediaUploadOrigin(bad), bad).toThrow(EnvConfigError);
    }
  });
});
