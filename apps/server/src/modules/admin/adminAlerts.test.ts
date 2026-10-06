import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { FakeMailer, type SentMail } from "../../../test/helpers/fakes.js";
import { createMember, type Member } from "../../../test/helpers/media.js";
import type { App } from "../../app.js";
import { auditLogs, invites } from "../../db/schema/index.js";
import { GLOBAL_DAILY_MAIL_CAP, MailTier, RESERVED_DAILY_MAIL_EXTRA, withinGlobalMailCap } from "../auth/mailBudget.js";
import { mailQueue } from "../auth/mailQueue.js";
import { ADMIN_ALERT_DAILY_CAP } from "./adminAlerts.js";

const CHANGED = "admin-account-changed";
const LIMIT = "admin-alert-limit";

let app: App;
let mailer: FakeMailer;
let actor: Member;
let watcher: Member;
let member: Member;

beforeEach(async () => {
  mailer = new FakeMailer();
  app = await createTestApp({ mailer });
  actor = await createMember({ role: "admin", displayName: "Admin Uno" });
  watcher = await createMember({ role: "admin", displayName: "Tía Lupita" });
  member = await createMember({ displayName: "Prima Ana" });
});

afterEach(async () => {
  await app.close();
});

async function mailsTo(user: Member, category: string): Promise<SentMail[]> {
  await mailQueue(app).onIdle();
  return mailer.outbox.filter((mail) => mail.to === user.user.email && mail.tags?.category === category);
}

async function patch(target: Member, payload: Record<string, unknown>): Promise<number> {
  const response = await app.inject({ method: "PATCH", url: `/api/admin/users/${target.user.id}`, payload, ...actor.auth });
  return response.statusCode;
}

async function forceReset(target: Member): Promise<number> {
  const response = await app.inject({
    method: "POST",
    url: `/api/admin/users/${target.user.id}/force-password-reset`,
    ...actor.auth
  });
  return response.statusCode;
}

/** Pretend today's alert emails already reached the cap. */
async function exhaustAlertCap(): Promise<void> {
  await getTestDb()
    .insert(auditLogs)
    .values({ actorUserId: null, action: "user.updated", entityType: "user", metadata: { adminAlertRecipients: ADMIN_ALERT_DAILY_CAP } });
}

describe("admin-account change alerts", () => {
  it("tells the other admins and the target, never the actor or members, when an admin is demoted and disabled", async () => {
    const target = await createMember({ role: "admin", displayName: "Tío Juan" });
    await createMember({ role: "admin", status: "disabled", email: "old-admin@example.test" });

    expect(await patch(target, { role: "member", status: "disabled" })).toBe(200);

    const [toWatcher] = await mailsTo(watcher, CHANGED);
    expect(toWatcher?.subject).toBe("Cambio en una cuenta de administrador");
    expect(toWatcher?.text).toContain("¡Hola, Tía Lupita!");
    expect(toWatcher?.text).toContain("Admin Uno hizo este cambio en la cuenta de Tío Juan");
    expect(toWatcher?.text).toContain("Le quitó el rol de administrador.");
    expect(toWatcher?.text).toContain("Desactivó la cuenta.");
    expect(toWatcher?.text).toContain("http://localhost:5173/admin/bitacora");
    expect(toWatcher?.text).not.toContain(actor.user.email);
    expect(toWatcher?.text).not.toContain(target.user.email);

    const toTarget = await mailsTo(target, CHANGED);
    expect(toTarget).toHaveLength(1);
    expect(toTarget[0]?.text).toContain("Admin Uno hizo este cambio en tu cuenta");
    expect(toTarget[0]?.text).not.toContain("/admin/bitacora");

    expect(await mailsTo(actor, CHANGED)).toHaveLength(0);
    expect(await mailsTo(member, CHANGED)).toHaveLength(0);
    expect(mailer.outbox.filter((mail) => mail.to === "old-admin@example.test")).toHaveLength(0);

    const [audit] = await getTestDb().select().from(auditLogs).where(eq(auditLogs.entityId, target.user.id));
    expect(audit?.metadata).toMatchObject({ adminAlertRecipients: 2, adminAlertExempt: true });
  });

  it("tells the target admin about a forced reset, alongside the reset email", async () => {
    const target = await createMember({ role: "admin" });
    expect(await forceReset(target)).toBe(200);
    expect(await mailsTo(watcher, CHANGED)).toHaveLength(1);
    const toTarget = await mailsTo(target, CHANGED);
    expect(toTarget).toHaveLength(1);
    expect(toTarget[0]?.text).toContain("Forzó el restablecimiento de la contraseña");
    expect(toTarget[0]?.text).toContain("tu cuenta");
    expect(await mailsTo(target, "password-reset")).toHaveLength(1);
  });

  it("sends nothing for member-only changes", async () => {
    expect(await patch(member, { mustChangePassword: true })).toBe(200);
    expect(await forceReset(member)).toBe(200);
    expect(await patch(member, { status: "disabled" })).toBe(200);
    await mailQueue(app).onIdle();
    expect(mailer.outbox.filter((mail) => mail.tags?.category === CHANGED)).toHaveLength(0);
  });

  it("still alerts on a demotion after invites exhausted the global daily mail cap", async () => {
    const target = await createMember({ role: "admin" });
    const now = new Date();
    const count = GLOBAL_DAILY_MAIL_CAP + RESERVED_DAILY_MAIL_EXTRA;
    await getTestDb()
      .insert(invites)
      .values(
        Array.from({ length: count }, (_, index) => ({
          tokenHash: `t8be-cap-${index}`,
          email: `invitado-${index}@example.test`,
          expiresAt: new Date(now.getTime() + 86_400_000),
          lastSentAt: now
        }))
      );
    expect(await withinGlobalMailCap(app, getTestDb(), MailTier.Reserved, now)).toBe(false);

    expect(await patch(target, { role: "member" })).toBe(200);
    expect(await mailsTo(watcher, CHANGED)).toHaveLength(1);
    expect(await mailsTo(target, CHANGED)).toHaveLength(1);
  });

  it("sends demote, disable and force-reset alerts past the alert cap", async () => {
    const demoted = await createMember({ role: "admin" });
    const disabled = await createMember({ role: "admin" });
    const reset = await createMember({ role: "admin" });
    await exhaustAlertCap();

    expect(await patch(demoted, { role: "member" })).toBe(200);
    expect(await patch(disabled, { status: "disabled" })).toBe(200);
    expect(await forceReset(reset)).toBe(200);

    expect(await mailsTo(watcher, CHANGED)).toHaveLength(3);
    expect(await mailsTo(watcher, LIMIT)).toHaveLength(0);
    for (const target of [demoted, disabled, reset]) {
      const own = (await mailsTo(target, CHANGED)).filter((mail) => mail.text.includes("en tu cuenta"));
      expect(own).toHaveLength(1);
    }
  });

  it("treats a force-reset as cap-exempt only when it flips must_change_password false to true", async () => {
    const target = await createMember({ role: "admin" });
    await exhaustAlertCap();

    expect(await forceReset(target)).toBe(200);
    expect(await mailsTo(watcher, CHANGED)).toHaveLength(1);
    // Repeat on an already-forced account: not exempt, so past the cap it becomes the limit notice.
    expect(await forceReset(target)).toBe(200);
    expect(await mailsTo(watcher, CHANGED)).toHaveLength(1);
    expect(await mailsTo(watcher, LIMIT)).toHaveLength(1);

    const rows = await getTestDb().select().from(auditLogs).where(eq(auditLogs.entityId, target.user.id));
    const metadata = rows.map((row) => row.metadata);
    expect(metadata.filter((entry) => entry.adminAlertExempt === true)).toHaveLength(1);
    expect(metadata.filter((entry) => entry.adminAlertLimitNotice === true)).toHaveLength(1);
  });

  it("replaces capped alerts with one daily limit notice, then skips them", async () => {
    const promoted = await createMember();
    const other = await createMember({ role: "admin" });
    await exhaustAlertCap();

    expect(await patch(promoted, { role: "admin" })).toBe(200);
    const limit = await mailsTo(watcher, LIMIT);
    expect(limit).toHaveLength(1);
    expect(limit[0]?.subject).toBe("Se alcanzó el límite de avisos de seguridad de hoy");
    expect(await mailsTo(other, LIMIT)).toHaveLength(1);
    expect(await mailsTo(promoted, LIMIT)).toHaveLength(1);
    expect(await mailsTo(actor, LIMIT)).toHaveLength(0);
    expect(await mailsTo(watcher, CHANGED)).toHaveLength(0);

    expect(await patch(other, { mustChangePassword: true })).toBe(200);
    expect(await patch(promoted, { status: "disabled" })).toBe(200);
    expect(await mailsTo(watcher, LIMIT)).toHaveLength(1);
    // The disable is exempt: it still goes out after the limit notice.
    expect(await mailsTo(watcher, CHANGED)).toHaveLength(1);

    const rows = await getTestDb().select().from(auditLogs);
    const metadata = rows.map((row) => row.metadata);
    expect(metadata.filter((entry) => entry.adminAlertLimitNotice === true)).toHaveLength(1);
    expect(metadata).toContainEqual(expect.objectContaining({ fields: ["mustChangePassword"], adminAlertRecipients: 0, adminAlertSkipped: true }));
  });
});
