import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestApp } from "../test/helpers/app.js";
import { getTestDb } from "../test/helpers/db.js";
import { createUser, loginAs } from "../test/helpers/factories.js";
import type { App } from "./app.js";
import { auditLogs } from "./db/schema/index.js";

describe("buildApp", () => {
  let app: App;

  beforeEach(async () => {
    app = await createTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns health status for the API", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, service: "cuencada-api" });
  });

  it("reports readiness with a working database", async () => {
    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, service: "cuencada-api", db: true });
  });

  it("answers 404 NOT_FOUND in the ApiError envelope for unknown routes, even without a token", async () => {
    const response = await app.inject({ method: "GET", url: "/api/no-such-route" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: "NOT_FOUND", message: expect.any(String) } });
  });

  it("sends strict security headers including the CSP", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    const csp = String(response.headers["content-security-policy"]);

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("frame-src 'self' https://weatherwidget.io;");
    expect(csp).toContain("script-src 'self';");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("answers CORS preflight for an allowed origin with credentials", async () => {
    const response = await app.inject({
      method: "OPTIONS",
      url: "/api/auth/refresh",
      headers: { origin: "http://localhost:5173", "access-control-request-method": "POST" }
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("does not grant CORS to an unknown origin", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://evil.example" }
    });

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("keeps the scaffold routes, serves the real invite accept and drops the old gallery route", async () => {
    expect(app.hasRoute({ method: "POST", url: "/api/auth/login" })).toBe(true);
    expect(app.hasRoute({ method: "GET", url: "/api/cuencadas/:year" })).toBe(true);
    expect(app.hasRoute({ method: "POST", url: "/api/invites/accept" })).toBe(true);
    expect(app.hasRoute({ method: "POST", url: "/api/cuencadas/:year/gallery/upload-url" })).toBe(false);
  });
});

describe("/health/ready", () => {
  it("caches the DB ping for about 5 seconds and is rate-limited", async () => {
    let now = new Date("2026-10-06T12:00:00Z").getTime();
    const app = await createTestApp({ clock: { now: () => new Date(now) } });
    try {
      const ping = vi.spyOn(app.db, "$client");
      const ready = () => app.inject({ method: "GET", url: "/health/ready" });

      expect((await ready()).statusCode).toBe(200);
      expect((await ready()).statusCode).toBe(200);
      expect(ping).toHaveBeenCalledTimes(1);
      now += 6000;
      expect((await ready()).statusCode).toBe(200);
      expect(ping).toHaveBeenCalledTimes(2);

      let last = 0;
      for (let index = 0; index < 60; index += 1) last = (await ready()).statusCode;
      expect(last).toBe(429);
    } finally {
      await app.close();
    }
  });

  it("answers 503 with db false when the database is unreachable", async () => {
    const app = await createTestApp({
      config: { DATABASE_URL: "postgresql://cuencada:cuencada@127.0.0.1:1/cuencada_test" }
    });
    try {
      const response = await app.inject({ method: "GET", url: "/health/ready" });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ ok: false, service: "cuencada-api", db: false });
    } finally {
      await app.close();
    }
  });
});

describe("login rate limits across emails and IPs", () => {
  let app: App | undefined;

  afterEach(async () => {
    await app?.close();
  });

  async function attempt(instance: App, email: string, forwardedFor?: string): Promise<number> {
    const response = await instance.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password: "wrong-password" },
      ...(forwardedFor === undefined ? {} : { headers: { "x-forwarded-for": forwardedFor } })
    });
    return response.statusCode;
  }

  it("caps one IP spraying many emails at 20 per window", async () => {
    app = await createTestApp();
    const statuses: number[] = [];
    for (let index = 0; index < 21; index += 1) statuses.push(await attempt(app, `rociada${index}@example.test`));

    expect(statuses.slice(0, 20).every((status) => status === 401)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  it("caps one email attacked from many IPs at 10 per window", async () => {
    app = await createTestApp({ config: { TRUST_PROXY: ["loopback"] } });
    const statuses: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      statuses.push(await attempt(app, "objetivo@example.test", `203.0.113.${index + 1}`));
    }

    expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect(await attempt(app, "otra@example.test", "203.0.113.200")).toBe(401);
  });
});

describe("cuencada routes", () => {
  let app: App;

  beforeEach(async () => {
    app = await createTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("serves the public 2026 Cuencada without a token", async () => {
    const response = await app.inject({ method: "GET", url: "/api/cuencadas/2026" });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ cuencada: { year: number } }>().cuencada.year).toBe(2026);
  });

  it("answers 404 NOT_FOUND for an unknown year and 400 VALIDATION for a bad year", async () => {
    const missing = await app.inject({ method: "GET", url: "/api/cuencadas/2030" });
    const invalid = await app.inject({ method: "GET", url: "/api/cuencadas/abc" });

    expect(missing.statusCode).toBe(404);
    expect(missing.json<{ error: { code: string } }>().error.code).toBe("NOT_FOUND");
    expect(invalid.statusCode).toBe(400);
  });

  it("lets an admin create a Cuencada and audits it; members get 403", async () => {
    const admin = await createUser({ role: "admin" });
    const member = await createUser();
    const payload = {
      year: 2027,
      title: "Cuencada 2027",
      startsAt: "2027-09-12T00:00:00-06:00",
      endsAt: "2027-09-17T23:59:59-06:00",
      city: "Mérida",
      state: "Yucatán",
      description: "La próxima reunión."
    };

    const forbidden = await app.inject({
      method: "POST",
      url: "/api/admin/cuencadas",
      payload,
      ...(await loginAs(app, member))
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/cuencadas",
      payload,
      ...(await loginAs(app, admin))
    });

    expect(forbidden.statusCode).toBe(403);
    expect(created.statusCode).toBe(201);
    const audits = await getTestDb().select().from(auditLogs).where(eq(auditLogs.action, "cuencada.created"));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorUserId).toBe(admin.id);
  });
});
