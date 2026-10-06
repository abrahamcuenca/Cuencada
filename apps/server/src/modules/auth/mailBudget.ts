/**
 * Email budgets [SEC] against mail-bombing and provider-quota exhaustion
 * (Security M1, PR #14). Everything is counted from database rows, so the
 * budgets survive restarts and hold across processes:
 *
 * - **Per recipient**, shared by every user-triggered email (magic link,
 *   password reset, email verification), counted from `magic_links` rows by
 *   address: at most one per purpose per 2 minutes, 3 per hour and 10 per
 *   24 hours. Over budget, no token is created and nothing is sent, but the
 *   route still answers its generic 202 (no enumeration).
 * - **Global per UTC day:** today's `magic_links` rows + invites sent today
 *   (`invites.last_sent_at`) + password-changed notices (their audit rows).
 *   User-triggered emails stop at {@link GLOBAL_DAILY_MAIL_CAP}; admin invites
 *   and password-changed notices keep a reserve of
 *   {@link RESERVED_DAILY_MAIL_EXTRA} on top. Reaching a cap logs
 *   `mail.cap_reached` once per day.
 *
 * The constants are exported; they are candidates for config once
 * `config.ts` is unfrozen.
 */
import { AuditAction } from "@cuencada/types";
import { and, eq, gt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { type MagicLinkPurpose, magicLinks } from "../../db/schema/index.js";
import type { DbOrTx, Transaction } from "../../lib/audit.js";
import { warnCapReachedOnce } from "./mailQueue.js";

/** Per-recipient limits for user-triggered emails (future config). */
export const RECIPIENT_MAIL_BUDGET = {
  /** At most one email of the same purpose per this interval. */
  samePurposeIntervalMs: 2 * 60_000,
  perHour: 3,
  perDay: 10
} as const;

/** User-triggered emails per UTC day across all recipients (future config). */
export const GLOBAL_DAILY_MAIL_CAP = 300;
/** Extra daily room kept for admin invites and password-changed notices (future config). */
export const RESERVED_DAILY_MAIL_EXTRA = 100;

/** Who may still send once the user-triggered cap is reached. */
export const MailTier = {
  /** Magic link, password reset, email verification. */
  User: "user",
  /** Admin invites and password-changed security notices. */
  Reserved: "reserved"
} as const;
export type MailTier = (typeof MailTier)[keyof typeof MailTier];

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Emails sent (or reserved) so far in the current UTC day, across every kind.
 *
 * @param db - Client or transaction.
 * @param now - Current time (`app.clock`).
 */
export async function dailyMailCount(db: DbOrTx, now: Date): Promise<number> {
  const dayStart = utcDayStart(now).toISOString();
  const notices = [AuditAction.PasswordChanged, AuditAction.PasswordReset];
  const result = await db.execute<{ total: number }>(sql`
    select
      (select count(*) from magic_links where created_at >= ${dayStart}::timestamptz)::int
      + (select count(*) from invites where last_sent_at >= ${dayStart}::timestamptz)::int
      + (select count(*) from audit_logs
           where action in (${sql.join(notices.map((action) => sql`${action}`), sql`, `)})
             and created_at >= ${dayStart}::timestamptz)::int
      as total
  `);
  const total = result[0]?.total;
  if (typeof total !== "number") throw new Error("dailyMailCount: unexpected result");
  return total;
}

/**
 * Whether one more email of `tier` fits under today's global cap. Logs
 * `mail.cap_reached` once per day when it does not.
 *
 * @param app - The app (db, log, jobs for the once-per-day state).
 * @param db - Client or transaction to count with.
 * @param tier - User-triggered or reserved.
 * @param now - Current time.
 */
export async function withinGlobalMailCap(
  app: Pick<FastifyInstance, "jobs" | "log">,
  db: DbOrTx,
  tier: MailTier,
  now: Date
): Promise<boolean> {
  const cap = tier === MailTier.User ? GLOBAL_DAILY_MAIL_CAP : GLOBAL_DAILY_MAIL_CAP + RESERVED_DAILY_MAIL_EXTRA;
  const count = await dailyMailCount(db, now);
  if (count < cap) return true;
  warnCapReachedOnce(app, utcDayStart(now).toISOString().slice(0, 10), { tier, count, cap });
  return false;
}

/**
 * Whether `email` may receive one more user-triggered email of `purpose`.
 * Takes a transaction-scoped advisory lock on the address, so concurrent
 * requests for one recipient are counted one after another.
 *
 * @param tx - Open transaction (the token insert must follow in it).
 * @param email - Normalized (lowercase) address.
 * @param purpose - What the email is for.
 * @param now - Current time.
 */
export async function withinRecipientBudget(
  tx: Transaction,
  email: string,
  purpose: MagicLinkPurpose,
  now: Date
): Promise<boolean> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`mail-budget:${email}`}))`);
  const hourAgo = new Date(now.getTime() - HOUR_MS).toISOString();
  const samePurposeSince = new Date(now.getTime() - RECIPIENT_MAIL_BUDGET.samePurposeIntervalMs).toISOString();
  const [row] = await tx
    .select({
      day: sql<number>`count(*)::int`,
      hour: sql<number>`(count(*) filter (where ${magicLinks.createdAt} > ${hourAgo}::timestamptz))::int`,
      samePurpose: sql<number>`(count(*) filter (where ${magicLinks.purpose} = ${purpose} and ${magicLinks.createdAt} > ${samePurposeSince}::timestamptz))::int`
    })
    .from(magicLinks)
    .where(and(eq(magicLinks.email, email), gt(magicLinks.createdAt, new Date(now.getTime() - DAY_MS))));
  if (row === undefined) return true;
  return (
    row.samePurpose === 0 && row.hour < RECIPIENT_MAIL_BUDGET.perHour && row.day < RECIPIENT_MAIL_BUDGET.perDay
  );
}
