import { eq } from "drizzle-orm";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { DAY_MS, linkToken, loginFull, refreshCookie, TestClock } from "../../../test/helpers/auth.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { createUser, type TestUser } from "../../../test/helpers/factories.js";
import { FakeMailer } from "../../../test/helpers/fakes.js";
import type { App } from "../../app.js";
import { mailQueue } from "../auth/mailQueue.js";
import { auditLogs, invites, people, profiles, users } from "../../db/schema/index.js";
import { hashToken } from "../../lib/tokens.js";
import { INVITE_ACCEPT_PER_TOKEN } from "./publicRoutes.js";

const PASSWORD = "contraseña-muy-segura";

let app: App | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function code(response: { json: <T>() => T }): string {
  return response.json<{ error: { code: string } }>().error.code;
}

interface Created {
  statusCode: number;
  inviteId: string;
  inviteUrl: string | null;
  body: string;
}

async function adminAuth(instance: App): Promise<{ admin: TestUser; auth: { headers: { authorization: string } } }> {
  const admin = await createUser({ role: "admin", displayName: "Tía Lupe", emailVerified: true });
  return { admin, auth: (await loginFull(instance, admin)).auth };
}

async function createInvite(
  instance: App,
  auth: { headers: { authorization: string } },
  payload: Record<string, unknown>
): Promise<Created> {
  const response = await instance.inject({ method: "POST", url: "/api/admin/invites", payload, ...auth });
  const body = response.statusCode === 201 ? response.json<{ invite: { id: string }; inviteUrl: string | null }>() : null;
  return {
    statusCode: response.statusCode,
    inviteId: body?.invite.id ?? "",
    inviteUrl: body?.inviteUrl ?? null,
    body: response.body
  };
}

function tokenOf(url: string | null): string {
  const token = url === null ? undefined : new URL(url).hash.replace(/^#t=/, "");
  if (token === undefined || token === "") throw new Error("no token in invite URL");
  return token;
}

function accept(
  instance: App,
  token: string,
  email: string,
  displayName = "Primo Nuevo",
  headers: Record<string, string> = {}
): Promise<LightMyRequestResponse> {
  return instance.inject({
    method: "POST",
    url: "/api/invites/accept",
    headers,
    payload: { token, email, displayName, password: PASSWORD }
  });
}

function inspect(instance: App, token: string): Promise<LightMyRequestResponse> {
  return instance.inject({ method: "POST", url: "/api/invites/inspect", payload: { token } });
}

describe("POST /api/admin/invites", () => {
  it("emails a bound invite, returns no copy-link, records last_sent_at and audits", async () => {
    const mailer = new FakeMailer();
    app = await createTestApp({ mailer });
    const { admin, auth } = await adminAuth(app);

    const created = await createInvite(app, auth, { email: "Primo@Familia.MX" });

    expect(created.statusCode).toBe(201);
    expect(created.inviteUrl).toBeNull();
    expect(created.body).not.toMatch(/token|hash/i);
    const mail = mailer.lastTo("primo@familia.mx");
    expect(mail?.subject).toContain("Tía Lupe");
    expect(mail?.text).toContain("http://localhost:5173/invitacion#t=");
    expect(mail?.idempotencyKey).toMatch(new RegExp(`^invite:${created.inviteId}:\\d+$`));
    const [row] = await getTestDb().select().from(invites).where(eq(invites.id, created.inviteId));
    expect(row).toMatchObject({ email: "primo@familia.mx", maxUses: 1, role: "member", createdByUserId: admin.id });
    expect(row?.lastSentAt).not.toBeNull();
    expect(row?.tokenHash).toBe(hashToken(linkToken(mail)));
    const audits = await getTestDb().select().from(auditLogs).where(eq(auditLogs.action, "invite.created"));
    expect(audits[0]).toMatchObject({ actorUserId: admin.id, entityId: created.inviteId });
    expect(JSON.stringify(audits[0]?.metadata)).not.toContain("primo@familia.mx");
  });

  it("returns the copy-link once for open and copy-link invites, without sending email", async () => {
    const mailer = new FakeMailer();
    app = await createTestApp({ mailer });
    const { auth } = await adminAuth(app);

    const open = await createInvite(app, auth, { sendEmail: false, maxUses: 20, expiresInDays: 14 });
    const boundCopy = await createInvite(app, auth, { email: "tio@familia.mx", sendEmail: false });

    expect(open.statusCode).toBe(201);
    expect(open.inviteUrl).toMatch(/^http:\/\/localhost:5173\/invitacion#t=[A-Za-z0-9_-]{43}$/);
    expect(boundCopy.inviteUrl).toMatch(/#t=/);
    expect(mailer.outbox).toHaveLength(0);
    const list = await app.inject({ method: "GET", url: "/api/admin/invites", ...auth });
    expect(list.body).not.toContain(tokenOf(open.inviteUrl));
    expect(list.json<{ items: Array<{ lastSentAt: string | null }> }>().items.every((item) => item.lastSentAt === null)).toBe(
      true
    );
  });

  it("enforces the contract caps with 400 VALIDATION", async () => {
    app = await createTestApp();
    const { auth } = await adminAuth(app);

    const cases = [
      { email: "a@familia.mx", maxUses: 2 },
      { sendEmail: false, maxUses: 21 },
      { sendEmail: false, expiresInDays: 15 },
      { role: "admin", email: "b@familia.mx", sendEmail: false },
      { role: "admin", sendEmail: false },
      { email: null }
    ];
    for (const payload of cases) {
      const created = await createInvite(app, auth, payload);
      expect(created.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it("answers 409 for an email that already has an account and 400 for an unknown person", async () => {
    app = await createTestApp();
    const { auth } = await adminAuth(app);
    const existing = await createUser();

    const taken = await createInvite(app, auth, { email: existing.email.toUpperCase() });
    const person = await createInvite(app, auth, {
      email: "c@familia.mx",
      personId: "00000000-0000-4000-8000-000000000000"
    });

    expect(taken.statusCode).toBe(409);
    expect(person.statusCode).toBe(400);
  });

  it("answers 401 without a token and 403 for members", async () => {
    app = await createTestApp();
    const member = await loginFull(app, await createUser());

    expect((await app.inject({ method: "POST", url: "/api/admin/invites", payload: {} })).statusCode).toBe(401);
    expect((await createInvite(app, member.auth, { email: "d@familia.mx" })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/admin/invites", ...member.auth })).statusCode).toBe(403);
  });
});

describe("GET /api/admin/invites", () => {
  it("pages newest first with an opaque cursor and filters by effective status", async () => {
    const clock = new TestClock();
    app = await createTestApp({ clock });
    const { admin, auth } = await adminAuth(app);
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const created = await createInvite(app, auth, {
        email: `p${index}@familia.mx`,
        sendEmail: false,
        expiresInDays: 1 + index
      });
      ids.push(created.inviteId);
    }

    const first = await app.inject({ method: "GET", url: "/api/admin/invites?limit=2", ...auth });
    const firstPage = first.json<{ items: Array<{ id: string }>; nextCursor: string | null }>();
    const second = await app.inject({
      method: "GET",
      url: `/api/admin/invites?limit=2&cursor=${firstPage.nextCursor ?? ""}`,
      ...auth
    });
    const secondPage = second.json<{ items: Array<{ id: string }>; nextCursor: string | null }>();

    expect(first.statusCode).toBe(200);
    expect(second.statusCode, second.body).toBe(200);
    expect(firstPage.items).toHaveLength(2);
    expect([...firstPage.items, ...secondPage.items].map((item) => item.id).sort()).toEqual([...ids].sort());
    expect(secondPage.nextCursor).toBeNull();

    clock.advance(DAY_MS + 1000);
    // ids[0] expires after 1 day; the others are still pending. The old access token expired too.
    const fresh = (await loginFull(app, admin)).auth;
    const expired = await app.inject({ method: "GET", url: "/api/admin/invites?status=expired", ...fresh });
    const pending = await app.inject({ method: "GET", url: "/api/admin/invites?status=pending", ...fresh });
    expect(expired.json<{ items: Array<{ id: string; status: string }> }>().items).toEqual([
      expect.objectContaining({ id: ids[0], status: "expired" })
    ]);
    expect(pending.json<{ items: unknown[] }>().items).toHaveLength(2);

    const badCursor = await app.inject({ method: "GET", url: "/api/admin/invites?cursor=bm9wZQ", ...fresh });
    expect(code(badCursor)).toBe("VALIDATION");
  });
});

describe("revoke and resend", () => {
  it("revokes a pending invite (idempotently) so it can no longer be inspected", async () => {
    app = await createTestApp();
    const { auth } = await adminAuth(app);
    const created = await createInvite(app, auth, { sendEmail: false });

    const revoked = await app.inject({ method: "POST", url: `/api/admin/invites/${created.inviteId}/revoke`, ...auth });
    const again = await app.inject({ method: "POST", url: `/api/admin/invites/${created.inviteId}/revoke`, ...auth });
    const missing = await app.inject({
      method: "POST",
      url: "/api/admin/invites/00000000-0000-4000-8000-000000000000/revoke",
      ...auth
    });

    expect(revoked.json<{ status: string }>().status).toBe("revoked");
    expect(again.statusCode).toBe(200);
    expect(missing.statusCode).toBe(404);
    expect(code(await inspect(app, tokenOf(created.inviteUrl)))).toBe("INVITE_INVALID");
    const audits = await getTestDb().select().from(auditLogs).where(eq(auditLogs.action, "invite.revoked"));
    expect(audits).toHaveLength(1);
  });

  it("answers 409 when revoking an accepted invite", async () => {
    app = await createTestApp();
    const { auth } = await adminAuth(app);
    const created = await createInvite(app, auth, { email: "e@familia.mx", sendEmail: false });
    expect((await accept(app, tokenOf(created.inviteUrl), "e@familia.mx")).statusCode).toBe(201);

    const response = await app.inject({ method: "POST", url: `/api/admin/invites/${created.inviteId}/revoke`, ...auth });

    expect(response.statusCode).toBe(409);
  });

  it("resend rotates the token, emails it and marks the invite as delivered by email", async () => {
    const mailer = new FakeMailer();
    app = await createTestApp({ mailer });
    const { auth } = await adminAuth(app);
    const created = await createInvite(app, auth, { email: "f@familia.mx", sendEmail: false });
    const oldToken = tokenOf(created.inviteUrl);

    const resent = await app.inject({ method: "POST", url: `/api/admin/invites/${created.inviteId}/resend`, ...auth });

    expect(resent.statusCode).toBe(200);
    expect(resent.json<{ lastSentAt: string | null }>().lastSentAt).not.toBeNull();
    const newToken = linkToken(mailer.lastTo("f@familia.mx"));
    expect(newToken).not.toBe(oldToken);
    expect(code(await inspect(app, oldToken))).toBe("INVITE_INVALID");
    const accepted = await accept(app, newToken, "f@familia.mx");
    expect(accepted.json<{ user: { emailVerified: boolean } }>().user.emailVerified).toBe(true);
  });

  it("refuses to resend an open invite (409)", async () => {
    app = await createTestApp();
    const { auth } = await adminAuth(app);
    const created = await createInvite(app, auth, { sendEmail: false, maxUses: 5 });

    const response = await app.inject({ method: "POST", url: `/api/admin/invites/${created.inviteId}/resend`, ...auth });

    expect(response.statusCode).toBe(409);
  });
});

describe("POST /api/invites/inspect", () => {
  it("returns only the masked email, role, expiry and names", async () => {
    app = await createTestApp();
    const { auth } = await adminAuth(app);
    const [person] = await getTestDb().insert(people).values({ fullName: "Ana Morales Pérez" }).returning();
    const bound = await createInvite(app, auth, { email: "tia.ana@familia.mx", sendEmail: false, personId: person?.id });
    const open = await createInvite(app, auth, { sendEmail: false, maxUses: 3 });

    const boundView = await inspect(app, tokenOf(bound.inviteUrl));
    const openView = await inspect(app, tokenOf(open.inviteUrl));

    expect(boundView.statusCode).toBe(200);
    expect(boundView.json()).toEqual({
      emailMasked: "t***@f***.mx",
      role: "member",
      expiresAt: expect.any(String),
      invitedByName: "Tía Lupe",
      suggestedDisplayName: "Ana Morales Pérez"
    });
    expect(boundView.body).not.toContain("tia.ana");
    expect(openView.json<{ emailMasked: string | null }>().emailMasked).toBeNull();
  });

  it("gives one identical INVITE_INVALID for unknown, expired, used and revoked invites", async () => {
    const clock = new TestClock();
    app = await createTestApp({ clock });
    const { auth } = await adminAuth(app);
    const expiring = await createInvite(app, auth, { sendEmail: false, expiresInDays: 1 });
    const used = await createInvite(app, auth, { email: "g@familia.mx", sendEmail: false });
    const revoked = await createInvite(app, auth, { sendEmail: false });
    await accept(app, tokenOf(used.inviteUrl), "g@familia.mx");
    await app.inject({ method: "POST", url: `/api/admin/invites/${revoked.inviteId}/revoke`, ...auth });
    clock.advance(DAY_MS + 1000);

    const bodies = await Promise.all(
      [tokenOf(expiring.inviteUrl), tokenOf(used.inviteUrl), tokenOf(revoked.inviteUrl), "z".repeat(43)].map(
        async (token) => {
          const response = await inspect(app as App, token);
          return `${response.statusCode} ${response.body}`;
        }
      )
    );

    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toMatch(/^400 .*INVITE_INVALID/);
  });
});

describe("POST /api/invites/accept", () => {
  it("creates the account, profile and linked person, verifies an emailed bound invite and logs in", async () => {
    const mailer = new FakeMailer();
    app = await createTestApp({ mailer });
    const { auth } = await adminAuth(app);
    const [person] = await getTestDb().insert(people).values({ fullName: "Primo Nuevo Morales" }).returning();
    const created = await createInvite(app, auth, { email: "nuevo@familia.mx", personId: person?.id });
    const token = linkToken(mailer.lastTo("nuevo@familia.mx"));

    const response = await accept(app, token, "NUEVO@familia.mx");

    expect(response.statusCode).toBe(201);
    const body = response.json<{ accessToken: string; user: Record<string, unknown> }>();
    expect(body.user).toMatchObject({
      email: "nuevo@familia.mx",
      displayName: "Primo Nuevo",
      role: "member",
      emailVerified: true,
      mustChangePassword: false,
      personId: person?.id
    });
    expect(refreshCookie(response)?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [user] = await getTestDb().select().from(users).where(eq(users.email, "nuevo@familia.mx"));
    expect(user?.invitedByInviteId).toBe(created.inviteId);
    const [profile] = await getTestDb().select().from(profiles).where(eq(profiles.userId, user?.id ?? ""));
    expect(profile?.fullName).toBe("Primo Nuevo");
    const [invite] = await getTestDb().select().from(invites).where(eq(invites.id, created.inviteId));
    expect(invite).toMatchObject({ useCount: 1, status: "accepted" });
    const audits = await getTestDb().select().from(auditLogs).where(eq(auditLogs.action, "invite.accepted"));
    expect(audits[0]).toMatchObject({ actorUserId: user?.id, entityId: created.inviteId });
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${body.accessToken}` } });
    expect(me.statusCode).toBe(200);
  });

  it("leaves emailVerified false for copy-link bound invites and open invites, and creates a person", async () => {
    app = await createTestApp();
    const { auth } = await adminAuth(app);
    const bound = await createInvite(app, auth, { email: "h@familia.mx", sendEmail: false });
    const open = await createInvite(app, auth, { sendEmail: false, maxUses: 2 });

    const boundUser = await accept(app, tokenOf(bound.inviteUrl), "h@familia.mx");
    const openUser = await accept(app, tokenOf(open.inviteUrl), "i@familia.mx");

    expect(boundUser.json<{ user: { emailVerified: boolean } }>().user.emailVerified).toBe(false);
    const openBody = openUser.json<{ user: { emailVerified: boolean; personId: string | null } }>().user;
    expect(openBody.emailVerified).toBe(false);
    expect(openBody.personId).not.toBeNull();
  });

  it("answers INVITE_INVALID when the typed email does not match the bound one", async () => {
    app = await createTestApp();
    const { auth } = await adminAuth(app);
    const created = await createInvite(app, auth, { email: "j@familia.mx", sendEmail: false });

    const response = await accept(app, tokenOf(created.inviteUrl), "otro@familia.mx");

    expect(response.statusCode).toBe(400);
    expect(code(response)).toBe("INVITE_INVALID");
    expect(await getTestDb().select().from(users).where(eq(users.email, "otro@familia.mx"))).toHaveLength(0);
  });

  it("answers 409 CONFLICT when the email already has an account", async () => {
    app = await createTestApp();
    const { auth } = await adminAuth(app);
    const existing = await createUser();
    const open = await createInvite(app, auth, { sendEmail: false, maxUses: 2 });

    const response = await accept(app, tokenOf(open.inviteUrl), existing.email);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: { code: "CONFLICT", message: "Ya tienes cuenta, inicia sesión." } });
    const [invite] = await getTestDb().select().from(invites).where(eq(invites.id, open.inviteId));
    expect(invite?.useCount).toBe(0);
  });

  it("stops an open invite at max uses", async () => {
    app = await createTestApp();
    const { auth } = await adminAuth(app);
    const open = await createInvite(app, auth, { sendEmail: false, maxUses: 2 });
    const token = tokenOf(open.inviteUrl);

    const statuses = [
      (await accept(app, token, "k1@familia.mx")).statusCode,
      (await accept(app, token, "k2@familia.mx")).statusCode,
      (await accept(app, token, "k3@familia.mx")).statusCode
    ];

    expect(statuses).toEqual([201, 201, 400]);
    const [invite] = await getTestDb().select().from(invites).where(eq(invites.id, open.inviteId));
    expect(invite).toMatchObject({ useCount: 2, status: "accepted" });
  });

  it("lets exactly one of two concurrent accepts of a single-use invite succeed", async () => {
    app = await createTestApp();
    const { auth } = await adminAuth(app);
    const open = await createInvite(app, auth, { sendEmail: false, maxUses: 1 });
    const token = tokenOf(open.inviteUrl);

    const results = await Promise.all([accept(app, token, "l1@familia.mx"), accept(app, token, "l2@familia.mx")]);

    expect(results.map((response) => response.statusCode).sort()).toEqual([201, 400]);
    const created = await getTestDb().select().from(users).where(eq(users.invitedByInviteId, open.inviteId));
    expect(created).toHaveLength(1);
  });

  it("rejects display names made only of invisible characters", async () => {
    app = await createTestApp();
    const { auth } = await adminAuth(app);
    const open = await createInvite(app, auth, { sendEmail: false, maxUses: 5 });
    const token = tokenOf(open.inviteUrl);

    for (const displayName of ["\u3164", "\u2060\u2060", "\u00AD", "\u3164 \u3164"]) {
      const response = await accept(app, token, "m@familia.mx", displayName);
      expect(response.statusCode, JSON.stringify(displayName)).toBe(400);
      expect(response.json<{ error: { details: Array<{ path: string }> } }>().error.details[0]?.path).toBe("displayName");
    }
  });

  it("does not touch another user's session when the request carries their access token", async () => {
    app = await createTestApp();
    const { auth } = await adminAuth(app);
    const signedIn = await createUser({ displayName: "Usuario Previo" });
    const previous = await loginFull(app, signedIn);
    const open = await createInvite(app, auth, { sendEmail: false, maxUses: 2 });

    const response = await accept(app, tokenOf(open.inviteUrl), "n@familia.mx", "Primo Nuevo", previous.auth.headers);

    expect(response.statusCode).toBe(201);
    expect(response.body).not.toContain(signedIn.id);
    expect(response.body).not.toContain("Usuario Previo");
    expect((await app.inject({ method: "GET", url: "/api/me", ...previous.auth })).json<{ id: string }>().id).toBe(
      signedIn.id
    );
  });

  it(`limits accept attempts per invite to ${INVITE_ACCEPT_PER_TOKEN.max} across IPs (429)`, async () => {
    app = await createTestApp({ config: { TRUST_PROXY: ["loopback"] } });
    const { auth } = await adminAuth(app);
    const open = await createInvite(app, auth, { sendEmail: false, maxUses: 20 });
    const other = await createInvite(app, auth, { sendEmail: false, maxUses: 20 });
    const existing = await createUser();
    const statuses: number[] = [];
    for (let attempt = 0; attempt <= INVITE_ACCEPT_PER_TOKEN.max; attempt += 1) {
      const response = await accept(app, tokenOf(open.inviteUrl), existing.email, "Sondeo", {
        "x-forwarded-for": `203.0.113.${attempt + 1}`
      });
      statuses.push(response.statusCode);
    }

    expect(statuses.slice(0, INVITE_ACCEPT_PER_TOKEN.max).every((status) => status === 409)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    const unaffected = await accept(app, tokenOf(other.inviteUrl), "o@familia.mx", "Otro", {
      "x-forwarded-for": "203.0.113.100"
    });
    expect(unaffected.statusCode).toBe(201);
  });

  it("answers 400 VALIDATION for a malformed body", async () => {
    app = await createTestApp();
    const response = await app.inject({ method: "POST", url: "/api/invites/accept", payload: { token: "x" } });
    expect(code(response)).toBe("VALIDATION");
  });
});

describe("auth and invite logs", () => {
  it("never contain raw tokens, emails or passwords", async () => {
    const lines: string[] = [];
    const mailer = new FakeMailer();
    app = await createTestApp({ mailer, logStream: { write: (line) => lines.push(line) } });
    const admin = await createUser({ role: "admin", email: "jefa@familia.mx" });
    const adminLogin = await loginFull(app, admin);
    const created = await createInvite(app, adminLogin.auth, { email: "secreto@familia.mx" });
    const inviteToken = linkToken(mailer.lastTo("secreto@familia.mx"));
    await inspect(app, inviteToken);
    await accept(app, inviteToken, "secreto@familia.mx");
    await app.inject({ method: "POST", url: "/api/auth/magic-link/request", payload: { email: "jefa@familia.mx" } });
    await mailQueue(app).onIdle();
    const magicToken = linkToken(mailer.lastTo("jefa@familia.mx"));
    await app.inject({ method: "POST", url: "/api/auth/magic-link/consume", payload: { token: magicToken } });
    await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "nadie@familia.mx", password: "una-clave-equivocada" }
    });

    const log = lines.join("\n");
    expect(lines.length).toBeGreaterThan(5);
    expect(created.statusCode).toBe(201);
    for (const secret of [
      inviteToken,
      magicToken,
      adminLogin.refreshToken,
      adminLogin.body.accessToken,
      "secreto@familia.mx",
      "jefa@familia.mx",
      "nadie@familia.mx",
      PASSWORD,
      admin.password,
      "una-clave-equivocada"
    ]) {
      expect(log).not.toContain(secret);
    }
  });
});
