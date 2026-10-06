/**
 * Admin-account change alerts [SEC] (Security L1, PR #24). When an
 * administrator account's role or status changes, or an administrator is
 * forced to reset their password, every **other** active administrator gets
 * an "admin-account-changed" email, so one rogue or compromised admin cannot
 * quietly remove the others.
 *
 * - Recipients and caps are decided inside the mutation's transaction (which
 *   holds the admin-users lock, so the daily count cannot be raced); the
 *   emails are queued after commit on T1's mail queue (`sendInBackground`).
 * - Security notices skip the per-recipient budget. They use the reserved
 *   tier of the global daily cap (like the password-changed notice) plus a
 *   dedicated daily cap ({@link ADMIN_ALERT_DAILY_CAP}) counted from the audit
 *   rows' `adminAlertRecipients`.
 * - Emails carry names only (no addresses, no secrets) and link to the audit log.
 */
import type { AdminAccountChange } from "@cuencada/emails";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { auditLogs, users } from "../../db/schema/index.js";
import type { Transaction } from "../../lib/audit.js";
import { appLink, sendTemplate } from "../../lib/mailer/index.js";
import { sendInBackground } from "../auth/emailTokens.js";
import { MailTier, withinGlobalMailCap } from "../auth/mailBudget.js";

/** Alert emails per UTC day across all admin-account changes (future config). */
export const ADMIN_ALERT_DAILY_CAP = 100;
/** SPA path of the audit log viewer. */
export const AUDIT_LOG_PATH = "/admin/bitacora";

/** Audit metadata key holding how many alert emails a change queued. */
export const ADMIN_ALERT_METADATA_KEY = "adminAlertRecipients";

/** One administrator to notify. */
interface AlertRecipient {
  id: string;
  email: string;
  displayName: string;
}

/** Who will be notified about one change (decided in the transaction). */
export interface AdminAlertPlan {
  recipients: AlertRecipient[];
  /** `true` when a cap stopped the alert (recorded in the audit row). */
  skipped: boolean;
}

/** What to tell the other admins. */
export interface AdminAlert {
  auditId: string;
  actorName: string;
  targetName: string;
  changes: readonly AdminAccountChange[];
  changedAt: Date;
}

function utcDayStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

/**
 * Decide who to notify: every active admin except the actor, if today's
 * alert cap and the global reserved cap allow it. Call inside the mutation's
 * transaction, after the change is written and before `recordAudit`.
 *
 * @param app - The app (log, jobs for the cap warning).
 * @param tx - The mutation's transaction (holding the admin-users lock).
 * @param actorId - The acting admin (never notified about their own action).
 * @param now - Current time.
 */
export async function planAdminAlert(
  app: Pick<FastifyInstance, "jobs" | "log">,
  tx: Transaction,
  actorId: string,
  now: Date
): Promise<AdminAlertPlan> {
  const recipients = await tx
    .select({ id: users.id, email: users.email, displayName: users.displayName })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.status, "active"), sql`${users.id} <> ${actorId}::uuid`));
  if (recipients.length === 0) return { recipients, skipped: false };

  const [row] = await tx
    .select({
      sent: sql<number>`coalesce(sum((${auditLogs.metadata} ->> ${ADMIN_ALERT_METADATA_KEY})::int), 0)::int`
    })
    .from(auditLogs)
    .where(
      and(
        sql`${auditLogs.createdAt} >= ${utcDayStart(now)}::timestamptz`,
        sql`${auditLogs.metadata} ? ${ADMIN_ALERT_METADATA_KEY}`
      )
    );
  const sentToday = row?.sent ?? 0;
  if (sentToday + recipients.length > ADMIN_ALERT_DAILY_CAP) {
    app.log.warn({ event: "mail.admin_alert_cap_reached", sentToday, cap: ADMIN_ALERT_DAILY_CAP }, "admin alert skipped");
    return { recipients: [], skipped: true };
  }
  if (!(await withinGlobalMailCap(app, tx, MailTier.Reserved, now))) return { recipients: [], skipped: true };
  return { recipients, skipped: false };
}

/**
 * Audit metadata describing the alert (counts only).
 *
 * @param plan - Result of {@link planAdminAlert}.
 */
export function adminAlertMetadata(plan: AdminAlertPlan): Record<string, unknown> {
  return plan.skipped ? { [ADMIN_ALERT_METADATA_KEY]: 0, adminAlertSkipped: true } : { [ADMIN_ALERT_METADATA_KEY]: plan.recipients.length };
}

/**
 * Queue the alert emails. Call after the transaction committed.
 *
 * @param app - The app (mailer, config, jobs, log).
 * @param plan - Recipients from {@link planAdminAlert}.
 * @param alert - Who changed whom, what and when.
 */
export function queueAdminAlerts(app: FastifyInstance, plan: AdminAlertPlan, alert: AdminAlert): void {
  const auditLogUrl = appLink(app.config, AUDIT_LOG_PATH);
  for (const recipient of plan.recipients) {
    sendInBackground(app, "mail.admin-account-changed", () =>
      sendTemplate(
        app,
        recipient.email,
        {
          kind: "admin-account-changed",
          props: {
            recipientName: recipient.displayName,
            actorName: alert.actorName,
            targetName: alert.targetName,
            changes: alert.changes,
            changedAt: alert.changedAt,
            auditLogUrl
          }
        },
        { idempotencyKey: `admin-account-changed:${alert.auditId}:${recipient.id}` }
      )
    );
  }
}
