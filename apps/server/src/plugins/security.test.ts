import { describe, expect, it } from "vitest";
import {
  contentSecurityPolicy,
  contentSecurityPolicyDirectives,
  storageOrigins
} from "./security.js";

const base = {
  APP_BASE_URL: "https://cuencada.com",
  CORS_ORIGIN: ["https://cuencada.com"],
  DEV_ALLOWED_ORIGINS: ["http://localhost:5173"],
  S3_ENDPOINT: "https://us-southeast-1.linodeobjects.com",
  S3_BUCKET: "cuencada",
  S3_PUBLIC_BASE_URL: ""
};

describe("storageOrigins", () => {
  it("includes only the bucket-specific host, never the shared regional endpoint", () => {
    expect(storageOrigins(base)).toEqual(["https://cuencada.us-southeast-1.linodeobjects.com"]);
  });

  it("adds a configured public base URL", () => {
    expect(storageOrigins({ ...base, S3_PUBLIC_BASE_URL: "https://media.cuencada.com/x" })).toEqual([
      "https://cuencada.us-southeast-1.linodeobjects.com",
      "https://media.cuencada.com"
    ]);
  });

  it("is empty when storage is not configured", () => {
    expect(storageOrigins({ S3_ENDPOINT: "", S3_BUCKET: "", S3_PUBLIC_BASE_URL: "" })).toEqual([]);
    expect(storageOrigins({ ...base, S3_BUCKET: "" })).toEqual([]);
  });
});

describe("contentSecurityPolicyDirectives", () => {
  it("is strict in production: no third-party script, frames only from self and the weather widget", () => {
    const directives = contentSecurityPolicyDirectives({ ...base, NODE_ENV: "production" });

    expect(directives["default-src"]).toEqual(["'self'"]);
    expect(directives["script-src"]).toEqual(["'self'"]);
    expect(directives["frame-src"]).toEqual(["'self'", "https://weatherwidget.io"]);
    expect(directives["img-src"]).toContain("https://cuencada.us-southeast-1.linodeobjects.com");
    expect(directives["connect-src"]).toContain("wss://cuencada.com");
    expect(directives["connect-src"]).not.toContain("http://localhost:5173");
    expect(directives["upgrade-insecure-requests"]).toEqual([]);
    for (const [name, values] of Object.entries(directives)) {
      if (name !== "frame-src") expect(values).not.toContain("https://weatherwidget.io");
    }
    expect(JSON.stringify(directives)).not.toContain('"https://us-southeast-1.linodeobjects.com"');
  });

  it("allows the Vite dev origin only outside production", () => {
    const directives = contentSecurityPolicyDirectives({ ...base, NODE_ENV: "development" });

    expect(directives["connect-src"]).toEqual(expect.arrayContaining(["http://localhost:5173", "ws://localhost:5173"]));
    expect(directives).not.toHaveProperty("upgrade-insecure-requests");
  });
});

describe("contentSecurityPolicy", () => {
  it("renders a header value for nginx", () => {
    const header = contentSecurityPolicy({ ...base, NODE_ENV: "production" });

    expect(header).toContain("default-src 'self'; base-uri 'self'; object-src 'none'");
    expect(header).toContain(
      "connect-src 'self' wss://cuencada.com https://cuencada.us-southeast-1.linodeobjects.com"
    );
    expect(header.endsWith("upgrade-insecure-requests")).toBe(true);
  });
});
