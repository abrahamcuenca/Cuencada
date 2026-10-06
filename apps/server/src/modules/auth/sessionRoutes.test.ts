import { and, eq } from "drizzle-orm";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import {
  CSRF_HEADERS,
  DAY_MS,
  loginFull,
  refreshCookie,
  TestClock,
  withRefreshCookie
} from "../../../test/helpers/auth.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { bearerFor, createSession, createUser } from "../../../test/helpers/factories.js";
import type { App } from "../../app.js";
import { auditLogs, people, refreshTokens, sessions, users } from "../../db/schema/index.js";
import { hashPassword } from "../../lib/passwords.js";
import { hashToken } from "../../lib/tokens.js";
import { REFRESH_REUSE_GRACE_MS } from "./sessions.js";

let app: App | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function code(response: { json: <T>() => T }): string {
  return response.json<{ error: { code: string } }>().error.code;
}

async function auditCount(action: string, entityId?: string): Promise<number> {
  const rows = await getTestDb()
    .select()
    .from(auditLogs)
    .where(entityId === undefined ? eq(auditLogs.action, action) : and(eq(auditLogs.action, action), eq(auditLogs.entityId, entityId)));
  return rows.length;
}

function refresh(instance: App, token: string): Promise<LightMyRequestResponse> {
  return instance.inject({ method: "POST", url: "/api/auth/refresh", ...withRefreshCookie(token) });
}

describe("POST /api/auth/login", () => {
  it("returns an AuthTokenResponse, sets the HttpOnly SameSite=Strict refresh cookie and audits", async () => {
    app = await createTestApp();
    const user = await createUser({ email: "Prima@Example.test", role: "admin", mustChangePassword: true });

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "user-agent": "Vitest/1.0" },
      payload: { email: "PRIMA@example.test", password: user.password }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ accessToken: string; accessTokenExpiresAt: string; user: unknown }>();
    expect(body.user).toEqual({
      id: user.id,
      email: "prima@example.test",
      displayName: user.displayName,
      role: "admin",
      status: "active",
      mustChangePassword: true,
      emailVerified: false,
      personId: null,
      avatarUrl: null
    });
    expect(body.accessToken.split(".")).toHaveLength(3);
    expect(JSON.stringify(body)).not.toContain("refresh");
    const cookie = refreshCookie(response);
    expect(cookie).toMatchObject({ path: "/api/auth", httpOnly: true, sameSite: "Strict", maxAge: 30 * 24 * 60 * 60 });
    expect(cookie?.secure).not.toBe(true);
    const [session] = await getTestDb().select().from(sessions).where(eq(sessions.userId, user.id));
    expect(session?.userAgent).toBe("Vitest/1.0");
    const [token] = await getTestDb().select().from(refreshTokens).where(eq(refreshTokens.sessionId, session?.id ?? ""));
    expect(token?.tokenHash).toBe(hashToken(cookie?.value ?? ""));
    expect(token?.tokenHash).not.toBe(cookie?.value);
    const [row] = await getTestDb().select().from(users).where(eq(users.id, user.id));
    expect(row?.lastLoginAt).not.toBeNull();
    expect(await auditCount("auth.logged_in", session?.id)).toBe(1);
  });

  it("uses the __Secure- cookie name with Secure when COOKIE_SECURE is on", async () => {
    app = await createTestApp({ config: { COOKIE_SECURE: true } });
    const user = await createUser();

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: user.email, password: user.password }
    });

    const cookie = refreshCookie(response, "__Secure-cuencada_rt");
    expect(cookie?.secure).toBe(true);
    expect(refreshCookie(response)).toBeUndefined();
  });

  it("returns the same 401 INVALID_CREDENTIALS for a wrong password, an unknown email and a disabled user", async () => {
    app = await createTestApp();
    const user = await createUser();
    const disabled = await createUser({ status: "disabled" });

    const responses = await Promise.all([
      app.inject({ method: "POST", url: "/api/auth/login", payload: { email: user.email, password: "wrong-password" } }),
      app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "nadie@example.test", password: "x" } }),
      app.inject({ method: "POST", url: "/api/auth/login", payload: { email: disabled.email, password: disabled.password } })
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: { code: "INVALID_CREDENTIALS", message: "Correo o contraseña incorrectos." } });
      expect(refreshCookie(response)).toBeUndefined();
    }
    expect(await auditCount("auth.login_failed", user.id)).toBe(1);
    expect(await auditCount("auth.login_failed", disabled.id)).toBe(1);
  });

  it("takes comparable time for unknown and known emails (dummy argon2 verify)", async () => {
    app = await createTestApp();
    // Production-cost hash, so both branches run the same argon2 parameters.
    const user = await createUser();
    await getTestDb()
      .update(users)
      .set({ passwordHash: await hashPassword(user.password) })
      .where(eq(users.id, user.id));

    async function time(email: string): Promise<number> {
      const started = performance.now();
      const response = await app?.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "wrong-password" } });
      expect(response?.statusCode).toBe(401);
      return performance.now() - started;
    }
    const known: number[] = [];
    const unknown: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      known.push(await time(user.email));
      unknown.push(await time(`nadie${index}@example.test`));
    }
    const median = (values: number[]): number => [...values].sort((a, b) => a - b)[1] ?? 0;
    // Loose bound (CI noise): without the dummy verify, unknown emails would be ~50x faster.
    expect(median(unknown)).toBeGreaterThan(median(known) * 0.4);
  });

  it("returns 400 VALIDATION for a malformed body", async () => {
    app = await createTestApp();
    const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "not-an-email" } });

    expect(response.statusCode).toBe(400);
    expect(code(response)).toBe("VALIDATION");
  });

  it("rehashes a password stored with weaker argon2 parameters", async () => {
    app = await createTestApp();
    const user = await createUser();
    const [before] = await getTestDb().select().from(users).where(eq(users.id, user.id));

    await loginFull(app, user);

    const [after] = await getTestDb().select().from(users).where(eq(users.id, user.id));
    expect(after?.passwordHash).not.toBe(before?.passwordHash);
    expect(after?.passwordHash).toContain("m=19456");
  });

  it("answers 429 RATE_LIMITED after 10 attempts for one IP and email", async () => {
    app = await createTestApp();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "objetivo@example.test", password: "wrong-password" }
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.at(-1)).toBe(429);
  });
});

describe("POST /api/auth/refresh", () => {
  it("rotates the token, extends the idle expiry and returns a new access token", async () => {
    const clock = new TestClock();
    app = await createTestApp({ clock });
    const user = await createUser();
    const login = await loginFull(app, user);
    clock.advance(DAY_MS);

    const response = await refresh(app, login.refreshToken);

    expect(response.statusCode).toBe(200);
    const body = response.json<{ accessToken: string; user: { id: string } }>();
    expect(body.user.id).toBe(user.id);
    const next = refreshCookie(response);
    expect(next?.value).toBeDefined();
    expect(next?.value).not.toBe(login.refreshToken);
    const [old] = await getTestDb()
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashToken(login.refreshToken)));
    expect(old?.usedAt).not.toBeNull();
    expect(old?.replacedByTokenId).not.toBeNull();
    const [session] = await getTestDb().select().from(sessions).where(eq(sessions.userId, user.id));
    expect(session?.idleExpiresAt.getTime()).toBe(clock.now().getTime() + 30 * DAY_MS);

    const me = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${body.accessToken}` } });
    expect(me.statusCode).toBe(200);
  });

  it("answers 401 and clears the cookie without a cookie or with an unknown one", async () => {
    app = await createTestApp();

    const missing = await app.inject({ method: "POST", url: "/api/auth/refresh", headers: { ...CSRF_HEADERS } });
    const unknown = await refresh(app, "u".repeat(43));

    for (const response of [missing, unknown]) {
      expect(response.statusCode).toBe(401);
      expect(code(response)).toBe("UNAUTHENTICATED");
      const cleared = refreshCookie(response);
      expect(cleared?.value).toBe("");
      expect(cleared?.path).toBe("/api/auth");
    }
  });

  it("answers 403 CSRF_FAILED without the CSRF header or with a foreign Origin", async () => {
    app = await createTestApp();
    const user = await createUser();
    const login = await loginFull(app, user);

    const noHeader = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      headers: { origin: CSRF_HEADERS.origin },
      cookies: { cuencada_rt: login.refreshToken }
    });
    const foreign = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      headers: { ...CSRF_HEADERS, origin: "https://evil.example" },
      cookies: { cuencada_rt: login.refreshToken }
    });

    expect(noHeader.statusCode).toBe(403);
    expect(code(foreign)).toBe("CSRF_FAILED");
  });

  it("answers 409 REFRESH_RACE for a token reused inside the grace window without revoking", async () => {
    const clock = new TestClock();
    app = await createTestApp({ clock });
    const user = await createUser();
    const login = await loginFull(app, user);
    expect((await refresh(app, login.refreshToken)).statusCode).toBe(200);
    clock.advance(REFRESH_REUSE_GRACE_MS - 1000);

    const race = await refresh(app, login.refreshToken);

    expect(race.statusCode).toBe(409);
    expect(code(race)).toBe("REFRESH_RACE");
    const [session] = await getTestDb().select().from(sessions).where(eq(sessions.userId, user.id));
    expect(session?.revokedAt).toBeNull();
  });

  it("detects reuse after the grace window: revokes the session, audits and answers 401", async () => {
    const clock = new TestClock();
    app = await createTestApp({ clock });
    const user = await createUser();
    const login = await loginFull(app, user);
    const rotated = await refresh(app, login.refreshToken);
    const newToken = refreshCookie(rotated)?.value ?? "";
    clock.advance(REFRESH_REUSE_GRACE_MS + 1000);

    const reuse = await refresh(app, login.refreshToken);

    expect(reuse.statusCode).toBe(401);
    expect(code(reuse)).toBe("UNAUTHENTICATED");
    const [session] = await getTestDb().select().from(sessions).where(eq(sessions.userId, user.id));
    expect(session?.revokedReason).toBe("refresh_reuse");
    expect(await auditCount("auth.refresh_reuse_detected", session?.id)).toBe(1);
    // The legitimate holder of the newest token is logged out too.
    expect((await refresh(app, newToken)).statusCode).toBe(401);
    const me = await app.inject({ method: "GET", url: "/api/me", ...login.auth });
    expect(me.statusCode).toBe(401);
  });

  it("lets exactly one of two concurrent refreshes rotate; the other gets 409", async () => {
    app = await createTestApp();
    const user = await createUser();
    const login = await loginFull(app, user);

    const results = await Promise.all([refresh(app, login.refreshToken), refresh(app, login.refreshToken)]);

    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const tokens = await getTestDb().select().from(refreshTokens);
    expect(tokens).toHaveLength(2);
  });

  it("answers 401 once the idle expiry passes", async () => {
    const clock = new TestClock();
    app = await createTestApp({ clock });
    const user = await createUser();
    const login = await loginFull(app, user);
    clock.advance(30 * DAY_MS + 1000);

    const response = await refresh(app, login.refreshToken);

    expect(response.statusCode).toBe(401);
  });

  it("caps the idle expiry at the absolute expiry and answers 401 after it", async () => {
    const clock = new TestClock();
    app = await createTestApp({ clock });
    const user = await createUser();
    let token = (await loginFull(app, user)).refreshToken;
    const [initial] = await getTestDb().select().from(sessions).where(eq(sessions.userId, user.id));
    for (let step = 0; step < 4; step += 1) {
      clock.advance(25 * DAY_MS);
      const response = await refresh(app, token);
      if (step < 3) {
        expect(response.statusCode).toBe(200);
        token = refreshCookie(response)?.value ?? "";
        const [session] = await getTestDb().select().from(sessions).where(eq(sessions.userId, user.id));
        expect(session?.idleExpiresAt.getTime()).toBeLessThanOrEqual(initial?.absoluteExpiresAt.getTime() ?? 0);
      } else {
        // 100 days > 90-day absolute lifetime.
        expect(response.statusCode).toBe(401);
      }
    }
  });

  it("answers 401 for a disabled user or a revoked session", async () => {
    app = await createTestApp();
    const user = await createUser();
    const first = await loginFull(app, user);
    const second = await loginFull(app, user);
    const [firstToken] = await getTestDb()
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashToken(first.refreshToken)));
    await getTestDb()
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: "admin_revoked" })
      .where(eq(sessions.id, firstToken?.sessionId ?? ""));

    expect((await refresh(app, first.refreshToken)).statusCode).toBe(401);
    await getTestDb().update(users).set({ status: "disabled" }).where(eq(users.id, user.id));
    expect((await refresh(app, second.refreshToken)).statusCode).toBe(401);
  });
});

describe("POST /api/auth/logout", () => {
  it("revokes the session, clears the cookie, audits and answers 204", async () => {
    app = await createTestApp();
    const user = await createUser();
    const login = await loginFull(app, user);

    const response = await app.inject({ method: "POST", url: "/api/auth/logout", ...withRefreshCookie(login.refreshToken) });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(refreshCookie(response)?.value).toBe("");
    const [session] = await getTestDb().select().from(sessions).where(eq(sessions.userId, user.id));
    expect(session?.revokedReason).toBe("logout");
    expect(await auditCount("auth.logged_out", session?.id)).toBe(1);
    expect((await app.inject({ method: "GET", url: "/api/me", ...login.auth })).statusCode).toBe(401);
  });

  it("answers 401 when the session is already dead or there is no cookie", async () => {
    app = await createTestApp();
    const user = await createUser();
    const login = await loginFull(app, user);
    await app.inject({ method: "POST", url: "/api/auth/logout", ...withRefreshCookie(login.refreshToken) });

    const again = await app.inject({ method: "POST", url: "/api/auth/logout", ...withRefreshCookie(login.refreshToken) });
    const none = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { ...CSRF_HEADERS } });

    expect(again.statusCode).toBe(401);
    expect(none.statusCode).toBe(401);
    expect(refreshCookie(again)?.value).toBe("");
  });

  it("answers 403 CSRF_FAILED without the CSRF header", async () => {
    app = await createTestApp();
    const response = await app.inject({ method: "POST", url: "/api/auth/logout", cookies: { cuencada_rt: "x".repeat(43) } });

    expect(response.statusCode).toBe(403);
  });
});

describe("POST /api/auth/logout-all", () => {
  it("revokes every session including the current one and clears the cookie", async () => {
    app = await createTestApp();
    const user = await createUser();
    const other = await createUser();
    const first = await loginFull(app, user);
    const second = await loginFull(app, user);
    const bystander = await loginFull(app, other);

    const response = await app.inject({ method: "POST", url: "/api/auth/logout-all", ...second.auth });

    expect(response.statusCode).toBe(204);
    expect(refreshCookie(response)?.value).toBe("");
    const rows = await getTestDb().select().from(sessions).where(eq(sessions.userId, user.id));
    expect(rows.every((row) => row.revokedReason === "user_revoked")).toBe(true);
    expect((await app.inject({ method: "GET", url: "/api/me", ...first.auth })).statusCode).toBe(401);
    expect((await refresh(app, second.refreshToken)).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/me", ...bystander.auth })).statusCode).toBe(200);
    expect(await auditCount("auth.sessions_revoked", user.id)).toBe(1);
  });

  it("answers 401 without a token", async () => {
    app = await createTestApp();
    expect((await app.inject({ method: "POST", url: "/api/auth/logout-all" })).statusCode).toBe(401);
  });
});

describe("GET /api/me", () => {
  it("returns the CurrentUser from the database, including the linked person", async () => {
    app = await createTestApp();
    const user = await createUser({ emailVerified: true });
    const [person] = await getTestDb().insert(people).values({ fullName: "Prima Ana", userId: user.id }).returning();
    const login = await loginFull(app, user);

    const response = await app.inject({ method: "GET", url: "/api/me", ...login.auth });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: user.id, emailVerified: true, personId: person?.id, avatarUrl: null });
  });

  it("presigns the avatar URL when the profile has one", async () => {
    app = await createTestApp();
    const user = await createUser({ profile: { avatarKey: "avatars/u/1.webp" } });
    const login = await loginFull(app, user);

    const response = await app.inject({ method: "GET", url: "/api/me", ...login.auth });

    expect(response.json<{ avatarUrl: string }>().avatarUrl).toContain("avatars/u/1.webp");
  });

  it("is allowed while a password change is pending, and answers 401 without a token", async () => {
    app = await createTestApp();
    const user = await createUser({ mustChangePassword: true });
    const login = await loginFull(app, user);

    expect((await app.inject({ method: "GET", url: "/api/me", ...login.auth })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/me" })).statusCode).toBe(401);
  });
});

describe("session management", () => {
  it("lists only the caller's live sessions, flags the current one and never exposes token hashes", async () => {
    app = await createTestApp();
    const user = await createUser();
    const other = await createUser();
    await loginFull(app, user, { "user-agent": "Teléfono" });
    const current = await loginFull(app, user, { "user-agent": "Laptop" });
    await loginFull(app, other);
    await createSession(user.id, { revoked: true });

    const response = await app.inject({ method: "GET", url: "/api/auth/sessions", ...current.auth });

    expect(response.statusCode).toBe(200);
    const items = response.json<Array<{ current: boolean; userAgent: string }>>();
    expect(items).toHaveLength(2);
    expect(items.filter((item) => item.current).map((item) => item.userAgent)).toEqual(["Laptop"]);
    expect(response.body).not.toMatch(/hash|token/i);
  });

  it("revokes one of the caller's sessions and answers 404 for another user's session", async () => {
    app = await createTestApp();
    const user = await createUser();
    const other = await createUser();
    const phone = await loginFull(app, user);
    const laptop = await loginFull(app, user);
    const otherSession = await createSession(other.id);
    const [phoneSession] = await getTestDb()
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashToken(phone.refreshToken)));

    const foreign = await app.inject({ method: "DELETE", url: `/api/auth/sessions/${otherSession.id}`, ...laptop.auth });
    const own = await app.inject({ method: "DELETE", url: `/api/auth/sessions/${phoneSession?.sessionId}`, ...laptop.auth });
    const bad = await app.inject({ method: "DELETE", url: "/api/auth/sessions/not-a-uuid", ...laptop.auth });

    expect(foreign.statusCode).toBe(404);
    expect(code(foreign)).toBe("NOT_FOUND");
    expect(own.statusCode).toBe(204);
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/me", ...phone.auth })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/me", ...laptop.auth })).statusCode).toBe(200);
    const [stillLive] = await getTestDb().select().from(sessions).where(eq(sessions.id, otherSession.id));
    expect(stillLive?.revokedAt).toBeNull();
  });

  it("revoke-others keeps only the current session", async () => {
    app = await createTestApp();
    const user = await createUser();
    const phone = await loginFull(app, user);
    const laptop = await loginFull(app, user);

    const response = await app.inject({ method: "POST", url: "/api/auth/sessions/revoke-others", ...laptop.auth });

    expect(response.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/me", ...phone.auth })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/me", ...laptop.auth })).statusCode).toBe(200);
    const rows = await getTestDb().select().from(sessions).where(eq(sessions.revokedReason, "revoke_others"));
    expect(rows).toHaveLength(1);
  });

  it("answers 401 without a token and 403 while a password change is pending", async () => {
    app = await createTestApp();
    const user = await createUser({ mustChangePassword: true });
    const session = await createSession(user.id);
    const auth = await bearerFor(user, session);

    expect((await app.inject({ method: "GET", url: "/api/auth/sessions" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/auth/sessions", ...auth })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/auth/sessions/revoke-others", ...auth })).statusCode).toBe(403);
  });
});
