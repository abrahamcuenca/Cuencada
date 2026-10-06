import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, createTestConfig } from "../../test/helpers/app.js";
import { getTestDb } from "../../test/helpers/db.js";
import { bearerFor, createSession, createUser, loginAs } from "../../test/helpers/factories.js";
import { type App, buildApp } from "../app.js";
import { sessions, users } from "../db/schema/index.js";
import { authUser } from "./auth.js";

interface ErrorBody {
  error: { code: string };
}

const ORIGIN = "http://localhost:5173";

async function registerFixtures(app: App): Promise<void> {
  const whoami = async (request: Parameters<typeof authUser>[0]) => {
    const user = authUser(request);
    return { id: user.id, role: user.role, sessionId: user.sessionId, emailVerified: user.emailVerified };
  };
  app.get("/t/public", { config: { auth: "public" } }, async (request) => ({ user: request.user }));
  app.get("/t/default", whoami);
  app.get("/t/user", { config: { auth: "user" } }, whoami);
  app.get("/t/admin", { config: { auth: "admin" } }, whoami);
  app.get("/t/pending", { config: { auth: "user", allowPendingPasswordChange: true } }, whoami);
  app.get("/t/verified", { config: { auth: "user", requireVerifiedEmail: true } }, whoami);
  app.post("/t/cookie", { config: { auth: "cookie" } }, async (request) => ({ user: request.user }));
}

function code(response: { json: <T>() => T }): string {
  return response.json<ErrorBody>().error.code;
}

describe("auth guard", () => {
  let app: App;

  beforeAll(async () => {
    app = await createTestApp({ routes: registerFixtures });
  });

  afterAll(async () => {
    await app.close();
  });

  it("lets public routes through without a token and leaves request.user null", async () => {
    const response = await app.inject({ method: "GET", url: "/t/public" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ user: null });
  });

  it("treats a route without config.auth as a user route (default deny)", async () => {
    const response = await app.inject({ method: "GET", url: "/t/default" });

    expect(response.statusCode).toBe(401);
    expect(code(response)).toBe("UNAUTHENTICATED");
  });

  it("answers 401 UNAUTHENTICATED for a missing, malformed or non-bearer token", async () => {
    const responses = await Promise.all([
      app.inject({ method: "GET", url: "/t/user" }),
      app.inject({ method: "GET", url: "/t/user", headers: { authorization: "Bearer not.a.jwt" } }),
      app.inject({ method: "GET", url: "/t/user", headers: { authorization: "Basic dXNlcjpwYXNz" } })
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(401);
      expect(code(response)).toBe("UNAUTHENTICATED");
    }
  });

  it("answers 401 UNAUTHENTICATED for a token signed with another secret", async () => {
    const user = await createUser();
    const session = await createSession(user.id);
    const auth = await bearerFor(user, session, { secret: "another-secret-that-is-also-long-enough-123" });

    const response = await app.inject({ method: "GET", url: "/t/user", ...auth });

    expect(response.statusCode).toBe(401);
    expect(code(response)).toBe("UNAUTHENTICATED");
  });

  it("answers 401 TOKEN_EXPIRED for an expired token so the client refreshes", async () => {
    const user = await createUser();
    const session = await createSession(user.id);
    const auth = await bearerFor(user, session, { now: new Date(Date.now() - 2 * 60 * 60 * 1000), ttlSeconds: 60 });

    const response = await app.inject({ method: "GET", url: "/t/user", ...auth });

    expect(response.statusCode).toBe(401);
    expect(code(response)).toBe("TOKEN_EXPIRED");
  });

  it("decorates request.user from the database for a valid token", async () => {
    const user = await createUser({ emailVerified: true });
    const session = await createSession(user.id);

    const response = await app.inject({ method: "GET", url: "/t/user", ...(await bearerFor(user, session)) });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: user.id, role: "member", sessionId: session.id, emailVerified: true });
  });

  it("rejects a revoked session", async () => {
    const user = await createUser();
    const session = await createSession(user.id, { revoked: true });

    const response = await app.inject({ method: "GET", url: "/t/user", ...(await bearerFor(user, session)) });

    expect(response.statusCode).toBe(401);
    expect(code(response)).toBe("UNAUTHENTICATED");
  });

  it("rejects an idle-expired or absolutely-expired session", async () => {
    const user = await createUser();
    const past = new Date(Date.now() - 1000);
    const idle = await createSession(user.id, { idleExpiresAt: past, absoluteExpiresAt: new Date(Date.now() + 1e6) });
    const absolute = await createSession(user.id, { idleExpiresAt: past, absoluteExpiresAt: past });

    const idleResponse = await app.inject({ method: "GET", url: "/t/user", ...(await bearerFor(user, idle)) });
    const absoluteResponse = await app.inject({ method: "GET", url: "/t/user", ...(await bearerFor(user, absolute)) });

    expect(idleResponse.statusCode).toBe(401);
    expect(absoluteResponse.statusCode).toBe(401);
  });

  it("rejects a session that does not exist or belongs to another user", async () => {
    const user = await createUser();
    const other = await createUser();
    const otherSession = await createSession(other.id);

    const missing = await app.inject({
      method: "GET",
      url: "/t/user",
      ...(await bearerFor(user, { id: "00000000-0000-4000-8000-000000000000" }))
    });
    const foreign = await app.inject({ method: "GET", url: "/t/user", ...(await bearerFor(user, otherSession)) });

    expect(missing.statusCode).toBe(401);
    expect(foreign.statusCode).toBe(401);
  });

  it("rejects a disabled user even with a live session and valid token", async () => {
    const user = await createUser();
    const auth = await loginAs(app, user);
    await getTestDb().update(users).set({ status: "disabled" }).where(eq(users.id, user.id));

    const response = await app.inject({ method: "GET", url: "/t/user", ...auth });

    expect(response.statusCode).toBe(401);
    expect(code(response)).toBe("UNAUTHENTICATED");
  });

  it("uses the role from the database, not the claims: a member claiming admin gets 403", async () => {
    const member = await createUser();
    const session = await createSession(member.id);
    const forged = await bearerFor(member, session, { role: "admin" });

    const response = await app.inject({ method: "GET", url: "/t/admin", ...forged });

    expect(response.statusCode).toBe(403);
    expect(code(response)).toBe("FORBIDDEN");
  });

  it("lets a real admin through and applies demotion immediately", async () => {
    const admin = await createUser({ role: "admin" });
    const auth = await loginAs(app, admin);

    const before = await app.inject({ method: "GET", url: "/t/admin", ...auth });
    await getTestDb().update(users).set({ role: "member" }).where(eq(users.id, admin.id));
    const after = await app.inject({ method: "GET", url: "/t/admin", ...auth });

    expect(before.statusCode).toBe(200);
    expect(after.statusCode).toBe(403);
  });

  it("gates must-change users with 403 PASSWORD_CHANGE_REQUIRED except on allowlisted routes", async () => {
    const user = await createUser({ mustChangePassword: true });
    const auth = await loginAs(app, user);

    const gated = await app.inject({ method: "GET", url: "/t/user", ...auth });
    const allowed = await app.inject({ method: "GET", url: "/t/pending", ...auth });
    const me = await app.inject({ method: "GET", url: "/api/me", ...auth });

    expect(gated.statusCode).toBe(403);
    expect(code(gated)).toBe("PASSWORD_CHANGE_REQUIRED");
    expect(allowed.statusCode).toBe(200);
    expect(me.statusCode).toBe(200);
  });

  it("enforces must-change from the database even when the token claims mcp=false", async () => {
    const user = await createUser({ mustChangePassword: true });
    const session = await createSession(user.id);
    const forged = await bearerFor(user, session, { mustChangePassword: false });

    const response = await app.inject({ method: "GET", url: "/t/user", ...forged });

    expect(code(response)).toBe("PASSWORD_CHANGE_REQUIRED");
  });

  it("requires a verified email on requireVerifiedEmail routes", async () => {
    const unverified = await createUser();
    const verified = await createUser({ emailVerified: true });

    const denied = await app.inject({ method: "GET", url: "/t/verified", ...(await loginAs(app, unverified)) });
    const granted = await app.inject({ method: "GET", url: "/t/verified", ...(await loginAs(app, verified)) });

    expect(denied.statusCode).toBe(403);
    expect(code(denied)).toBe("EMAIL_UNVERIFIED");
    expect(granted.statusCode).toBe(200);
  });

  it("touches sessions.last_used_at at most once per minute", async () => {
    const user = await createUser();
    const stale = new Date(Date.now() - 5 * 60 * 1000);
    const fresh = new Date(Date.now() - 10 * 1000);
    const staleSession = await createSession(user.id, { lastUsedAt: stale });
    const freshSession = await createSession(user.id, { lastUsedAt: fresh });

    await app.inject({ method: "GET", url: "/t/user", ...(await bearerFor(user, staleSession)) });
    await app.inject({ method: "GET", url: "/t/user", ...(await bearerFor(user, freshSession)) });

    const [staleRow] = await getTestDb().select().from(sessions).where(eq(sessions.id, staleSession.id));
    const [freshRow] = await getTestDb().select().from(sessions).where(eq(sessions.id, freshSession.id));
    expect(staleRow?.lastUsedAt.getTime()).toBeGreaterThan(stale.getTime());
    expect(freshRow?.lastUsedAt.getTime()).toBe(fresh.getTime());
  });

  describe("cookie routes (CSRF)", () => {
    it("rejects a request without the CSRF header", async () => {
      const response = await app.inject({ method: "POST", url: "/t/cookie", headers: { origin: ORIGIN } });

      expect(response.statusCode).toBe(403);
      expect(code(response)).toBe("CSRF_FAILED");
    });

    it("rejects a wrong, missing or look-alike Origin", async () => {
      const origins = ["https://evil.example", "http://localhost:5173.evil.example", "null", undefined];
      for (const origin of origins) {
        const headers: Record<string, string> = { "x-cuencada-csrf": "1" };
        if (origin !== undefined) headers.origin = origin;
        const response = await app.inject({ method: "POST", url: "/t/cookie", headers });

        expect(response.statusCode).toBe(403);
        expect(code(response)).toBe("CSRF_FAILED");
      }
    });

    it("rejects a CSRF header with a value other than 1", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/t/cookie",
        headers: { origin: ORIGIN, "x-cuencada-csrf": "true" }
      });

      expect(code(response)).toBe("CSRF_FAILED");
    });

    it("passes with the header and an exact allowed Origin, without a bearer token", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/t/cookie",
        headers: { origin: ORIGIN, "x-cuencada-csrf": "1" }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ user: null });
    });
  });
});

describe("auth guard in production", () => {
  it("does not accept the Vite dev origin on cookie routes", async () => {
    const app = await createTestApp({
      config: { NODE_ENV: "production", LOG_LEVEL: "silent", CORS_ORIGIN: ["https://cuencada.com"], DEV_ALLOWED_ORIGINS: [] },
      routes: (instance) => {
        instance.post("/t/cookie", { config: { auth: "cookie" } }, async () => ({ ok: true }));
      }
    });
    try {
      const dev = await app.inject({
        method: "POST",
        url: "/t/cookie",
        headers: { origin: ORIGIN, "x-cuencada-csrf": "1" }
      });
      const prod = await app.inject({
        method: "POST",
        url: "/t/cookie",
        headers: { origin: "https://cuencada.com", "x-cuencada-csrf": "1" }
      });

      expect(dev.statusCode).toBe(403);
      expect(prod.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe("route config validation", () => {
  it("refuses to boot with an unknown config.auth value", async () => {
    const app = await buildApp(createTestConfig());
    try {
      expect(() =>
        app.get(
          "/t/bad",
          // Deliberately invalid value to prove boot-time validation.
          { config: { auth: "everyone" as unknown as "public" } },
          async () => ({})
        )
      ).toThrow(/invalid config.auth/);
    } finally {
      await app.close();
    }
  });

  it("refuses allowPendingPasswordChange on a public route", async () => {
    const app = await buildApp(createTestConfig());
    try {
      expect(() =>
        app.get("/t/bad", { config: { auth: "public", allowPendingPasswordChange: true } }, async () => ({}))
      ).toThrow(/need auth "user" or "admin"/);
    } finally {
      await app.close();
    }
  });
});
