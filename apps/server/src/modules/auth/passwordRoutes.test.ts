import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { linkToken, loginFull, refreshCookie, TestClock, withRefreshCookie } from "../../../test/helpers/auth.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { createUser } from "../../../test/helpers/factories.js";
import { FakeMailer } from "../../../test/helpers/fakes.js";
import type { App } from "../../app.js";
import { mailQueue } from "./mailQueue.js";
import { auditLogs, magicLinks, sessions, users } from "../../db/schema/index.js";
import { verifyPassword } from "../../lib/passwords.js";

const NEW_PASSWORD = "una-contraseña-nueva-y-larga";

let app: App | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function code(response: { json: <T>() => T }): string {
  return response.json<{ error: { code: string } }>().error.code;
}

describe("POST /api/auth/change-password", () => {
  it("changes the password, revokes every old session, rotates this one and emails a notice", async () => {
    const mailer = new FakeMailer();
    app = await createTestApp({ mailer });
    const user = await createUser({ mustChangePassword: true });
    const phone = await loginFull(app, user);
    const laptop = await loginFull(app, user);

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      payload: { currentPassword: user.password, newPassword: NEW_PASSWORD },
      ...laptop.auth
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ accessToken: string; user: { mustChangePassword: boolean } }>();
    expect(body.user.mustChangePassword).toBe(false);
    const cookie = refreshCookie(response);
    expect(cookie?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const [row] = await getTestDb().select().from(users).where(eq(users.id, user.id));
    expect(row?.mustChangePassword).toBe(false);
    expect(row?.passwordChangedAt).not.toBeNull();
    expect(row?.passwordHash && (await verifyPassword(row.passwordHash, NEW_PASSWORD))).toBe(true);

    const rows = await getTestDb().select().from(sessions).where(eq(sessions.userId, user.id));
    expect(rows).toHaveLength(3);
    expect(rows.filter((session) => session.revokedReason === "password_changed")).toHaveLength(2);
    // Both old access tokens (including this device's) and refresh tokens are dead.
    for (const old of [phone, laptop]) {
      expect((await app.inject({ method: "GET", url: "/api/me", ...old.auth })).statusCode).toBe(401);
      const refreshed = await app.inject({ method: "POST", url: "/api/auth/refresh", ...withRefreshCookie(old.refreshToken) });
      expect(refreshed.statusCode).toBe(401);
    }
    const fresh = { headers: { authorization: `Bearer ${body.accessToken}` } };
    expect((await app.inject({ method: "GET", url: "/api/auth/sessions", ...fresh })).statusCode).toBe(200);
    const refreshed = await app.inject({ method: "POST", url: "/api/auth/refresh", ...withRefreshCookie(cookie?.value ?? "") });
    expect(refreshed.statusCode).toBe(200);

    const audits = await getTestDb()
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, user.id), eq(auditLogs.action, "auth.password_changed")));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]?.metadata)).not.toContain(NEW_PASSWORD);

    await mailQueue(app).onIdle();
    const notice = mailer.lastTo(user.email);
    expect(notice?.tags).toEqual({ category: "password-changed" });
    expect(notice?.text).toContain("admin@cuencada.com");
  });

  it("returns 400 VALIDATION on currentPassword when it is wrong, and on newPassword when unchanged", async () => {
    app = await createTestApp();
    const user = await createUser();
    const login = await loginFull(app, user);

    const wrong = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      payload: { currentPassword: "not-my-password", newPassword: NEW_PASSWORD },
      ...login.auth
    });
    const same = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      payload: { currentPassword: user.password, newPassword: user.password },
      ...login.auth
    });

    expect(wrong.statusCode).toBe(400);
    expect(wrong.json<{ error: { details: Array<{ path: string }> } }>().error.details[0]?.path).toBe("currentPassword");
    expect(same.statusCode).toBe(400);
    expect(same.json<{ error: { details: Array<{ path: string }> } }>().error.details[0]?.path).toBe("newPassword");
    const rows = await getTestDb().select().from(sessions).where(eq(sessions.userId, user.id));
    expect(rows.every((session) => session.revokedAt === null)).toBe(true);
  });

  it("answers 401 without a token", async () => {
    app = await createTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      payload: { currentPassword: "x", newPassword: NEW_PASSWORD }
    });
    expect(response.statusCode).toBe(401);
  });

  it("rate-limits one user to 10 attempts per window (429)", async () => {
    app = await createTestApp();
    const user = await createUser();
    const login = await loginFull(app, user);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/change-password",
        payload: { currentPassword: "not-my-password", newPassword: NEW_PASSWORD },
        ...login.auth
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 10).every((status) => status === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe("password reset", () => {
  async function requestReset(instance: App, email: string): Promise<{ statusCode: number; body: string }> {
    const response = await instance.inject({ method: "POST", url: "/api/auth/password-reset/request", payload: { email } });
    return { statusCode: response.statusCode, body: response.body };
  }

  it("answers the same 202 for known, unknown and disabled emails; only active users get a link", async () => {
    const mailer = new FakeMailer();
    app = await createTestApp({ mailer });
    const user = await createUser();
    const disabled = await createUser({ status: "disabled" });

    const results = [
      await requestReset(app, user.email.toUpperCase()),
      await requestReset(app, "nadie@example.test"),
      await requestReset(app, disabled.email)
    ];
    await mailQueue(app).onIdle();

    expect(results).toEqual(Array(3).fill({ statusCode: 202, body: JSON.stringify({ ok: true }) }));
    expect(mailer.outbox).toHaveLength(1);
    expect(mailer.outbox[0]?.to).toBe(user.email);
    expect(mailer.outbox[0]?.text).toContain("http://localhost:5173/restablecer#t=");
    expect(mailer.outbox[0]?.idempotencyKey).toMatch(/^password-reset:[0-9a-f-]{36}$/);
    const [link] = await getTestDb().select().from(magicLinks).where(eq(magicLinks.userId, user.id));
    expect(link?.purpose).toBe("password_reset");
    expect(link?.requestIp).toBe("127.0.0.1");
    expect(link?.tokenHash).not.toBe(linkToken(mailer.outbox[0]));
  });

  it("confirm sets the password, revokes all sessions, emails a notice, answers 204 without logging in", async () => {
    const mailer = new FakeMailer();
    app = await createTestApp({ mailer });
    const user = await createUser({ mustChangePassword: true });
    const login = await loginFull(app, user);
    await requestReset(app, user.email);
    await mailQueue(app).onIdle();
    const token = linkToken(mailer.lastTo(user.email));

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/password-reset/confirm",
      payload: { token, newPassword: NEW_PASSWORD }
    });

    expect(response.statusCode).toBe(204);
    expect(refreshCookie(response)).toBeUndefined();
    const [row] = await getTestDb().select().from(users).where(eq(users.id, user.id));
    expect(row?.mustChangePassword).toBe(false);
    expect(row?.emailVerifiedAt).not.toBeNull();
    expect(row?.passwordHash && (await verifyPassword(row.passwordHash, NEW_PASSWORD))).toBe(true);
    const rows = await getTestDb().select().from(sessions).where(eq(sessions.userId, user.id));
    expect(rows.map((session) => session.revokedReason)).toEqual(["password_reset"]);
    expect((await app.inject({ method: "GET", url: "/api/me", ...login.auth })).statusCode).toBe(401);
    await mailQueue(app).onIdle();
    expect(mailer.lastTo(user.email)?.tags).toEqual({ category: "password-changed" });
    const audits = await getTestDb().select().from(auditLogs).where(eq(auditLogs.action, "auth.password_reset"));
    expect(audits).toHaveLength(1);

    const reused = await app.inject({
      method: "POST",
      url: "/api/auth/password-reset/confirm",
      payload: { token, newPassword: "otra-contraseña-larga" }
    });
    expect(reused.statusCode).toBe(400);
    expect(code(reused)).toBe("TOKEN_INVALID");
  });

  it("rejects an expired token, a login token and a malformed token", async () => {
    const mailer = new FakeMailer();
    const clock = new TestClock();
    app = await createTestApp({ mailer, clock });
    const user = await createUser();
    await requestReset(app, user.email);
    await app.inject({ method: "POST", url: "/api/auth/magic-link/request", payload: { email: user.email } });
    await mailQueue(app).onIdle();
    const [resetMail, loginMail] = mailer.outbox;
    clock.advance(31 * 60_000);

    const expired = await app.inject({
      method: "POST",
      url: "/api/auth/password-reset/confirm",
      payload: { token: linkToken(resetMail), newPassword: NEW_PASSWORD }
    });
    clock.advance(-31 * 60_000);
    const wrongPurpose = await app.inject({
      method: "POST",
      url: "/api/auth/password-reset/confirm",
      payload: { token: linkToken(loginMail), newPassword: NEW_PASSWORD }
    });
    const malformed = await app.inject({
      method: "POST",
      url: "/api/auth/password-reset/confirm",
      payload: { token: "short", newPassword: NEW_PASSWORD }
    });

    expect(code(expired)).toBe("TOKEN_INVALID");
    expect(code(wrongPurpose)).toBe("TOKEN_INVALID");
    expect(malformed.statusCode).toBe(400);
    expect(code(malformed)).toBe("VALIDATION");
  });

  it("rate-limits reset requests for one IP and email (429)", async () => {
    app = await createTestApp();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) statuses.push((await requestReset(app, "x@example.test")).statusCode);
    expect(statuses.slice(0, 10).every((status) => status === 202)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
