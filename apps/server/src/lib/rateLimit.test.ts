import type { FastifyRequest } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../test/helpers/app.js";
import type { App } from "../app.js";
import { emailKeyPart, ipKey, rateLimitByEmail, rateLimitByIp, rateLimitByIpAndEmail } from "./rateLimit.js";

function fakeRequest(ip: string, body: unknown): FastifyRequest {
  return { ip, body } as unknown as FastifyRequest; // only `ip` and `body` are read by the key generators
}

describe("emailKeyPart", () => {
  it("normalizes case and whitespace before hashing and never contains the email", () => {
    const key = emailKeyPart("  Ana@Example.COM ");

    expect(key).toBe(emailKeyPart("ana@example.com"));
    expect(key).not.toContain("ana");
    expect(key).toMatch(/^[0-9a-f]{32}$/);
  });

  it("returns none for missing, empty or non-string emails", () => {
    expect(emailKeyPart(undefined)).toBe("none");
    expect(emailKeyPart("   ")).toBe("none");
    expect(emailKeyPart(42)).toBe("none");
  });
});

describe("rate-limit configs", () => {
  it("keys by IP in onRequest", () => {
    const config = rateLimitByIp({ max: 5, timeWindow: "1 minute" });

    expect(config.hook).toBeUndefined();
    expect(ipKey(fakeRequest("203.0.113.1", undefined))).toBe("ip:203.0.113.1");
  });

  it("keys by IP plus normalized email after the body is parsed", async () => {
    const config = rateLimitByIpAndEmail({ max: 5, timeWindow: "1 minute" });
    const keyOf = config.keyGenerator;

    expect(config.hook).toBe("preHandler");
    expect(await keyOf?.(fakeRequest("203.0.113.1", { email: "Ana@x.test" }))).toBe(
      await keyOf?.(fakeRequest("203.0.113.1", { email: "ana@x.test" }))
    );
    expect(await keyOf?.(fakeRequest("203.0.113.1", { email: "a@x.test" }))).not.toBe(
      await keyOf?.(fakeRequest("203.0.113.2", { email: "a@x.test" }))
    );
  });

  it("keys by email alone across IPs", async () => {
    const keyOf = rateLimitByEmail({ max: 5, timeWindow: "1 minute" }).keyGenerator;

    expect(await keyOf?.(fakeRequest("203.0.113.1", { email: "a@x.test" }))).toBe(
      await keyOf?.(fakeRequest("198.51.100.9", { email: "a@x.test" }))
    );
  });
});

describe("rate limiting behind the proxy", () => {
  let app: App | undefined;

  afterEach(async () => {
    await app?.close();
  });

  async function hit(instance: App, forwardedFor: string): Promise<number> {
    const response = await instance.inject({
      method: "GET",
      url: "/t/limited",
      headers: { "x-forwarded-for": forwardedFor }
    });
    return response.statusCode;
  }

  function routes(instance: App): void {
    instance.get(
      "/t/limited",
      { config: { auth: "public", rateLimit: rateLimitByIp({ max: 1, timeWindow: "1 minute" }) } },
      async () => ({ ok: true })
    );
  }

  it("uses the forwarded client IP when the proxy is trusted", async () => {
    app = await createTestApp({ config: { TRUST_PROXY: ["loopback"] }, routes });

    expect(await hit(app, "203.0.113.1")).toBe(200);
    expect(await hit(app, "203.0.113.2")).toBe(200);
    expect(await hit(app, "203.0.113.1")).toBe(429);
  });

  it("ignores X-Forwarded-For when the proxy is not trusted, so clients cannot rotate keys", async () => {
    app = await createTestApp({ config: { TRUST_PROXY: false }, routes });

    expect(await hit(app, "203.0.113.1")).toBe(200);
    expect(await hit(app, "203.0.113.2")).toBe(429);
  });
});
