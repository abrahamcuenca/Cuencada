/**
 * WP-2.3b: stricter open invites (10 uses / 72 h, clamped at accept time for
 * older rows) and the admin alert on every open-invite acceptance.
 */
import { OPEN_INVITE_MAX_LIFETIME_MS } from "@cuencada/types";
import { and, eq, sql } from "drizzle-orm";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { DAY_MS, linkToken, loginFull, TestClock } from "../../../test/helpers/auth.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { createUser, type TestUser } from "../../../test/helpers/factories.js";
import { FakeMailer, type SentMail } from "../../../test/helpers/fakes.js";
import type { App } from "../../app.js";
import { auditLogs, invites, users } from "../../db/schema/index.js";
import type { MailMessage, MailSendResult } from "../../lib/mailer/index.js";
import { createOpaqueToken, hashToken } from "../../lib/tokens.js";
import { mailQueue } from "../auth/mailQueue.js";
import { INVITE_ALERT_DAILY_CAP, INVITE_ALERT_METADATA_KEY } from "./acceptAlerts.js";

const PASSWORD = "contraseña-muy-segura";
const ALERT = "admin-invite-accepted";
const SECOND_MS = 1000;

let app: App | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

type Auth = { headers: { authorization: string } };

async function adminAuth(instance: App, displayName = "Tía Lupe"): Promise<{ admin: TestUser; auth: Auth }> {
  const admin = await createUser({ role: "admin", displayName, emailVerified: true });
  return { admin, auth: (await loginFull(instance, admin)).auth };
}

async function createInvite(
  instance: App,
  auth: Auth,
  payload: Record<string, unknown>
): Promise<{ statusCode: number; inviteId: string; token: string; body: string }> {
  const response = await instance.inject({ method: "POST", url: "/api/admin/invites", payload, ...auth });
  if (response.statusCode !== 201) return { statusCode: response.statusCode, inviteId: "", token: "", body: response.body };
  const body = response.json<{ invite: { id: string }; inviteUrl: string | null }>();
  const token = body.inviteUrl === null ? "" : new URL(body.inviteUrl).hash.replace(/^#t=/, "");
  return { statusCode: 201, inviteId: body.invite.id, token, body: response.body };
}

function accept(instance: App, token: string, email: string, displayName = "Primo Nuevo"): Promise<LightMyRequestResponse> {
  return instance.inject({
    method: "POST",
    url: "/api/invites/accept",
    payload: { token, email, displayName, password: PASSWORD }
  });
}

/** An open invite row as created before WP-2.3b (up to 20 uses and 14 days). */
async function insertLegacyOpenInvite(
  createdBy: string,
  values: { createdAt: Date; expiresAt: Date; maxUses: number; useCount?: number }
): Promise<{ id: string; token: string }> {
  const token = createOpaqueToken();
  const [row] = await getTestDb()
    .insert(invites)
    .values({ tokenHash: hashToken(token), email: null, role: "member", createdByUserId: createdBy, ...values })
    .returning({ id: invites.id });
  if (row === undefined) throw new Error("legacy invite insert returned no row");
  return { id: row.id, token };
}

async function alertsTo(mailer: FakeMailer, user: TestUser): Promise<SentMail[]> {
  if (app !== undefined) await mailQueue(app).onIdle();
  return mailer.outbox.filter((mail) => mail.to === user.email && mail.tags?.category === ALERT);
}

describe("creating open invites (WP-2.3b)", () => {
  it("defaults an open invite to 5 uses and 72 hours", async () => {
    const clock = new TestClock();
    app = await createTestApp({ clock });
    const { auth } = await adminAuth(app);

    const created = await createInvite(app, auth, { sendEmail: false });

    expect(created.statusCode).toBe(201);
    const [row] = await getTestDb().select().from(invites).where(eq(invites.id, created.inviteId));
    expect(row?.maxUses).toBe(5);
    expect(row?.createdAt.getTime()).toBe(clock.now().getTime());
    expect((row?.expiresAt.getTime() ?? 0) - clock.now().getTime()).toBe(OPEN_INVITE_MAX_LIFETIME_MS);
  });

  it("rejects over-limit open invites with 400 VALIDATION and accepts the boundaries", async () => {
    app = await createTestApp();
    const { auth } = await adminAuth(app);

    for (const payload of [
      { sendEmail: false, maxUses: 0 },
      { sendEmail: false, maxUses: 11 },
      { sendEmail: false, expiresInDays: 0 },
      { sendEmail: false, expiresInDays: 4 },
      { sendEmail: false, maxUses: 20, expiresInDays: 14 }
    ]) {
      const created = await createInvite(app, auth, payload);
      expect(created.statusCode, JSON.stringify(payload)).toBe(400);
      expect(created.body).toContain("VALIDATION");
    }
    for (const payload of [
      { sendEmail: false, maxUses: 1, expiresInDays: 1 },
      { sendEmail: false, maxUses: 10, expiresInDays: 3 },
      { email: "tio@familia.mx", sendEmail: false, expiresInDays: 30 }
    ]) {
      expect((await createInvite(app, auth, payload)).statusCode, JSON.stringify(payload)).toBe(201);
    }
    expect(await getTestDb().select().from(invites)).toHaveLength(3);
  });
});

describe("accepting open invites past their limits (WP-2.3b)", () => {
  it("accepts at 72 h - 1 s and fails generically at 72 h + 1 s", async () => {
    const clock = new TestClock();
    app = await createTestApp({ clock });
    const { auth } = await adminAuth(app);
    const early = await createInvite(app, auth, { sendEmail: false });
    const late = await createInvite(app, auth, { sendEmail: false });

    clock.advance(OPEN_INVITE_MAX_LIFETIME_MS - SECOND_MS);
    expect((await accept(app, early.token, "a1@familia.mx")).statusCode).toBe(201);

    clock.advance(2 * SECOND_MS);
    const expired = await accept(app, late.token, "a2@familia.mx");
    const unknown = await accept(app, "z".repeat(43), "a3@familia.mx");
    expect(expired.statusCode).toBe(400);
    expect(expired.body).toBe(unknown.body);
    expect(expired.json<{ error: { code: string } }>().error.code).toBe("INVITE_INVALID");
  });

  it("clamps an older open invite to 72 h after creation, at accept, inspect and in the admin list", async () => {
    const clock = new TestClock();
    app = await createTestApp({ clock });
    const { admin, auth } = await adminAuth(app);
    const now = clock.now();
    const legacy = await insertLegacyOpenInvite(admin.id, {
      createdAt: new Date(now.getTime() - OPEN_INVITE_MAX_LIFETIME_MS - SECOND_MS),
      expiresAt: new Date(now.getTime() + 10 * DAY_MS),
      maxUses: 20
    });
    const fresh = await insertLegacyOpenInvite(admin.id, {
      createdAt: new Date(now.getTime() - OPEN_INVITE_MAX_LIFETIME_MS + 60 * SECOND_MS),
      expiresAt: new Date(now.getTime() + 10 * DAY_MS),
      maxUses: 20
    });

    const refused = await accept(app, legacy.token, "b1@familia.mx");
    const inspected = await app.inject({ method: "POST", url: "/api/invites/inspect", payload: { token: legacy.token } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe("INVITE_INVALID");
    expect(inspected.json<{ error: { code: string } }>().error.code).toBe("INVITE_INVALID");
    expect(await getTestDb().select().from(users).where(eq(users.email, "b1@familia.mx"))).toHaveLength(0);

    const expiredList = await app.inject({ method: "GET", url: "/api/admin/invites?status=expired", ...auth });
    const pendingList = await app.inject({ method: "GET", url: "/api/admin/invites?status=pending", ...auth });
    const expiredItems = expiredList.json<{ items: Array<{ id: string; status: string; maxUses: number; expiresAt: string }> }>().items;
    expect(expiredItems).toEqual([expect.objectContaining({ id: legacy.id, status: "expired", maxUses: 10 })]);
    expect(new Date(expiredItems[0]?.expiresAt ?? "").getTime()).toBe(now.getTime() - SECOND_MS);
    expect(pendingList.json<{ items: Array<{ id: string }> }>().items.map((item) => item.id)).toEqual([fresh.id]);
  });

  it("stops an older open invite at 10 uses even when it allowed 20", async () => {
    app = await createTestApp();
    const { admin } = await adminAuth(app);
    const now = new Date();
    const full = await insertLegacyOpenInvite(admin.id, {
      createdAt: now,
      expiresAt: new Date(now.getTime() + DAY_MS),
      maxUses: 20,
      useCount: 10
    });
    const last = await insertLegacyOpenInvite(admin.id, {
      createdAt: now,
      expiresAt: new Date(now.getTime() + DAY_MS),
      maxUses: 20,
      useCount: 9
    });

    const refused = await accept(app, full.token, "c1@familia.mx");
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe("INVITE_INVALID");

    expect((await accept(app, last.token, "c2@familia.mx")).statusCode).toBe(201);
    expect((await accept(app, last.token, "c3@familia.mx")).statusCode).toBe(400);
    const [row] = await getTestDb().select().from(invites).where(eq(invites.id, last.id));
    expect(row).toMatchObject({ useCount: 10, status: "accepted" });
  });
});

describe("admin alert on open-invite acceptance (WP-2.3b)", () => {
  it("emails each active admin once per acceptance, by name only, with uses and a review link", async () => {
    const mailer = new FakeMailer();
    app = await createTestApp({ mailer });
    const { admin, auth } = await adminAuth(app);
    const other = await createUser({ role: "admin", displayName: "Tío Beto", emailVerified: true });
    const disabled = await createUser({ role: "admin", status: "disabled", displayName: "Admin Viejo" });
    const member = await createUser({ displayName: "Prima Ana" });
    const created = await createInvite(app, auth, { sendEmail: false, note: "Grupo de primos" });

    const response = await accept(app, created.token, "nuevo.primo@familia.mx", "Primo Nuevo");
    expect(response.statusCode).toBe(201);
    const [newUser] = await getTestDb().select().from(users).where(eq(users.email, "nuevo.primo@familia.mx"));

    const toAdmin = await alertsTo(mailer, admin);
    const toOther = await alertsTo(mailer, other);
    expect(toAdmin).toHaveLength(1);
    expect(toOther).toHaveLength(1);
    expect(await alertsTo(mailer, disabled)).toHaveLength(0);
    expect(await alertsTo(mailer, member)).toHaveLength(0);
    const mail = toAdmin[0];
    expect(mail?.subject).toBe("Alguien se unió con un enlace de invitación");
    expect(mail?.text).toContain("¡Hola, Tía Lupe!");
    expect(mail?.text).toContain("Primo Nuevo creó su cuenta");
    expect(mail?.text).toContain(`«Grupo de primos» (${created.inviteId.slice(0, 8)})`);
    expect(mail?.text).toContain("El enlace lleva 1 de 5 usos.");
    expect(mail?.text).toContain(
      `http://localhost:5173/admin/bitacora?accion=invite.accepted&actor=${newUser?.id ?? "missing"}`
    );
    expect(mail?.text).not.toContain("nuevo.primo@familia.mx");
    expect(mail?.html).not.toContain("nuevo.primo@familia.mx");
    expect(mail?.idempotencyKey).toMatch(new RegExp(`^admin-invite-accepted:[0-9a-f-]{36}:${admin.id}$`));

    const [audit] = await getTestDb().select().from(auditLogs).where(eq(auditLogs.action, "invite.accepted"));
    expect(audit?.metadata).toMatchObject({ open: true, useCount: 1, maxUses: 5, [INVITE_ALERT_METADATA_KEY]: 2 });
    expect(JSON.stringify(audit?.metadata)).not.toContain("@");

    expect((await accept(app, created.token, "otra.prima@familia.mx", "Otra Prima")).statusCode).toBe(201);
    const second = await alertsTo(mailer, admin);
    expect(second).toHaveLength(2);
    expect(second[1]?.text).toContain("El enlace lleva 2 de 5 usos.");
  });

  it("sends no alert for email-bound invites", async () => {
    const mailer = new FakeMailer();
    app = await createTestApp({ mailer });
    const { admin, auth } = await adminAuth(app);
    await createInvite(app, auth, { email: "emailed@familia.mx" });
    const copyLink = await createInvite(app, auth, { email: "copy@familia.mx", sendEmail: false });

    expect((await accept(app, linkToken(mailer.lastTo("emailed@familia.mx")), "emailed@familia.mx")).statusCode).toBe(201);
    expect((await accept(app, copyLink.token, "copy@familia.mx")).statusCode).toBe(201);

    expect(await alertsTo(mailer, admin)).toHaveLength(0);
    const audits = await getTestDb().select().from(auditLogs).where(eq(auditLogs.action, "invite.accepted"));
    expect(audits.map((row) => row.metadata)).toEqual([
      expect.objectContaining({ open: false }),
      expect.objectContaining({ open: false })
    ]);
    expect(audits.every((row) => !(INVITE_ALERT_METADATA_KEY in (row.metadata ?? {})))).toBe(true);
  });

  it("sends no alert when the acceptance transaction rolls back", async () => {
    const mailer = new FakeMailer();
    app = await createTestApp({ mailer });
    const { admin, auth } = await adminAuth(app);
    const created = await createInvite(app, auth, { sendEmail: false });
    const db = getTestDb();
    // Fail the accept transaction at its last write (the audit row), after the alert was planned.
    await db.execute(sql.raw(`
      create or replace function w23b_fail_accept() returns trigger language plpgsql as $$
      begin raise exception 'forced rollback'; end $$;
      create trigger w23b_fail_accept before insert on audit_logs for each row
        when (new.action = 'invite.accepted' and new.entity_id = '${created.inviteId}')
        execute function w23b_fail_accept();
    `));
    try {
      const response = await accept(app, created.token, "rollback@familia.mx");
      expect(response.statusCode).toBe(500);
    } finally {
      await db.execute(sql.raw("drop trigger if exists w23b_fail_accept on audit_logs; drop function if exists w23b_fail_accept();"));
    }

    expect(await alertsTo(mailer, admin)).toHaveLength(0);
    expect(await db.select().from(users).where(eq(users.email, "rollback@familia.mx"))).toHaveLength(0);
    const [row] = await db.select().from(invites).where(eq(invites.id, created.inviteId));
    expect(row?.useCount).toBe(0);
  });

  it("still accepts when the alert email fails", async () => {
    class FailingAlertMailer extends FakeMailer {
      override async send(message: MailMessage): Promise<MailSendResult> {
        if (message.tags?.category === ALERT) throw new Error("provider down");
        return super.send(message);
      }
    }
    const mailer = new FailingAlertMailer();
    app = await createTestApp({ mailer });
    const { admin, auth } = await adminAuth(app);
    const created = await createInvite(app, auth, { sendEmail: false });

    const response = await accept(app, created.token, "sigue@familia.mx");

    expect(response.statusCode).toBe(201);
    expect(await alertsTo(mailer, admin)).toHaveLength(0);
    const [row] = await getTestDb().select().from(invites).where(eq(invites.id, created.inviteId));
    expect(row?.useCount).toBe(1);
  });

  it("skips the alert once today's invite-alert cap is reached, and records it", async () => {
    const mailer = new FakeMailer();
    app = await createTestApp({ mailer });
    const { admin, auth } = await adminAuth(app);
    await getTestDb()
      .insert(auditLogs)
      .values({
        actorUserId: null,
        action: "invite.accepted",
        entityType: "invite",
        metadata: { [INVITE_ALERT_METADATA_KEY]: INVITE_ALERT_DAILY_CAP }
      });
    const created = await createInvite(app, auth, { sendEmail: false });

    expect((await accept(app, created.token, "tope@familia.mx")).statusCode).toBe(201);

    expect(await alertsTo(mailer, admin)).toHaveLength(0);
    const [accepted] = await getTestDb()
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "invite.accepted"), eq(auditLogs.entityId, created.inviteId)));
    expect(accepted?.metadata).toMatchObject({ [INVITE_ALERT_METADATA_KEY]: 0, inviteAlertSkipped: true });
  });
});
