/**
 * Open-invite acceptance alerts [SEC] (WP-2.3b owner decision). Verifying an
 * email proves mailbox ownership, not family membership, so a leaked open
 * (not email-bound) invite link could let a stranger join. Every acceptance
 * of an open invite therefore emails every active admin an
 * "admin-invite-accepted" notice.
 *
 * - **Who:** every active admin. Email-bound invites do not alert: an admin
 *   chose that mailbox, the invite is single-use, and holding the token
 *   implies controlling the mailbox.
 * - **What:** the new member's display name, the invite's note (label) and
 *   short id, uses so far / allowed, and a link to the bitácora filtered to
 *   the acceptance. Names and ids only, never the new member's email address
 *   (same precedent as the admin-account alerts).
 * - **Limits:** like the admin-account alerts (T8-BE), these notices skip
 *   T1's per-recipient budget and are not counted by the global daily mail
 *   cap (`dailyMailCount`). They are bounded by their own daily cap
 *   ({@link INVITE_ALERT_DAILY_CAP}, counted from the `invite.accepted` audit
 *   rows' {@link INVITE_ALERT_METADATA_KEY}, under an advisory lock), by
 *   each open invite's 10-use / 72 h limit, and by the per-IP and per-token
 *   accept rate limits. The counter is separate from `adminAlertRecipients`
 *   on purpose: acceptances are triggered by whoever holds a link, and must
 *   not use up the quota that protects admin-account change alerts. Past the
 *   cap the alert is skipped, `mail.invite_alert_cap_reached` is logged and
 *   the audit row says `inviteAlertSkipped: true`.
 * - Planned inside the accept transaction; queued on T1's mail queue
 *   (`sendInBackground`) only after commit, so a rolled-back acceptance sends
 *   nothing and a mail failure never fails the acceptance.
 */
import { AuditAction } from "@cuencada/types";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { auditLogs, users } from "../../db/schema/index.js";
import type { Transaction } from "../../lib/audit.js";
import { appLink, sendTemplate } from "../../lib/mailer/index.js";
import { AUDIT_LOG_PATH } from "../admin/adminAlerts.js";
import { sendInBackground } from "../auth/emailTokens.js";

/** Open-invite acceptance alert emails per UTC day (future config). */
export const INVITE_ALERT_DAILY_CAP = 100;
/** Audit metadata key holding how many alert emails an acceptance queued. */
export const INVITE_ALERT_METADATA_KEY = "inviteAlertRecipients";
/** Characters of the invite id shown in the email. */
const SHORT_ID_LENGTH = 8;

/** An admin to notify. */
interface AlertRecipient {
  id: string;
  email: string;
  displayName: string;
}

/** What {@link planInviteAcceptedAlert} decides (inside the transaction). */
export type InviteAcceptedAlertPlan =
  | { kind: "send"; recipients: AlertRecipient[] }
  /** Today's cap is reached: nothing is sent. */
  | { kind: "skipped" };

/** What to tell the admins (after commit). */
export interface InviteAcceptedAlert {
  auditId: string;
  inviteId: string;
  inviteNote: string | null;
  memberUserId: string;
  memberName: string;
  useCount: number;
  maxUses: number;
  acceptedAt: Date;
}

function utcDayStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

/**
 * Decide who to notify about an open-invite acceptance. Call inside the
 * accept transaction, before `recordAudit` (whose metadata records the count).
 *
 * @param app - The app (log).
 * @param tx - The accept transaction.
 * @param now - Current time.
 */
export async function planInviteAcceptedAlert(
  app: Pick<FastifyInstance, "log">,
  tx: Transaction,
  now: Date
): Promise<InviteAcceptedAlertPlan> {
  // Serialize concurrent acceptances so the daily count cannot be raced.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('invite-accepted-alerts'))`);
  const recipients: AlertRecipient[] = await tx
    .select({ id: users.id, email: users.email, displayName: users.displayName })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.status, "active")));
  if (recipients.length === 0) return { kind: "send", recipients };

  const [row] = await tx
    .select({ sent: sql<number>`coalesce(sum((${auditLogs.metadata} ->> ${INVITE_ALERT_METADATA_KEY})::int), 0)::int` })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.action, AuditAction.InviteAccepted),
        sql`${auditLogs.createdAt} >= ${utcDayStart(now)}::timestamptz`,
        sql`${auditLogs.metadata} ? ${INVITE_ALERT_METADATA_KEY}`
      )
    );
  const sent = row?.sent ?? 0;
  if (sent + recipients.length <= INVITE_ALERT_DAILY_CAP) return { kind: "send", recipients };
  app.log.warn({ event: "mail.invite_alert_cap_reached", sentToday: sent, cap: INVITE_ALERT_DAILY_CAP }, "invite alert capped");
  return { kind: "skipped" };
}

/**
 * Audit metadata describing the alert (counts and flags only).
 *
 * @param plan - Result of {@link planInviteAcceptedAlert}.
 */
export function inviteAlertMetadata(plan: InviteAcceptedAlertPlan): Record<string, unknown> {
  return plan.kind === "send"
    ? { [INVITE_ALERT_METADATA_KEY]: plan.recipients.length }
    : { [INVITE_ALERT_METADATA_KEY]: 0, inviteAlertSkipped: true };
}

/**
 * Bitácora link showing this acceptance: action `invite.accepted` by the new
 * member (ids only, no names or addresses in the URL).
 *
 * @param app - The app (config).
 * @param memberUserId - The new account.
 */
export function inviteAcceptedReviewUrl(app: Pick<FastifyInstance, "config">, memberUserId: string): string {
  const query = new URLSearchParams({ accion: AuditAction.InviteAccepted, actor: memberUserId });
  return appLink(app.config, `${AUDIT_LOG_PATH}?${query.toString()}`);
}

/**
 * Queue one alert per recipient. Call after the transaction committed.
 *
 * @param app - The app (mailer, config, jobs, log).
 * @param plan - Result of {@link planInviteAcceptedAlert}.
 * @param alert - Who joined, with which invite, and when.
 */
export function queueInviteAcceptedAlerts(
  app: FastifyInstance,
  plan: InviteAcceptedAlertPlan,
  alert: InviteAcceptedAlert
): void {
  if (plan.kind === "skipped") return;
  const reviewUrl = inviteAcceptedReviewUrl(app, alert.memberUserId);
  const inviteShortId = alert.inviteId.replaceAll("-", "").slice(0, SHORT_ID_LENGTH);
  for (const recipient of plan.recipients) {
    sendInBackground(app, "mail.admin-invite-accepted", () =>
      sendTemplate(
        app,
        recipient.email,
        {
          kind: "admin-invite-accepted",
          props: {
            recipientName: recipient.displayName,
            memberName: alert.memberName,
            inviteLabel: alert.inviteNote,
            inviteShortId,
            useCount: alert.useCount,
            maxUses: alert.maxUses,
            acceptedAt: alert.acceptedAt,
            reviewUrl
          }
        },
        { idempotencyKey: `admin-invite-accepted:${alert.auditId}:${recipient.id}` }
      )
    );
  }
}
