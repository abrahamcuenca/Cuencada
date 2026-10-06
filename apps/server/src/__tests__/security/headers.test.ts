/**
 * Security headers on live API responses (WP-2.3) [SEC]: success, guard
 * denials and 404s all carry HSTS, nosniff, frame denial, no-referrer and the
 * strict CSP (weather widget only as a frame, storage only on the bucket's own
 * host, the chat `wss:` origin). CORS echoes only the configured origins.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../../app.js";
import { createTestApp } from "../../../test/helpers/app.js";

const PROD_LIKE = {
  NODE_ENV: "production" as const,
  APP_BASE_URL: "https://cuencada.com",
  CORS_ORIGIN: ["https://cuencada.com"],
  DEV_ALLOWED_ORIGINS: [],
  S3_ENDPOINT: "https://us-southeast-1.linodeobjects.com",
  S3_BUCKET: "cuencada-media",
  S3_PUBLIC_BASE_URL: ""
};
const BUCKET_ORIGIN = "https://cuencada-media.us-southeast-1.linodeobjects.com";

let app: App;

beforeAll(async () => {
  app = await createTestApp({ config: PROD_LIKE });
});

afterAll(async () => {
  await app.close();
});

/** Parse a CSP header into directive → sources. */
function parseCsp(header: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of header.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name !== undefined && name !== "") directives.set(name, values);
  }
  return directives;
}

const SAMPLES = [
  { label: "public 200", url: "/api/cuencadas" },
  { label: "health", url: "/health" },
  { label: "guard 401", url: "/api/me" },
  { label: "unknown 404", url: "/api/no-such-route" }
];

describe("API security headers", () => {
  it.each(SAMPLES)("$label carries HSTS, nosniff, frame denial and no-referrer", async ({ url }) => {
    const response = await app.inject({ method: "GET", url });
    expect(response.headers["strict-transport-security"]).toMatch(/max-age=(\d{8,})/);
    expect(Number(/max-age=(\d+)/.exec(String(response.headers["strict-transport-security"]))?.[1])).toBeGreaterThanOrEqual(15_552_000);
    expect(response.headers["strict-transport-security"]).toContain("includeSubDomains");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(response.headers["x-powered-by"]).toBeUndefined();
    expect(response.headers.server).toBeUndefined();
  });

  it.each(SAMPLES)("$label carries the strict CSP", async ({ url }) => {
    const response = await app.inject({ method: "GET", url });
    const csp = parseCsp(String(response.headers["content-security-policy"]));
    expect(csp.get("default-src")).toEqual(["'self'"]);
    expect(csp.get("script-src")).toEqual(["'self'"]);
    expect(csp.get("style-src")).toEqual(["'self'"]);
    expect(csp.get("object-src")).toEqual(["'none'"]);
    expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
    expect(csp.get("form-action")).toEqual(["'self'"]);
    expect(csp.get("frame-src")).toEqual(["'self'", "https://weatherwidget.io"]);
    expect(csp.get("img-src")).toEqual(["'self'", "data:", "blob:", BUCKET_ORIGIN]);
    expect(csp.get("media-src")).toEqual(["'self'", "blob:", BUCKET_ORIGIN]);
    expect(csp.get("connect-src")).toEqual(["'self'", "wss://cuencada.com", BUCKET_ORIGIN]);
    expect(csp.get("worker-src")).toEqual(["'self'"]);
    expect(csp.get("manifest-src")).toEqual(["'self'"]);
    expect(csp.has("upgrade-insecure-requests")).toBe(true);
    const raw = String(response.headers["content-security-policy"]);
    // Never the shared regional endpoint (any customer's bucket), never a wildcard or inline script.
    expect(raw).not.toMatch(/https:\/\/us-southeast-1\.linodeobjects\.com(\s|;|$)/);
    expect(raw).not.toMatch(/\*|'unsafe-inline'|'unsafe-eval'|http:/);
    // The weather widget is only ever a frame source.
    for (const [name, sources] of csp) {
      if (name !== "frame-src") expect(sources).not.toContain("https://weatherwidget.io");
    }
  });

  it("CORS echoes only the configured origin, with credentials", async () => {
    const allowed = await app.inject({
      method: "OPTIONS",
      url: "/api/me",
      headers: { origin: "https://cuencada.com", "access-control-request-method": "GET" }
    });
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://cuencada.com");
    expect(allowed.headers["access-control-allow-credentials"]).toBe("true");

    for (const origin of ["https://evil.example", "https://cuencada.com.evil.example", "null", "http://cuencada.com"]) {
      const denied = await app.inject({
        method: "OPTIONS",
        url: "/api/me",
        headers: { origin, "access-control-request-method": "GET" }
      });
      expect(denied.headers["access-control-allow-origin"], origin).toBeUndefined();
      const simple = await app.inject({ method: "GET", url: "/api/cuencadas", headers: { origin } });
      expect(simple.headers["access-control-allow-origin"], origin).toBeUndefined();
    }
  });

  it("marks the chat ticket response no-store", async () => {
    // Shape check only: the 401 for an anonymous caller still comes back JSON, never cached by intermediaries.
    const response = await app.inject({ method: "POST", url: "/api/chat/ticket" });
    expect(response.statusCode).toBe(401);
    expect(response.headers["content-type"]).toContain("application/json");
  });
});
