/**
 * Two-step verification (WP-7) [SEC]: login challenges, replay, attempts and
 * expiry, rate limits, magic links, trusted devices, recovery codes,
 * enrollment, the admin gate, disable/regenerate, the admin reset, and a
 * PII scan of logs and responses. Real Postgres, `inject()`.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { DAY_MS, loginFull, TestClock } from "../../../test/helpers/auth.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { bearerFor, createSession, createUser, type TestUser } from "../../../test/helpers/factories.js";
import { FakeMailer } from "../../../test/helpers/fakes.js";
import { challengeTokenOf, freshTotpCode, TEST_TOTP_SECRET } from "../../../test/helpers/twoFactor.js";
import type { App } from "../../app.js";
import {
  auditLogs,
  MagicLinkPurpose,
  sessions,
  trustedDevices,
  twoFactorChallenges,
  userRecoveryCodes,
  userTotp
} from "../../db/schema/index.js";
import { totpCodeAt } from "../../lib/totp.js";
import { hashToken, verifyAccessToken, accessTokenSettings } from "../../lib/tokens.js";
import { createEmailToken } from "./emailTokens.js";
import { TWO_FACTOR_USER_LIMIT } from "./twoFactorRoutes.js";

let app: App | undefined;
let ipCounter = 0;

afterEach(async () => {
  await app?.jobs.onIdle();
  await app?.close();
  app = undefined;
});

/** A unique client IP per request (per-IP limits never interfere unless a test wants them to). */
function nextIp(): string {
  ipCounter += 1;
  return `10.70.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

function errorCode(response: LightMyRequestResponse): string | undefined {
  return response.json<{ error?: { code?: string } }>().error?.code;
}

function post(
  instance: App,
  url: string,
  payload: unknown,
  extra: { headers?: Record<string, string>; cookies?: Record<string, string>; remoteAddress?: string } = {}
): Promise<LightMyRequestResponse> {
  return instance.inject({
    method: "POST",
    url,
    payload: payload as Record<string, unknown>, // JSON test bodies
    remoteAddress: extra.remoteAddress ?? nextIp(),
    ...(extra.headers === undefined ? {} : { headers: extra.headers }),
    ...(extra.cookies === undefined ? {} : { cookies: extra.cookies })
  });
}

function login(instance: App, user: TestUser, cookies?: Record<string, string>): Promise<LightMyRequestResponse> {
  return post(instance, "/api/auth/login", { email: user.email, password: user.password }, cookies === undefined ? {} : { cookies });
}

async function challengeFor(instance: App, user: TestUser): Promise<string> {
  const response = await login(instance, user);
  const token = challengeTokenOf(response);
  if (token === null) throw new Error(`expected a challenge, got ${response.statusCode} ${response.body}`);
  return token;
}

async function sessionCount(userId: string): Promise<number> {
  const rows = await getTestDb().select().from(sessions).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  return rows.length;
}

async function auditRows(action: string, entityId: string) {
  return getTestDb()
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, action), eq(auditLogs.entityId, entityId)));
}

function cookieNamed(response: LightMyRequestResponse, name: string) {
  return (response.cookies as Array<{ name: string; value: string; path?: string; maxAge?: number; httpOnly?: boolean; sameSite?: string }>).find(
    (cookie) => cookie.name === name
  );
}

describe("login with two-step verification", () => {
  it("answers a challenge instead of a session, then verify issues the session with amr otp", async () => {
    app = await createTestApp();
    const member = await createUser({ emailVerified: true, twoFactor: true });

    const first = await login(app, member);
    expect(first.statusCode).toBe(200);
    const body = first.json<Record<string, unknown>>();
    expect(body).toMatchObject({ twoFactorRequired: true, trustDeviceAllowed: true });
    expect(body).not.toHaveProperty("accessToken");
    expect(cookieNamed(first, "cuencada_rt")).toBeUndefined();
    expect(await sessionCount(member.id)).toBe(0);
    // The challenge is stored hashed only.
    const challengeToken = String(body.challengeToken);
    const [stored] = await getTestDb().select().from(twoFactorChallenges).where(eq(twoFactorChallenges.userId, member.id));
    expect(stored?.tokenHash).toBe(hashToken(challengeToken));
    expect(JSON.stringify(stored)).not.toContain(challengeToken);

    const verified = await post(app, "/api/auth/2fa/verify", { challengeToken, code: await freshTotpCode(app, member.id) });
    expect(verified.statusCode).toBe(200);
    expect(cookieNamed(verified, "cuencada_rt")).toBeDefined();
    const auth = verified.json<{ accessToken: string; user: { twoFactorEnabled: boolean } }>();
    expect(auth.user.twoFactorEnabled).toBe(true);
    const claims = await verifyAccessToken(accessTokenSettings(app.config), auth.accessToken);
    expect(claims.ok && claims.claims.amr).toEqual(["otp"]);
    const [session] = await getTestDb().select().from(sessions).where(eq(sessions.userId, member.id));
    expect(session?.twoFactorVerifiedAt).not.toBeNull();
    expect(await auditRows("auth.2fa_verified", session?.id ?? "")).toHaveLength(1);
    // The challenge is single-use.
    const again = await post(app, "/api/auth/2fa/verify", { challengeToken, code: await freshTotpCode(app, member.id) });
    expect(again.statusCode).toBe(400);
    expect(errorCode(again)).toBe("TOKEN_INVALID");
  });

  it("gates magic-link logins the same way (the link is spent, the code still follows)", async () => {
    app = await createTestApp();
    const member = await createUser({ emailVerified: true, twoFactor: true });
    const { token } = await getTestDb().transaction((tx) =>
      createEmailToken(tx, { userId: member.id, email: member.email, purpose: MagicLinkPurpose.Login, requestIp: "203.0.113.9", now: new Date() })
    );
    const consumed = await post(app, "/api/auth/magic-link/consume", { token });
    expect(consumed.statusCode).toBe(200);
    const challengeToken = challengeTokenOf(consumed);
    expect(challengeToken).not.toBeNull();
    expect(await sessionCount(member.id)).toBe(0);
    const verified = await post(app, "/api/auth/2fa/verify", { challengeToken, code: await freshTotpCode(app, member.id) });
    expect(verified.statusCode).toBe(200);
    const [audit] = await getTestDb().select().from(auditLogs).where(and(eq(auditLogs.action, "auth.logged_in"), eq(auditLogs.actorUserId, member.id)));
    expect(audit?.metadata).toMatchObject({ method: "magic_link", factor: "totp" });
  });

  it("refuses a replayed code (same step) on a second challenge", async () => {
    app = await createTestApp();
    const member = await createUser({ emailVerified: true, twoFactor: true });
    const code = await freshTotpCode(app, member.id);
    expect((await post(app, "/api/auth/2fa/verify", { challengeToken: await challengeFor(app, member), code })).statusCode).toBe(200);
    const replay = await post(app, "/api/auth/2fa/verify", { challengeToken: await challengeFor(app, member), code });
    expect(replay.statusCode).toBe(400);
    expect(errorCode(replay)).toBe("TWO_FACTOR_INVALID");
  });

  it("counts wrong codes, burns the challenge on the fifth, and answers generically", async () => {
    app = await createTestApp();
    const member = await createUser({ emailVerified: true, twoFactor: true });
    const challengeToken = await challengeFor(app, member);
    const right = await freshTotpCode(app, member.id);
    const wrong = right === "000000" ? "111111" : "000000";
    const messages = new Set<string>();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await post(
        app,
        "/api/auth/2fa/verify",
        attempt % 2 === 0 ? { challengeToken, recoveryCode: "aaaa-bbbb-cccc-dddd" } : { challengeToken, code: wrong }
      );
      expect(response.statusCode).toBe(400);
      expect(errorCode(response)).toBe("TWO_FACTOR_INVALID");
      messages.add(response.json<{ error: { message: string } }>().error.message);
    }
    // No oracle: a wrong TOTP code and a wrong recovery code read the same.
    expect(messages.size).toBe(1);
    const [row] = await getTestDb().select().from(twoFactorChallenges).where(eq(twoFactorChallenges.userId, member.id));
    expect(row).toMatchObject({ attempts: 5 });
    expect(row?.consumedAt).not.toBeNull();
    // Burned: even the right code no longer works, and no session was issued.
    const late = await post(app, "/api/auth/2fa/verify", { challengeToken, code: right });
    expect(errorCode(late)).toBe("TOKEN_INVALID");
    expect(await sessionCount(member.id)).toBe(0);
    const failures = await auditRows("auth.2fa_failed", member.id);
    expect(failures).toHaveLength(5);
    expect(failures.map((failure) => failure.metadata).at(-1)).toMatchObject({ attempts: 5, burned: true });
  });

  it("expires a challenge after 5 minutes", async () => {
    const clock = new TestClock();
    app = await createTestApp({ clock });
    const member = await createUser({ emailVerified: true, twoFactor: true });
    const challengeToken = await challengeFor(app, member);
    clock.advance(5 * 60_000 + 1);
    const response = await post(app, "/api/auth/2fa/verify", { challengeToken, code: await freshTotpCode(app, member.id) });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe("TOKEN_INVALID");
  });

  it("limits code checks per user across challenges and IPs", async () => {
    app = await createTestApp();
    const member = await createUser({ emailVerified: true, twoFactor: true });
    const statuses: number[] = [];
    // Three challenges with four wrong codes each (never burned), every request from a new IP.
    for (let round = 0; round < 3; round += 1) {
      const challengeToken = await challengeFor(app, member);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        statuses.push((await post(app, "/api/auth/2fa/verify", { challengeToken, code: "000000" })).statusCode);
      }
    }
    expect(statuses.slice(0, TWO_FACTOR_USER_LIMIT.max).every((status) => status === 400)).toBe(true);
    expect(statuses.slice(TWO_FACTOR_USER_LIMIT.max)).toEqual([429, 429]);
  });

  it("limits verifications per IP", async () => {
    app = await createTestApp();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 21; attempt += 1) {
      const response = await post(app, "/api/auth/2fa/verify", { challengeToken: "x".repeat(43), code: "123456" }, { remoteAddress: "10.99.0.1" });
      statuses.push(response.statusCode);
    }
    expect(statuses.at(-1)).toBe(429);
  });

  it("issues no session for an unknown challenge and leaks nothing about users", async () => {
    app = await createTestApp();
    const response = await post(app, "/api/auth/2fa/verify", { challengeToken: "y".repeat(43), code: "123456" });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe("TOKEN_INVALID");
  });
});

describe("password changes burn open challenges (Security L2)", () => {
  it("rejects a challenge obtained before a change-password", async () => {
    app = await createTestApp();
    const member = await createUser({ emailVerified: true, twoFactor: true });
    const challengeToken = await challengeFor(app, member);
    const session = await createSession(member.id);
    const changed = await post(
      app,
      "/api/auth/change-password",
      { currentPassword: member.password, newPassword: "una-frase-nueva-larga-2026" },
      { headers: (await bearerFor(member, session)).headers }
    );
    expect(changed.statusCode).toBe(200);
    const late = await post(app, "/api/auth/2fa/verify", { challengeToken, code: await freshTotpCode(app, member.id) });
    expect(errorCode(late)).toBe("TOKEN_INVALID");
  });

  it("rejects a challenge obtained before a password reset", async () => {
    app = await createTestApp();
    const member = await createUser({ emailVerified: true, twoFactor: true });
    const challengeToken = await challengeFor(app, member);
    const { token } = await getTestDb().transaction((tx) =>
      createEmailToken(tx, { userId: member.id, email: member.email, purpose: MagicLinkPurpose.PasswordReset, requestIp: "203.0.113.9", now: new Date() })
    );
    const reset = await post(app, "/api/auth/password-reset/confirm", { token, newPassword: "una-frase-nueva-larga-2026" });
    expect(reset.statusCode).toBe(204);
    const late = await post(app, "/api/auth/2fa/verify", { challengeToken, code: await freshTotpCode(app, member.id) });
    expect(errorCode(late)).toBe("TOKEN_INVALID");
  });

  it("rejects a challenge obtained before an admin's forced password reset", async () => {
    app = await createTestApp();
    const admin = await createUser({ role: "admin", emailVerified: true });
    const member = await createUser({ emailVerified: true, twoFactor: true });
    const challengeToken = await challengeFor(app, member);
    const forced = await app.inject({
      method: "POST",
      url: `/api/admin/users/${member.id}/force-password-reset`,
      ...(await bearerFor(admin, await createSession(admin.id)))
    });
    expect(forced.statusCode).toBe(200);
    const late = await post(app, "/api/auth/2fa/verify", { challengeToken, code: await freshTotpCode(app, member.id) });
    expect(errorCode(late)).toBe("TOKEN_INVALID");
    expect(await sessionCount(member.id)).toBe(0);
  });
});

describe("encryption key", () => {
  it("fails closed when the stored secret does not decrypt with the configured key", async () => {
    const lines: string[] = [];
    // A different (valid) key than the one the factory encrypted with.
    app = await createTestApp({
      config: { TOTP_ENCRYPTION_KEY: "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100" },
      logStream: { write: (line) => lines.push(line) }
    });
    const member = await createUser({ emailVerified: true, twoFactor: true });
    const response = await post(app, "/api/auth/2fa/verify", {
      challengeToken: await challengeFor(app, member),
      code: await freshTotpCode(app, member.id)
    });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe("TWO_FACTOR_INVALID");
    expect(await sessionCount(member.id)).toBe(0);
    expect(lines.join("\n")).toContain("totp.decrypt_failed");
    expect(lines.join("\n")).not.toContain(TEST_TOTP_SECRET);
  });
});

describe("trusted devices", () => {
  it("lets a member skip the code for 30 days on that browser only, bound to the user, stored hashed", async () => {
    const clock = new TestClock();
    app = await createTestApp({ clock });
    const member = await createUser({ emailVerified: true, twoFactor: true });
    const other = await createUser({ emailVerified: true, twoFactor: true });

    const verified = await post(app, "/api/auth/2fa/verify", {
      challengeToken: await challengeFor(app, member),
      code: await freshTotpCode(app, member.id),
      trustDevice: true
    }, { headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1" } });
    expect(verified.statusCode).toBe(200);
    const cookie = cookieNamed(verified, "cuencada_td");
    expect(cookie).toMatchObject({ path: "/api/auth", httpOnly: true, sameSite: "Strict", maxAge: 30 * 24 * 60 * 60 });
    const token = cookie?.value ?? "";
    const [device] = await getTestDb().select().from(trustedDevices).where(eq(trustedDevices.userId, member.id));
    expect(device?.tokenHash).toBe(hashToken(token));
    expect(device?.userAgentLabel).toBe("iPhone · Safari");
    expect(JSON.stringify(device)).not.toContain(token);

    // Next login on this browser: no code.
    const skip = await login(app, member, { cuencada_td: token });
    expect(skip.json()).toHaveProperty("accessToken");
    // Another account on the same browser still needs its code.
    expect(challengeTokenOf(await login(app, other, { cuencada_td: token }))).not.toBeNull();

    // The list marks this browser; another member cannot revoke it (404).
    const auth = { authorization: `Bearer ${skip.json<{ accessToken: string }>().accessToken}` };
    const list = await app.inject({ method: "GET", url: "/api/auth/2fa/trusted-devices", headers: auth, cookies: { cuencada_td: token } });
    expect(list.json()).toEqual([expect.objectContaining({ id: device?.id, label: "iPhone · Safari", current: true })]);
    expect(list.body).not.toContain(token);
    const otherSession = await createSession(other.id);
    const foreign = await app.inject({
      method: "DELETE",
      url: `/api/auth/2fa/trusted-devices/${device?.id}`,
      ...(await bearerFor(other, otherSession))
    });
    expect(foreign.statusCode).toBe(404);

    // Expired after 30 days.
    clock.advance(30 * DAY_MS + 1000);
    expect(challengeTokenOf(await login(app, member, { cuencada_td: token }))).not.toBeNull();
  });

  it("stops trusting a revoked device", async () => {
    app = await createTestApp();
    const member = await createUser({ emailVerified: true, twoFactor: true });
    const verified = await post(app, "/api/auth/2fa/verify", {
      challengeToken: await challengeFor(app, member),
      code: await freshTotpCode(app, member.id),
      trustDevice: true
    });
    const token = cookieNamed(verified, "cuencada_td")?.value ?? "";
    const [device] = await getTestDb().select().from(trustedDevices).where(eq(trustedDevices.userId, member.id));
    const revoke = await app.inject({
      method: "DELETE",
      url: `/api/auth/2fa/trusted-devices/${device?.id}`,
      headers: { authorization: `Bearer ${verified.json<{ accessToken: string }>().accessToken}` }
    });
    expect(revoke.statusCode).toBe(204);
    expect(challengeTokenOf(await login(app, member, { cuencada_td: token }))).not.toBeNull();
  });

  it("never trusts a device for an administrator", async () => {
    app = await createTestApp();
    const admin = await createUser({ role: "admin", emailVerified: true });
    const challenge = await login(app, admin);
    expect(challenge.json()).toMatchObject({ twoFactorRequired: true, trustDeviceAllowed: false });
    const verified = await post(app, "/api/auth/2fa/verify", {
      challengeToken: challengeTokenOf(challenge),
      code: await freshTotpCode(app, admin.id),
      trustDevice: true
    });
    expect(verified.statusCode).toBe(200);
    expect(cookieNamed(verified, "cuencada_td")).toBeUndefined();
    expect(await getTestDb().select().from(trustedDevices).where(eq(trustedDevices.userId, admin.id))).toEqual([]);
    // Even a device row planted for the admin is ignored.
    const planted = "p".repeat(43);
    await getTestDb()
      .insert(trustedDevices)
      .values({ userId: admin.id, tokenHash: hashToken(planted), userAgentLabel: "x", expiresAt: new Date(Date.now() + DAY_MS) });
    expect(challengeTokenOf(await login(app, admin, { cuencada_td: planted }))).not.toBeNull();
  });
});

describe("recovery codes", () => {
  it("log in once each, email a notice, audit, and are stored hashed", async () => {
    const mailer = new FakeMailer();
    app = await createTestApp({ mailer });
    const member = await createUser({ emailVerified: true });
    const { auth } = await loginFull(app, member);
    await post(app, "/api/auth/2fa/setup", { currentPassword: member.password }, { headers: auth.headers });
    const [pending] = await getTestDb().select().from(userTotp).where(eq(userTotp.userId, member.id));
    expect(pending?.enabledAt).toBeNull();
    // Enable with the code of the secret the setup response returned.
    const setup = await post(app, "/api/auth/2fa/setup", { currentPassword: member.password }, { headers: auth.headers });
    const secret = new URL(setup.json<{ otpauthUri: string }>().otpauthUri).searchParams.get("secret") ?? "";
    const enabled = await post(app, "/api/auth/2fa/enable", { code: await totpCodeAt(secret, app.clock.now()) }, { headers: auth.headers });
    expect(enabled.statusCode).toBe(200);
    const codes = enabled.json<{ recoveryCodes: string[] }>().recoveryCodes;
    expect(codes).toHaveLength(10);
    const stored = await getTestDb().select().from(userRecoveryCodes).where(eq(userRecoveryCodes.userId, member.id));
    expect(stored).toHaveLength(10);
    for (const code of codes) expect(JSON.stringify(stored)).not.toContain(code.replaceAll("-", ""));

    const [code] = codes;
    const used = await post(app, "/api/auth/2fa/verify", { challengeToken: await challengeFor(app, member), recoveryCode: code?.toUpperCase() });
    expect(used.statusCode).toBe(200);
    expect(await auditRows("auth.2fa_recovery_code_used", member.id)).toHaveLength(1);
    await app.jobs.onIdle();
    const notice = mailer.lastTo(member.email);
    expect(notice?.subject).toBe("Usaste un código de recuperación");
    expect(notice?.text).toContain("Te quedan 9 códigos sin usar.");
    // Single use.
    const reused = await post(app, "/api/auth/2fa/verify", { challengeToken: await challengeFor(app, member), recoveryCode: code });
    expect(errorCode(reused)).toBe("TWO_FACTOR_INVALID");
  });
});

describe("enrollment", () => {
  it("requires re-authentication, stores the secret encrypted, enables with a code and keeps only this session", async () => {
    const mailer = new FakeMailer();
    const clock = new TestClock();
    app = await createTestApp({ mailer, clock });
    const member = await createUser({ emailVerified: true });
    const other = await loginFull(app, member);
    const { auth } = await loginFull(app, member);

    // Wrong password → 400 (not 401: the client must not refresh).
    const wrong = await post(app, "/api/auth/2fa/setup", { currentPassword: "not-the-password" }, { headers: auth.headers });
    expect(wrong.statusCode).toBe(400);
    // A fresh login counts as re-authentication; a stale one does not.
    expect((await post(app, "/api/auth/2fa/setup", {}, { headers: auth.headers })).statusCode).toBe(200);
    clock.advance(11 * 60_000);
    expect((await post(app, "/api/auth/2fa/setup", {}, { headers: auth.headers })).statusCode).toBe(400);

    const setup = await post(app, "/api/auth/2fa/setup", { currentPassword: member.password }, { headers: auth.headers });
    expect(setup.statusCode).toBe(200);
    expect(setup.headers["cache-control"]).toBe("no-store");
    const body = setup.json<{ otpauthUri: string; qrSvgDataUri: string; manualKey: string; accountName: string }>();
    const secret = new URL(body.otpauthUri).searchParams.get("secret") ?? "";
    expect(body.manualKey.replaceAll(" ", "")).toBe(secret);
    expect(body.qrSvgDataUri.startsWith("data:image/svg+xml;base64,")).toBe(true);
    const [row] = await getTestDb().select().from(userTotp).where(eq(userTotp.userId, member.id));
    expect(row?.secretCiphertext).not.toBe(secret);
    expect(JSON.stringify(row)).not.toContain(secret);

    const bad = await post(app, "/api/auth/2fa/enable", { code: "000000" }, { headers: auth.headers });
    expect(errorCode(bad)).toBe("TWO_FACTOR_INVALID");
    const enabled = await post(app, "/api/auth/2fa/enable", { code: await totpCodeAt(secret, clock.now()) }, { headers: auth.headers });
    expect(enabled.statusCode).toBe(200);
    const result = enabled.json<{ accessToken: string; recoveryCodes: string[]; user: { twoFactorEnabled: boolean } }>();
    expect(result.user.twoFactorEnabled).toBe(true);
    const claims = await verifyAccessToken(accessTokenSettings(app.config), result.accessToken, clock.now());
    expect(claims.ok && claims.claims.amr).toEqual(["otp"]);
    // Other sessions closed; this one kept.
    expect((await app.inject({ method: "GET", url: "/api/me", ...other.auth })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/me", ...auth })).statusCode).toBe(200);
    await app.jobs.onIdle();
    expect(mailer.lastTo(member.email)?.subject).toBe("Activaste la verificación en dos pasos");
    // Already enabled.
    expect((await post(app, "/api/auth/2fa/setup", { currentPassword: member.password }, { headers: auth.headers })).statusCode).toBe(409);

    const status = await app.inject({ method: "GET", url: "/api/auth/2fa/status", ...auth });
    expect(status.json()).toMatchObject({ enabled: true, recoveryCodesRemaining: 10, sessionVerified: true, required: false });
  });

  it("regenerates recovery codes with password and code; the old ones stop working", async () => {
    app = await createTestApp();
    const member = await createUser({ emailVerified: true, twoFactor: true });
    const { auth } = await loginFull(app, member);
    const first = await post(
      app,
      "/api/auth/2fa/recovery-codes",
      { currentPassword: member.password, code: await freshTotpCode(app, member.id) },
      { headers: auth.headers }
    );
    expect(first.statusCode).toBe(200);
    const [oldCode] = first.json<{ recoveryCodes: string[] }>().recoveryCodes;
    const second = await post(
      app,
      "/api/auth/2fa/recovery-codes",
      { currentPassword: member.password, code: await freshTotpCode(app, member.id) },
      { headers: auth.headers }
    );
    expect(second.statusCode).toBe(200);
    const reused = await post(app, "/api/auth/2fa/verify", { challengeToken: await challengeFor(app, member), recoveryCode: oldCode });
    expect(errorCode(reused)).toBe("TWO_FACTOR_INVALID");
    const wrongCode = await post(
      app,
      "/api/auth/2fa/recovery-codes",
      { currentPassword: member.password, code: "000000" },
      { headers: auth.headers }
    );
    expect(errorCode(wrongCode)).toBe("TWO_FACTOR_INVALID");
  });

  it("lets a member disable with password and code (trusted devices revoked, email), never an admin", async () => {
    const mailer = new FakeMailer();
    app = await createTestApp({ mailer });
    const member = await createUser({ emailVerified: true, twoFactor: true });
    const verified = await post(app, "/api/auth/2fa/verify", {
      challengeToken: await challengeFor(app, member),
      code: await freshTotpCode(app, member.id),
      trustDevice: true
    });
    const headers = { authorization: `Bearer ${verified.json<{ accessToken: string }>().accessToken}` };
    const disabled = await post(
      app,
      "/api/auth/2fa/disable",
      { currentPassword: member.password, code: await freshTotpCode(app, member.id) },
      { headers }
    );
    expect(disabled.statusCode).toBe(204);
    expect(await getTestDb().select().from(userTotp).where(eq(userTotp.userId, member.id))).toEqual([]);
    expect(await getTestDb().select().from(userRecoveryCodes).where(eq(userRecoveryCodes.userId, member.id))).toEqual([]);
    const devices = await getTestDb().select().from(trustedDevices).where(eq(trustedDevices.userId, member.id));
    expect(devices.every((device) => device.revokedAt !== null)).toBe(true);
    await app.jobs.onIdle();
    expect(mailer.lastTo(member.email)?.subject).toBe("Desactivaste la verificación en dos pasos");
    expect((await login(app, member)).json()).toHaveProperty("accessToken");

    const admin = await createUser({ role: "admin", emailVerified: true });
    const adminLogin = await loginFull(app, admin);
    const refused = await post(
      app,
      "/api/auth/2fa/disable",
      { currentPassword: admin.password, code: await freshTotpCode(app, admin.id) },
      { headers: adminLogin.auth.headers }
    );
    expect(refused.statusCode).toBe(403);
    expect(await getTestDb().select().from(userTotp).where(eq(userTotp.userId, admin.id))).toHaveLength(1);
  });
});

describe("mandatory two-step verification for administrators", () => {
  it("blocks an unenrolled admin everywhere except the allowlist, then lets them in after enrollment", async () => {
    app = await createTestApp();
    const admin = await createUser({ role: "admin", emailVerified: true, twoFactor: false });
    // No 2FA yet: login issues a session (there is nothing to verify).
    const { auth } = await loginFull(app, admin);
    for (const url of ["/api/admin/users", "/api/auth/sessions", "/api/directory", "/api/auth/2fa/trusted-devices"]) {
      const response = await app.inject({ method: "GET", url, ...auth });
      expect({ url, status: response.statusCode, code: errorCode(response) }).toEqual({
        url,
        status: 403,
        code: "TWO_FACTOR_SETUP_REQUIRED"
      });
    }
    const me = await app.inject({ method: "GET", url: "/api/me", ...auth });
    expect(me.json()).toMatchObject({ role: "admin", twoFactorEnabled: false, twoFactorSetupRequired: true });
    expect((await app.inject({ method: "GET", url: "/api/auth/2fa/status", ...auth })).json()).toMatchObject({
      required: true,
      enabled: false,
      sessionVerified: false,
      trustDeviceAllowed: false
    });

    const setup = await post(app, "/api/auth/2fa/setup", { currentPassword: admin.password }, { headers: auth.headers });
    const secret = new URL(setup.json<{ otpauthUri: string }>().otpauthUri).searchParams.get("secret") ?? "";
    const enabled = await post(app, "/api/auth/2fa/enable", { code: await totpCodeAt(secret, app.clock.now()) }, { headers: auth.headers });
    expect(enabled.statusCode).toBe(200);
    const fresh = { authorization: `Bearer ${enabled.json<{ accessToken: string }>().accessToken}` };
    expect((await app.inject({ method: "GET", url: "/api/admin/users", headers: fresh })).statusCode).toBe(200);
    // The gate trusts the session in the database, so the old access token works too.
    expect((await app.inject({ method: "GET", url: "/api/admin/users", ...auth })).statusCode).toBe(200);
  });

  it("puts the password change first for the seed admin, then the enrollment gate", async () => {
    app = await createTestApp();
    const seedAdmin = await createUser({ role: "admin", mustChangePassword: true, twoFactor: false });
    const { auth } = await loginFull(app, seedAdmin);
    const before = await app.inject({ method: "GET", url: "/api/admin/users", ...auth });
    expect(errorCode(before)).toBe("PASSWORD_CHANGE_REQUIRED");
    expect((await post(app, "/api/auth/2fa/setup", { currentPassword: seedAdmin.password }, { headers: auth.headers })).statusCode).toBe(403);
    const changed = await post(
      app,
      "/api/auth/change-password",
      { currentPassword: seedAdmin.password, newPassword: "una-frase-nueva-larga-2026" },
      { headers: auth.headers }
    );
    expect(changed.statusCode).toBe(200);
    const next = { authorization: `Bearer ${changed.json<{ accessToken: string }>().accessToken}` };
    expect(changed.json()).toMatchObject({ user: { twoFactorSetupRequired: true } });
    expect(errorCode(await app.inject({ method: "GET", url: "/api/admin/users", headers: next }))).toBe("TWO_FACTOR_SETUP_REQUIRED");
  });

  it("keeps a verified admin verified across a password change, and revokes trusted devices", async () => {
    app = await createTestApp();
    const admin = await createUser({ role: "admin", emailVerified: true });
    const { auth } = await loginFull(app, admin);
    const changed = await post(
      app,
      "/api/auth/change-password",
      { currentPassword: admin.password, newPassword: "una-frase-nueva-larga-2026" },
      { headers: auth.headers }
    );
    const next = { authorization: `Bearer ${changed.json<{ accessToken: string }>().accessToken}` };
    expect((await app.inject({ method: "GET", url: "/api/admin/users", headers: next })).statusCode).toBe(200);
  });

  it("does not let a forged claim pass the gate (the database decides)", async () => {
    app = await createTestApp();
    const admin = await createUser({ role: "admin", emailVerified: true, twoFactor: false });
    const session = await createSession(admin.id, { twoFactorVerified: false });
    const forged = await bearerFor(admin, session);
    expect(errorCode(await app.inject({ method: "GET", url: "/api/admin/users", ...forged }))).toBe("TWO_FACTOR_SETUP_REQUIRED");
  });

  it("closes an enrolled member's sessions and trusted devices when promoted, so the next login asks for a code", async () => {
    app = await createTestApp();
    const admin = await createUser({ role: "admin", emailVerified: true });
    const member = await createUser({ emailVerified: true, twoFactor: true });
    await getTestDb()
      .insert(trustedDevices)
      .values({ userId: member.id, tokenHash: hashToken("t".repeat(43)), userAgentLabel: "x", expiresAt: new Date(Date.now() + DAY_MS) });
    const memberSession = await createSession(member.id, { twoFactorVerified: false });
    const adminAuth = await bearerFor(admin, await createSession(admin.id));
    const promoted = await app.inject({ method: "PATCH", url: `/api/admin/users/${member.id}`, payload: { role: "admin" }, ...adminAuth });
    expect(promoted.statusCode).toBe(200);
    const [session] = await getTestDb().select().from(sessions).where(eq(sessions.id, memberSession.id));
    expect(session?.revokedAt).not.toBeNull();
    const [device] = await getTestDb().select().from(trustedDevices).where(eq(trustedDevices.userId, member.id));
    expect(device?.revokedAt).not.toBeNull();
  });
});

describe("POST /api/admin/users/:id/2fa/reset", () => {
  it("resets a member: secret, codes and devices gone, sessions revoked, audited, emailed", async () => {
    const mailer = new FakeMailer();
    app = await createTestApp({ mailer });
    const admin = await createUser({ role: "admin", emailVerified: true });
    const member = await createUser({ emailVerified: true, twoFactor: true });
    await getTestDb().insert(userRecoveryCodes).values({ userId: member.id, codeHash: "h" });
    await getTestDb()
      .insert(trustedDevices)
      .values({ userId: member.id, tokenHash: hashToken("u".repeat(43)), userAgentLabel: "x", expiresAt: new Date(Date.now() + DAY_MS) });
    const memberSession = await createSession(member.id);
    const adminAuth = await bearerFor(admin, await createSession(admin.id));

    const self = await app.inject({ method: "POST", url: `/api/admin/users/${admin.id}/2fa/reset`, ...adminAuth });
    expect(self.statusCode).toBe(403);

    const reset = await app.inject({ method: "POST", url: `/api/admin/users/${member.id}/2fa/reset`, ...adminAuth });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({ id: member.id, twoFactorEnabled: false });
    expect(await getTestDb().select().from(userTotp).where(eq(userTotp.userId, member.id))).toEqual([]);
    expect(await getTestDb().select().from(userRecoveryCodes).where(eq(userRecoveryCodes.userId, member.id))).toEqual([]);
    const [device] = await getTestDb().select().from(trustedDevices).where(eq(trustedDevices.userId, member.id));
    expect(device?.revokedAt).not.toBeNull();
    const [session] = await getTestDb().select().from(sessions).where(eq(sessions.id, memberSession.id));
    expect(session?.revokedAt).not.toBeNull();
    const [audit] = await auditRows("user.2fa_reset", member.id);
    expect(audit).toMatchObject({ actorUserId: admin.id });
    expect(audit?.metadata).toMatchObject({ revokedSessions: 1, revokedTrustedDevices: 1 });
    await app.jobs.onIdle();
    expect(mailer.lastTo(member.email)?.subject).toBe("Restablecieron tu verificación en dos pasos");
    // Nothing left to reset.
    expect((await app.inject({ method: "POST", url: `/api/admin/users/${member.id}/2fa/reset`, ...adminAuth })).statusCode).toBe(409);
    // A member cannot call it.
    const memberAuth = await bearerFor(member, await createSession(member.id));
    expect((await app.inject({ method: "POST", url: `/api/admin/users/${admin.id}/2fa/reset`, ...memberAuth })).statusCode).toBe(403);
  });

  it("alerts the other admins when the target is an admin, who must then enroll again", async () => {
    const mailer = new FakeMailer();
    app = await createTestApp({ mailer });
    const actor = await createUser({ role: "admin", emailVerified: true, displayName: "Ana Morales" });
    const target = await createUser({ role: "admin", emailVerified: true, displayName: "Beto Vega" });
    const third = await createUser({ role: "admin", emailVerified: true, displayName: "Carla Ruiz" });
    const actorAuth = await bearerFor(actor, await createSession(actor.id));
    const reset = await app.inject({ method: "POST", url: `/api/admin/users/${target.id}/2fa/reset`, ...actorAuth });
    expect(reset.statusCode).toBe(200);
    await app.jobs.onIdle();
    const alert = mailer.lastTo(third.email);
    expect(alert?.subject).toContain("administrador");
    expect(alert?.text).toContain("Restableció su verificación en dos pasos");
    const [audit] = await auditRows("user.2fa_reset", target.id);
    expect(audit?.metadata).toMatchObject({ adminAlertExempt: true });
    // The target's next login has no 2FA, so the gate makes them enroll.
    const relogin = await loginFull(app, target);
    expect(errorCode(await app.inject({ method: "GET", url: "/api/admin/users", ...relogin.auth }))).toBe("TWO_FACTOR_SETUP_REQUIRED");
  });
});

describe("PII scan (WP-7)", () => {
  it("never puts secrets, codes, otpauth URIs or tokens in logs, and the secret only in the setup response", async () => {
    const lines: string[] = [];
    const mailer = new FakeMailer();
    app = await createTestApp({ mailer, logStream: { write: (line) => lines.push(line) } });
    const member = await createUser({ emailVerified: true });
    const { auth } = await loginFull(app, member);
    const responses: Array<{ url: string; body: string }> = [];
    const record = (url: string, response: LightMyRequestResponse): LightMyRequestResponse => {
      responses.push({ url, body: response.body });
      return response;
    };

    const setup = record("setup", await post(app, "/api/auth/2fa/setup", { currentPassword: member.password }, { headers: auth.headers }));
    const uri = setup.json<{ otpauthUri: string }>().otpauthUri;
    const secret = new URL(uri).searchParams.get("secret") ?? "";
    const enabled = record(
      "enable",
      await post(app, "/api/auth/2fa/enable", { code: await totpCodeAt(secret, app.clock.now()) }, { headers: auth.headers })
    );
    const codes = enabled.json<{ recoveryCodes: string[] }>().recoveryCodes;
    const challenge = record("login", await login(app, member));
    const challengeToken = challengeTokenOf(challenge) ?? "";
    record("verify-wrong", await post(app, "/api/auth/2fa/verify", { challengeToken, code: "000000" }));
    const verified = record("verify", await post(app, "/api/auth/2fa/verify", { challengeToken, recoveryCode: codes[0], trustDevice: true }));
    const deviceToken = cookieNamed(verified, "cuencada_td")?.value ?? "";
    const headers = { authorization: `Bearer ${verified.json<{ accessToken: string }>().accessToken}` };
    record("status", await app.inject({ method: "GET", url: "/api/auth/2fa/status", headers }));
    record("devices", await app.inject({ method: "GET", url: "/api/auth/2fa/trusted-devices", headers }));
    record("me", await app.inject({ method: "GET", url: "/api/me", headers }));
    const auditor = await createUser({ role: "admin" });
    const auditorAuth = await bearerFor(auditor, await createSession(auditor.id));
    record("audit", await app.inject({ method: "GET", url: "/api/admin/audit-logs?limit=100", ...auditorAuth }));
    await app.jobs.onIdle();

    const auditStore = JSON.stringify(await getTestDb().select().from(auditLogs));
    const logs = lines.join("\n");
    const mails = JSON.stringify(mailer.outbox);
    const secrets = [secret, uri, challengeToken, deviceToken, TEST_TOTP_SECRET, ...codes, ...codes.map((code) => code.replaceAll("-", ""))];
    for (const value of secrets) {
      expect(logs.includes(value), "logs").toBe(false);
      expect(auditStore.includes(value), "audit_logs").toBe(false);
      expect(mails.includes(value), "emails").toBe(false);
    }
    for (const { url, body } of responses) {
      if (url !== "setup") expect(body.includes(secret), url).toBe(false);
      if (url !== "setup") expect(body.includes("otpauth://"), url).toBe(false);
      if (url !== "enable") for (const code of codes) expect(body.includes(code), url).toBe(false);
      if (url !== "login") expect(body.includes(challengeToken), url).toBe(false);
      expect(body.includes(deviceToken), url).toBe(false);
    }
  });
});
