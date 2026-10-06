/**
 * Admin-account change alerts [SEC] (Security L1, PR #24; follow-up L3).
 * When an administrator account changes (role, status, forced password
 * change/reset), every **other** active administrator gets an
 * "admin-account-changed" email, so one rogue or compromised admin cannot
 * quietly remove the others.
 *
 * - **Who:** every active admin except the actor. The changed account itself
 *   is told too (the "tu cuenta" variant) when it is demoted, disabled or
 *   force-reset (it is the one most likely to act, even after losing admin),
 *   or when it is still an active admin after the change.
 * - **Limits:** security notices skip T1's per-recipient budget **and** the
 *   global daily mail cap; they are bounded only by their own daily cap
 *   ({@link ADMIN_ALERT_DAILY_CAP}, counted from the audit rows'
 *   `adminAlertRecipients`), by the number of admins, and by the 60/min
 *   per-admin mutation limit.
 * - **Exempt:** demote, disable and force-reset of an admin always alert,
 *   even past the cap ({@link CAP_EXEMPT_CHANGES}); they still add to the count.
 *   A force-reset is exempt only when it actually flips `must_change_password`
 *   from false to true (the caller passes `capExempt: false` for repeats), so
 *   repeating it cannot burn through the alert quota for free.
 * - **Limit notice:** the first non-exempt alert of the day that no longer
 *   fits is replaced by ONE "Se alcanzó el límite de avisos de seguridad de
 *   hoy" email to every other active admin; later non-exempt alerts that day
 *   are skipped (and the audit row says so).
 * - Decided inside the mutation's transaction (which holds the admin-users
 *   lock, so the daily counts cannot be raced); queued after commit on T1's
 *   mail queue (`sendInBackground`). Names only, never addresses or secrets.
 */
import { AdminAccountChange } from "@cuencada/emails";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { auditLogs, users } from "../../db/schema/index.js";
import type { Transaction } from "../../lib/audit.js";
import { appLink, sendTemplate } from "../../lib/mailer/index.js";
import { sendInBackground } from "../auth/emailTokens.js";

/** Non-exempt alert emails per UTC day (future config). */
export const ADMIN_ALERT_DAILY_CAP = 100;
/** SPA path of the audit log viewer. */
export const AUDIT_LOG_PATH = "/admin/bitacora";

/** Audit metadata key holding how many alert emails a change queued. */
export const ADMIN_ALERT_METADATA_KEY = "adminAlertRecipients";
/** Audit metadata key marking the day's single "limit reached" notice. */
export const ADMIN_ALERT_LIMIT_KEY = "adminAlertLimitNotice";

/** Changes that remove admin access or lock an admin out: always announced. */
export const CAP_EXEMPT_CHANGES: ReadonlySet<AdminAccountChange> = new Set<AdminAccountChange>([
  AdminAccountChange.Demoted,
  AdminAccountChange.Disabled,
  AdminAccountChange.PasswordResetForced
]);

/** Someone to notify. */
interface AlertRecipient {
  id: string;
  email: string;
  displayName: string;
}

/** The changed account. */
export interface AlertTarget {
  id: string;
  email: string;
  displayName: string;
}

/** What {@link planAdminAlert} decides (inside the transaction). */
export type AdminAlertPlan =
  /** Send the change alert to `recipients` (other admins) and, if set, the "tu cuenta" variant to `target`. */
  | { kind: "change"; recipients: AlertRecipient[]; target: AlertRecipient | null; exempt: boolean }
  /** The cap is reached: send the day's single limit notice to `recipients` instead. */
  | { kind: "limit"; recipients: AlertRecipient[] }
  /** The cap is reached and the limit notice already went out today. */
  | { kind: "skipped" };

/** Inputs of {@link planAdminAlert}. */
export interface PlanAdminAlertInput {
  actorId: string;
  target: AlertTarget;
  changes: readonly AdminAccountChange[];
  now: Date;
  /**
   * `false` withdraws the cap exemption that {@link CAP_EXEMPT_CHANGES}
   * would grant (e.g. a repeated force-reset). Omitted: decided by `changes`.
   */
  capExempt?: boolean;
}

/** What to tell the admins (after commit). */
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

/** Alert emails counted today, and whether today's limit notice already went out. */
async function alertUsageToday(tx: Transaction, now: Date): Promise<{ sent: number; limitNoticeSent: boolean }> {
  const [row] = await tx
    .select({
      sent: sql<number>`coalesce(sum((${auditLogs.metadata} ->> ${ADMIN_ALERT_METADATA_KEY})::int), 0)::int`,
      limitNoticeSent: sql<boolean>`coalesce(bool_or(${auditLogs.metadata} ? ${ADMIN_ALERT_LIMIT_KEY}), false)`
    })
    .from(auditLogs)
    .where(
      and(
        sql`${auditLogs.createdAt} >= ${utcDayStart(now)}::timestamptz`,
        sql`${auditLogs.metadata} ? ${ADMIN_ALERT_METADATA_KEY}`
      )
    );
  return { sent: row?.sent ?? 0, limitNoticeSent: row?.limitNoticeSent ?? false };
}

/**
 * Plan the alert for a **new administrator account** created by accepting an
 * admin-role invite (WP-2.3b, Security P1). Every other active admin gets the
 * "promoted" variant of the admin-account-changed notice (the inviter is the
 * actor). Cap-exempt, like the other changes that alter who holds admin
 * access: a new admin must always be announced; it still adds to the count.
 * The new admin is not told (they just accepted it themselves).
 *
 * Call inside the accept transaction, after the user is inserted and before
 * `recordAudit` (whose metadata records {@link adminAlertMetadata}).
 *
 * @param tx - The accept transaction.
 * @param newAdminId - The account just created.
 */
export async function planNewAdminAlert(tx: Transaction, newAdminId: string): Promise<AdminAlertPlan> {
  const recipients: AlertRecipient[] = await tx
    .select({ id: users.id, email: users.email, displayName: users.displayName })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.status, "active"), sql`${users.id} <> ${newAdminId}::uuid`));
  return { kind: "change", recipients, target: null, exempt: true };
}

/**
 * Decide who to notify about a change to an administrator account. Call
 * inside the mutation's transaction, after the change is written (so the
 * active-admin set reflects it) and before `recordAudit`.
 *
 * @param app - The app (log).
 * @param tx - The mutation's transaction (holding the admin-users lock).
 * @param input - Actor, target, changes and time.
 */
export async function planAdminAlert(
  app: Pick<FastifyInstance, "log">,
  tx: Transaction,
  input: PlanAdminAlertInput
): Promise<AdminAlertPlan> {
  const activeAdmins: AlertRecipient[] = await tx
    .select({ id: users.id, email: users.email, displayName: users.displayName })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.status, "active"), sql`${users.id} <> ${input.actorId}::uuid`));
  // The target is filtered out of the "other admins" list on purpose: it gets
  // its own "tu cuenta" copy (`recipientIsTarget`) via `target` below, never
  // the third-person one, and never twice. `targetStillAdmin` is read from
  // the same post-change query, so a demoted/disabled target is not in it.
  const others = activeAdmins.filter((admin) => admin.id !== input.target.id);
  const targetStillAdmin = activeAdmins.length !== others.length;
  const exempt = input.capExempt !== false && input.changes.some((change) => CAP_EXEMPT_CHANGES.has(change));
  const target = exempt || targetStillAdmin ? input.target : null;
  if (exempt) return { kind: "change", recipients: others, target, exempt };

  const wanted = others.length + (target === null ? 0 : 1);
  if (wanted === 0) return { kind: "change", recipients: [], target: null, exempt };
  const usage = await alertUsageToday(tx, input.now);
  if (usage.sent + wanted <= ADMIN_ALERT_DAILY_CAP) return { kind: "change", recipients: others, target, exempt };

  app.log.warn({ event: "mail.admin_alert_cap_reached", sentToday: usage.sent, cap: ADMIN_ALERT_DAILY_CAP }, "admin alert capped");
  if (usage.limitNoticeSent) return { kind: "skipped" };
  // The limit notice goes to the other admins; a still-admin target is one of them.
  return { kind: "limit", recipients: target === null ? others : [...others, target] };
}

/**
 * Audit metadata describing the alert (counts and flags only).
 *
 * @param plan - Result of {@link planAdminAlert}.
 */
export function adminAlertMetadata(plan: AdminAlertPlan): Record<string, unknown> {
  switch (plan.kind) {
    case "change": {
      const count = plan.recipients.length + (plan.target === null ? 0 : 1);
      return plan.exempt ? { [ADMIN_ALERT_METADATA_KEY]: count, adminAlertExempt: true } : { [ADMIN_ALERT_METADATA_KEY]: count };
    }
    case "limit":
      return { [ADMIN_ALERT_METADATA_KEY]: plan.recipients.length, [ADMIN_ALERT_LIMIT_KEY]: true, adminAlertSkipped: true };
    case "skipped":
      return { [ADMIN_ALERT_METADATA_KEY]: 0, adminAlertSkipped: true };
  }
}

/**
 * Queue the alert emails. Call after the transaction committed.
 *
 * @param app - The app (mailer, config, jobs, log).
 * @param plan - Result of {@link planAdminAlert}.
 * @param alert - Who changed whom, what and when.
 */
export function queueAdminAlerts(app: FastifyInstance, plan: AdminAlertPlan, alert: AdminAlert): void {
  if (plan.kind === "skipped") return;
  const auditLogUrl = appLink(app.config, AUDIT_LOG_PATH);
  if (plan.kind === "limit") {
    for (const recipient of plan.recipients) {
      sendInBackground(app, "mail.admin-alert-limit", () =>
        sendTemplate(
          app,
          recipient.email,
          { kind: "admin-alert-limit", props: { recipientName: recipient.displayName, reachedAt: alert.changedAt, auditLogUrl } },
          { idempotencyKey: `admin-alert-limit:${alert.auditId}:${recipient.id}` }
        )
      );
    }
    return;
  }
  const notify = (recipient: AlertRecipient, recipientIsTarget: boolean): void => {
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
            auditLogUrl,
            recipientIsTarget
          }
        },
        { idempotencyKey: `admin-account-changed:${alert.auditId}:${recipient.id}` }
      )
    );
  };
  for (const recipient of plan.recipients) notify(recipient, false);
  if (plan.target !== null) notify(plan.target, true);
}
