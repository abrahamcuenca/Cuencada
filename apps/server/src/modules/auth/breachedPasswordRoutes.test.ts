/**
 * WP-2.3c: the breached-password check (ASVS 2.1.7) on every route where a
 * user chooses a password. Only the HIBP range fetcher is faked.
 */
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { linkToken, loginFull } from "../../../test/helpers/auth.js";
import { type FakeRange, fakeRange } from "../../../test/helpers/breach.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { createUser } from "../../../test/helpers/factories.js";
import { FakeMailer } from "../../../test/helpers/fakes.js";
import type { App } from "../../app.js";
import { invites, magicLinks, users } from "../../db/schema/index.js";
import { verifyPassword } from "../../lib/passwords.js";
import { mailQueue } from "./mailQueue.js";

const BREACHED = "contraseña-filtrada-de-ejemplo";
const GOOD = "una frase nueva que nadie filtró";
const BREACHED_MESSAGE = "Esta contraseña apareció en filtraciones de datos conocidas. Elige otra.";

let app: App | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

interface ErrorBody {
  error: { code: string; details?: Array<{ path: string; message: string; code?: string }> };
}

/** App with the check on and a fake range that knows {@link BREACHED}. */
async function appWithCheck(range: FakeRange, mailer = new FakeMailer(), logLines?: string[]): Promise<App> {
  return createTestApp({
    mailer,
    breachFetcher: range.fetcher,
    config: { PASSWORD_BREACH_CHECK: "on" },
    ...(logLines === undefined ? {} : { logStream: { write: (line: string) => logLines.push(line) } })
  });
}

function expectBreached(response: { statusCode: number; json: <T>() => T }, path: string): void {
  expect(response.statusCode).toBe(400);
  expect(response.json<ErrorBody>().error).toMatchObject({
    code: "VALIDATION",
    details: [{ path, message: BREACHED_MESSAGE, code: "PASSWORD_BREACHED" }]
  });
}

async function copyLinkInviteToken(instance: App): Promise<{ inviteId: string; token: string }> {
  const admin = await createUser({ role: "admin", emailVerified: true });
  const { auth } = await loginFull(instance, admin);
  const response = await instance.inject({
    method: "POST",
    url: "/api/admin/invites",
    payload: { email: "sobrina.prueba@familia.test", sendEmail: false },
    ...auth
  });
  expect(response.statusCode).toBe(201);
  const body = response.json<{ invite: { id: string }; inviteUrl: string }>();
  return { inviteId: body.invite.id, token: new URL(body.inviteUrl).hash.replace(/^#t=/, "") };
}

describe("POST /api/invites/accept with the breach check", () => {
  it("rejects a breached password on `password` without consuming the invite; a retry succeeds", async () => {
    const range = fakeRange([BREACHED]);
    app = await appWithCheck(range);
    const { inviteId, token } = await copyLinkInviteToken(app);
    const payload = { token, email: "sobrina.prueba@familia.test", displayName: "Sobrina Prueba" };

    const rejected = await app.inject({ method: "POST", url: "/api/invites/accept", payload: { ...payload, password: BREACHED } });

    expectBreached(rejected, "password");
    const [untouched] = await getTestDb().select().from(invites).where(eq(invites.id, inviteId));
    expect(untouched).toMatchObject({ useCount: 0, status: "pending" });
    expect(await getTestDb().select().from(users).where(eq(users.email, payload.email))).toEqual([]);

    const retried = await app.inject({ method: "POST", url: "/api/invites/accept", payload: { ...payload, password: GOOD } });
    expect(retried.statusCode).toBe(201);
    const [used] = await getTestDb().select().from(invites).where(eq(invites.id, inviteId));
    expect(used).toMatchObject({ useCount: 1, status: "accepted" });
    // Only 5-char prefixes ever left the server.
    expect(range.urls.every((url) => /\/range\/[0-9A-F]{5}$/.test(url))).toBe(true);
  });
});

describe("POST /api/auth/password-reset/confirm with the breach check", () => {
  it("rejects a breached password on `newPassword` without burning the token; a retry succeeds", async () => {
    const mailer = new FakeMailer();
    app = await appWithCheck(fakeRange([BREACHED]), mailer);
    const user = await createUser();
    await app.inject({ method: "POST", url: "/api/auth/password-reset/request", payload: { email: user.email } });
    await mailQueue(app).onIdle();
    const token = linkToken(mailer.lastTo(user.email));

    const rejected = await app.inject({
      method: "POST",
      url: "/api/auth/password-reset/confirm",
      payload: { token, newPassword: BREACHED }
    });

    expectBreached(rejected, "newPassword");
    const [link] = await getTestDb().select().from(magicLinks).where(eq(magicLinks.userId, user.id));
    expect(link?.usedAt).toBeNull();
    const [unchanged] = await getTestDb().select().from(users).where(eq(users.id, user.id));
    expect(unchanged?.passwordHash && (await verifyPassword(unchanged.passwordHash, user.password))).toBe(true);

    const retried = await app.inject({
      method: "POST",
      url: "/api/auth/password-reset/confirm",
      payload: { token, newPassword: GOOD }
    });
    expect(retried.statusCode).toBe(204);
    const [changed] = await getTestDb().select().from(users).where(eq(users.id, user.id));
    expect(changed?.passwordHash && (await verifyPassword(changed.passwordHash, GOOD))).toBe(true);
  });
});

describe("POST /api/auth/change-password with the breach check", () => {
  it("rejects a breached new password on `newPassword`, keeps the session, and accepts a good one", async () => {
    app = await appWithCheck(fakeRange([BREACHED]));
    const user = await createUser({ mustChangePassword: true });
    const login = await loginFull(app, user);

    const rejected = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      payload: { currentPassword: user.password, newPassword: BREACHED },
      ...login.auth
    });

    expectBreached(rejected, "newPassword");
    expect((await app.inject({ method: "GET", url: "/api/me", ...login.auth })).statusCode).toBe(200);
    const [row] = await getTestDb().select().from(users).where(eq(users.id, user.id));
    expect(row?.mustChangePassword).toBe(true);

    const retried = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      payload: { currentPassword: user.password, newPassword: GOOD },
      ...login.auth
    });
    expect(retried.statusCode).toBe(200);
  });

  it("fails open when the range service is down and logs no secret", async () => {
    const lines: string[] = [];
    app = await appWithCheck(fakeRange([BREACHED], { status: 503 }), new FakeMailer(), lines);
    const user = await createUser();
    const login = await loginFull(app, user);

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      payload: { currentPassword: user.password, newPassword: BREACHED },
      ...login.auth
    });

    expect(response.statusCode).toBe(200);
    const log = lines.join("\n");
    expect(log).toContain("password.breach_check_unavailable");
    expect(log).not.toContain(BREACHED);
  });

  it("skips the check entirely when PASSWORD_BREACH_CHECK is off", async () => {
    const range = fakeRange([BREACHED]);
    app = await createTestApp({ breachFetcher: range.fetcher, config: { PASSWORD_BREACH_CHECK: "off" } });
    const user = await createUser();
    const login = await loginFull(app, user);

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      payload: { currentPassword: user.password, newPassword: BREACHED },
      ...login.auth
    });

    expect(response.statusCode).toBe(200);
    expect(range.urls).toEqual([]);
  });
});
