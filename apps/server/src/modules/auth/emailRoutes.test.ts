import { eq } from "drizzle-orm";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { linkToken, loginFull, refreshCookie, TestClock } from "../../../test/helpers/auth.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { createUser } from "../../../test/helpers/factories.js";
import { FakeMailer } from "../../../test/helpers/fakes.js";
import type { App } from "../../app.js";
import { mailQueue } from "./mailQueue.js";
import { auditLogs, magicLinks, sessions, users } from "../../db/schema/index.js";

let app: App | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function code(response: { json: <T>() => T }): string {
  return response.json<{ error: { code: string } }>().error.code;
}

async function requestLink(instance: App, email: string): Promise<{ statusCode: number; body: string }> {
  const response = await instance.inject({ method: "POST", url: "/api/auth/magic-link/request", payload: { email } });
  return { statusCode: response.statusCode, body: response.body };
}

function consume(instance: App, token: string, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
  return instance.inject({ method: "POST", url: "/api/auth/magic-link/consume", headers, payload: { token } });
}

describe("POST /api/auth/magic-link/request", () => {
  it("answers an identical 202 for known, unknown and disabled emails; only active users get a link", async () => {
    const mailer = new FakeMailer();
    app = await createTestApp({ mailer });
    const user = await createUser();
    const disabled = await createUser({ status: "disabled" });

    const known = await requestLink(app, user.email);
    const unknown = await requestLink(app, "nadie@example.test");
    const inactive = await requestLink(app, disabled.email);
    await mailQueue(app).onIdle();

    for (const result of [known, unknown, inactive]) {
      expect(result.statusCode).toBe(202);
      expect(result.body).toBe(JSON.stringify({ ok: true }));
    }
    expect(mailer.outbox.map((mail) => mail.to)).toEqual([user.email]);
    const mail = mailer.outbox[0];
    expect(mail?.text).toContain("http://localhost:5173/entrar/enlace#t=");
    const [row] = await getTestDb().select().from(magicLinks).where(eq(magicLinks.userId, user.id));
    expect(row?.purpose).toBe("login");
    expect(mail?.idempotencyKey).toBe(`magic-link:${row?.id}`);
    expect(row?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect(row?.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
    const audits = await getTestDb().select().from(auditLogs).where(eq(auditLogs.action, "auth.magic_link_requested"));
    expect(audits.map((audit) => audit.entityId)).toEqual([user.id]);
  });

  it("sends the email on its own queue, even while a media job blocks app.jobs", async () => {
    const mailer = new FakeMailer();
    app = await createTestApp({ mailer });
    const user = await createUser();
    let release: () => void = () => {};
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    let mediaDone = false;
    app.jobs.enqueue("media.process", async () => {
      await blocker;
      mediaDone = true;
    });

    await requestLink(app, user.email);
    await mailQueue(app).onIdle();

    expect(mailer.lastTo(user.email)).toBeDefined();
    expect(mediaDone).toBe(false);
    release();
    await app.jobs.onIdle();
  });

  it("answers before the email is sent, so a slow provider cannot reveal known emails by timing", async () => {
    const mailer = new FakeMailer();
    app = await createTestApp({ mailer });
    const user = await createUser();
    // Hold the mail queue, as a slow provider would.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mailQueue(app).enqueue("test.hold", () => held);

    const known = await requestLink(app, user.email);
    const unknown = await requestLink(app, "nadie@example.test");

    expect(known.statusCode).toBe(202);
    expect(known.body).toBe(unknown.body);
    expect(mailer.outbox).toHaveLength(0);
    release();
    await mailQueue(app).onIdle();
    expect(mailer.outbox.map((mail) => mail.to)).toEqual([user.email]);
  });

  it("answers 400 VALIDATION for a malformed email and 429 after 10 requests", async () => {
    app = await createTestApp();
    const bad = await app.inject({ method: "POST", url: "/api/auth/magic-link/request", payload: { email: "nope" } });
    expect(bad.statusCode).toBe(400);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) statuses.push((await requestLink(app, "x@example.test")).statusCode);
    expect(statuses[10]).toBe(429);
  });
});

describe("POST /api/auth/magic-link/consume", () => {
  it("logs in once: session, cookie, verified email; a second use is TOKEN_INVALID", async () => {
    const mailer = new FakeMailer();
    app = await createTestApp({ mailer });
    const user = await createUser();
    await requestLink(app, user.email);
    await mailQueue(app).onIdle();
    const token = linkToken(mailer.lastTo(user.email));

    const first = await consume(app, token);
    const second = await consume(app, token);

    expect(first.statusCode).toBe(200);
    expect(first.json<{ user: { id: string; emailVerified: boolean } }>().user).toMatchObject({
      id: user.id,
      emailVerified: true
    });
    expect(refreshCookie(first)?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.statusCode).toBe(400);
    expect(code(second)).toBe("TOKEN_INVALID");
    const rows = await getTestDb().select().from(sessions).where(eq(sessions.userId, user.id));
    expect(rows).toHaveLength(1);
    const audits = await getTestDb().select().from(auditLogs).where(eq(auditLogs.action, "auth.logged_in"));
    expect(audits[0]?.metadata).toEqual({ method: "magic_link" });
  });

  it("rejects an expired link and a link of a user disabled after it was sent", async () => {
    const mailer = new FakeMailer();
    const clock = new TestClock();
    app = await createTestApp({ mailer, clock });
    const user = await createUser();
    const later = await createUser();
    await requestLink(app, user.email);
    await requestLink(app, later.email);
    await mailQueue(app).onIdle();
    clock.advance(15 * 60_000 + 1000);

    const expired = await consume(app, linkToken(mailer.lastTo(user.email)));
    clock.advance(-(15 * 60_000 + 1000));
    await getTestDb().update(users).set({ status: "disabled" }).where(eq(users.id, later.id));
    const disabled = await consume(app, linkToken(mailer.lastTo(later.email)));

    expect(code(expired)).toBe("TOKEN_INVALID");
    expect(code(disabled)).toBe("TOKEN_INVALID");
  });

  it("issues a fresh session for the link's user and leaves another user's live session untouched", async () => {
    const mailer = new FakeMailer();
    app = await createTestApp({ mailer });
    const signedIn = await createUser({ displayName: "Usuario Previo" });
    const linkOwner = await createUser({ displayName: "Dueño del Enlace" });
    const previous = await loginFull(app, signedIn);
    const [before] = await getTestDb().select().from(sessions).where(eq(sessions.userId, signedIn.id));
    await requestLink(app, linkOwner.email);
    await mailQueue(app).onIdle();

    const response = await consume(app, linkToken(mailer.lastTo(linkOwner.email)), previous.auth.headers);

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(signedIn.id);
    expect(response.body).not.toContain("Usuario Previo");
    const [after] = await getTestDb().select().from(sessions).where(eq(sessions.userId, signedIn.id));
    expect(after).toEqual(before);
    const ownerSessions = await getTestDb().select().from(sessions).where(eq(sessions.userId, linkOwner.id));
    expect(ownerSessions).toHaveLength(1);
    expect(ownerSessions[0]?.id).not.toBe(before?.id);
  });

  it("answers 400 VALIDATION for a malformed token", async () => {
    app = await createTestApp();
    const response = await consume(app, "not a token");
    expect(code(response)).toBe("VALIDATION");
  });
});

describe("email verification", () => {
  it("sends a verify link to an unverified user and the link verifies once", async () => {
    const mailer = new FakeMailer();
    app = await createTestApp({ mailer });
    const user = await createUser();
    const login = await loginFull(app, user);

    const requested = await app.inject({ method: "POST", url: "/api/auth/email/verify-request", ...login.auth });
    await mailQueue(app).onIdle();
    const mail = mailer.lastTo(user.email);
    const token = linkToken(mail);
    const verified = await app.inject({ method: "POST", url: "/api/auth/email/verify", payload: { token } });
    const again = await app.inject({ method: "POST", url: "/api/auth/email/verify", payload: { token } });

    expect(requested.statusCode).toBe(202);
    expect(mail?.text).toContain("http://localhost:5173/verificar#t=");
    expect(verified.statusCode).toBe(204);
    expect(code(again)).toBe("TOKEN_INVALID");
    const [row] = await getTestDb().select().from(users).where(eq(users.id, user.id));
    expect(row?.emailVerifiedAt).not.toBeNull();
    const me = await app.inject({ method: "GET", url: "/api/me", ...login.auth });
    expect(me.json<{ emailVerified: boolean }>().emailVerified).toBe(true);
    const audits = await getTestDb().select().from(auditLogs).where(eq(auditLogs.action, "auth.email_verified"));
    expect(audits).toHaveLength(1);
  });

  it("verifies the token's own user and ignores the caller's session", async () => {
    const mailer = new FakeMailer();
    app = await createTestApp({ mailer });
    const owner = await createUser();
    const caller = await createUser();
    const ownerLogin = await loginFull(app, owner);
    const callerLogin = await loginFull(app, caller);
    await app.inject({ method: "POST", url: "/api/auth/email/verify-request", ...ownerLogin.auth });
    await mailQueue(app).onIdle();

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/email/verify",
      payload: { token: linkToken(mailer.lastTo(owner.email)) },
      ...callerLogin.auth
    });

    expect(response.statusCode).toBe(204);
    const [ownerRow] = await getTestDb().select().from(users).where(eq(users.id, owner.id));
    const [callerRow] = await getTestDb().select().from(users).where(eq(users.id, caller.id));
    expect(ownerRow?.emailVerifiedAt).not.toBeNull();
    expect(callerRow?.emailVerifiedAt).toBeNull();
  });

  it("does not send to an already verified user but still answers 202", async () => {
    const mailer = new FakeMailer();
    app = await createTestApp({ mailer });
    const user = await createUser({ emailVerified: true });
    const login = await loginFull(app, user);

    const response = await app.inject({ method: "POST", url: "/api/auth/email/verify-request", ...login.auth });
    await mailQueue(app).onIdle();

    expect(response.statusCode).toBe(202);
    expect(mailer.outbox).toHaveLength(0);
  });

  it("does not verify when the address changed after the link was sent", async () => {
    const mailer = new FakeMailer();
    app = await createTestApp({ mailer });
    const user = await createUser();
    const login = await loginFull(app, user);
    await app.inject({ method: "POST", url: "/api/auth/email/verify-request", ...login.auth });
    await mailQueue(app).onIdle();
    await getTestDb().update(users).set({ email: "nueva@example.test" }).where(eq(users.id, user.id));

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/email/verify",
      payload: { token: linkToken(mailer.lastTo(user.email)) }
    });

    expect(response.statusCode).toBe(400);
    expect(code(response)).toBe("TOKEN_INVALID");
    const [row] = await getTestDb().select().from(users).where(eq(users.id, user.id));
    expect(row?.emailVerifiedAt).toBeNull();
  });

  it("limits verify requests to 3 per user per window (429) and requires a token (401)", async () => {
    app = await createTestApp();
    const user = await createUser();
    const login = await loginFull(app, user);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      statuses.push((await app.inject({ method: "POST", url: "/api/auth/email/verify-request", ...login.auth })).statusCode);
    }
    const other = await loginFull(app, await createUser());

    expect(statuses).toEqual([202, 202, 202, 429]);
    expect((await app.inject({ method: "POST", url: "/api/auth/email/verify-request", ...other.auth })).statusCode).toBe(202);
    expect((await app.inject({ method: "POST", url: "/api/auth/email/verify-request" })).statusCode).toBe(401);
  });

  it("answers 400 VALIDATION for a malformed verify token", async () => {
    app = await createTestApp();
    const response = await app.inject({ method: "POST", url: "/api/auth/email/verify", payload: { token: "x" } });
    expect(code(response)).toBe("VALIDATION");
  });
});
