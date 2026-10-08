/**
 * Single-use email tokens (magic-link login, password reset, email
 * verification) in `magic_links` [SEC]. Only the SHA-256 hash is stored; the
 * raw token goes into the emailed link's fragment and is consumed once, inside
 * a transaction that locks the row.
 */
import { AuditAction } from "@cuencada/types";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { type MagicLinkPurpose, magicLinks, users } from "../../db/schema/index.js";
import type { Database } from "../../db/client.js";
import type { DbOrTx, Transaction } from "../../lib/audit.js";
import { createOpaqueToken, hashToken } from "../../lib/tokens.js";
import { dailyMailCount, MailTier, withinGlobalMailCap, withinRecipientBudget } from "./mailBudget.js";
import { enqueueMail } from "./mailQueue.js";

/** Lifetimes per purpose, in minutes. */
export const EMAIL_TOKEN_TTL_MINUTES = {
  login: 15,
  password_reset: 30,
  email_verify: 24 * 60
} as const satisfies Record<MagicLinkPurpose, number>;

/** Audit actions written by the auth module (all from the contract's `AuditAction`). */
export const AuthAuditAction = {
  LoggedIn: AuditAction.LoggedIn,
  LoginFailed: AuditAction.LoginFailed,
  LoggedOut: AuditAction.LoggedOut,
  SessionRevoked: AuditAction.SessionRevoked,
  SessionsRevoked: AuditAction.SessionsRevoked,
  RefreshReuseDetected: AuditAction.RefreshReuseDetected,
  RefreshRace: AuditAction.RefreshRace,
  RefreshGraceReissued: AuditAction.RefreshGraceReissued,
  PasswordChanged: AuditAction.PasswordChanged,
  PasswordReset: AuditAction.PasswordReset,
  PasswordResetRequested: AuditAction.PasswordResetRequested,
  MagicLinkRequested: AuditAction.MagicLinkRequested,
  EmailVerificationRequested: AuditAction.EmailVerificationRequested,
  EmailVerified: AuditAction.EmailVerified
} as const;

/** A newly created email token. */
export interface CreatedEmailToken {
  /** `magic_links.id`; use it for idempotency keys, never the token. */
  id: string;
  /** Raw token for the link fragment; never stored or logged. */
  token: string;
  expiresAt: Date;
}

/** Input for {@link createEmailToken}. */
export interface CreateEmailTokenInput {
  userId: string;
  email: string;
  purpose: MagicLinkPurpose;
  requestIp: string;
  now: Date;
}

/**
 * Insert a single-use token row.
 *
 * @param tx - Open transaction.
 * @param input - Owner, purpose and request IP.
 */
export async function createEmailToken(tx: Transaction, input: CreateEmailTokenInput): Promise<CreatedEmailToken> {
  const token = createOpaqueToken();
  const expiresAt = new Date(input.now.getTime() + EMAIL_TOKEN_TTL_MINUTES[input.purpose] * 60_000);
  const [row] = await tx
    .insert(magicLinks)
    .values({
      userId: input.userId,
      email: input.email,
      tokenHash: hashToken(token),
      purpose: input.purpose,
      requestIp: input.requestIp,
      expiresAt,
      // App clock, not the DB's, so budget windows and tests agree on time.
      createdAt: input.now
    })
    .returning({ id: magicLinks.id });
  if (!row) throw new Error("createEmailToken: insert returned no row");
  return { id: row.id, token, expiresAt };
}

/**
 * Create a token for a user-triggered email **only if** the recipient's
 * budget and today's global cap allow it (Security M1). The one gate for
 * magic-link, password-reset and verify requests. When it returns `null` the
 * caller sends nothing and still answers its generic 202.
 *
 * @param app - The app (log, jobs).
 * @param tx - Open transaction.
 * @param input - Owner, address, purpose, IP, time.
 * @returns The token, or `null` when over budget.
 */
export async function issueBudgetedEmailToken(
  app: Pick<FastifyInstance, "jobs" | "log">,
  tx: Transaction,
  input: CreateEmailTokenInput
): Promise<CreatedEmailToken | null> {
  if (!(await withinRecipientBudget(tx, input.email, input.purpose, input.now))) {
    app.log.warn({ event: "mail.recipient_budget_exceeded", userId: input.userId, purpose: input.purpose }, "email skipped");
    return null;
  }
  if (!(await withinGlobalMailCap(app, tx, MailTier.User, input.now))) return null;
  return createEmailToken(tx, input);
}

/**
 * Timing decoy for request-for-token routes (Security L2 on PR #14): when
 * the address has no active account, run the same budget reads that
 * {@link issueBudgetedEmailToken} runs for a real one (advisory lock on the
 * address, per-recipient counts, today's global count) in a transaction that
 * writes nothing, so the response time does not reveal whether the address
 * belongs to an account. Behaviour is unchanged: no token, no audit row, no
 * email, no log line.
 *
 * Residual difference (documented, accepted): a real request also inserts
 * the token and its audit row (two small inserts in the same transaction)
 * and enqueues the email off the request path.
 *
 * @param db - The root client (`app.db`).
 * @param email - The normalized address from the request body.
 * @param purpose - The purpose the real path would budget.
 * @param now - Current time (`app.clock`).
 */
export async function simulateBudgetedEmailToken(
  db: Pick<Database, "transaction">,
  email: string,
  purpose: MagicLinkPurpose,
  now: Date
): Promise<void> {
  await db.transaction(async (tx) => {
    // Same order and statements as the real path; the results are ignored on purpose.
    await withinRecipientBudget(tx, email, purpose, now);
    await dailyMailCount(tx, now);
  });
}

/**
 * Burn every unused email token of a user, of every purpose (Security L3):
 * after a password change or reset, or when an admin disables the account,
 * no earlier login, reset or verify link may still work.
 *
 * @param tx - Open transaction.
 * @param userId - The user.
 * @param now - Time to record as `used_at`.
 * @returns How many tokens were burned.
 */
export async function burnPendingEmailTokens(tx: DbOrTx, userId: string, now: Date): Promise<number> {
  const rows = await tx
    .update(magicLinks)
    .set({ usedAt: now })
    .where(and(eq(magicLinks.userId, userId), isNull(magicLinks.usedAt)))
    .returning({ id: magicLinks.id });
  return rows.length;
}

/** The user a consumed token belongs to. */
export interface ConsumedEmailToken {
  tokenId: string;
  userId: string;
  /** The address the link was sent to. */
  email: string;
  /** The user's current address (may differ if it changed since). */
  userEmail: string;
}

/**
 * Consume a token: it must exist, have this purpose, be unused and unexpired,
 * and belong to an active user. Marks it used. The row is locked, so two
 * concurrent consumes cannot both succeed. A token presented for the wrong
 * purpose is rejected without being burned (harmless at 256 bits of entropy).
 *
 * @param tx - Open transaction.
 * @param rawToken - Token from the request body.
 * @param purpose - Expected purpose.
 * @param now - Current time.
 * @returns The owner, or `null` (one generic failure for every reason).
 */
export async function consumeEmailToken(
  tx: Transaction,
  rawToken: string,
  purpose: MagicLinkPurpose,
  now: Date
): Promise<ConsumedEmailToken | null> {
  const [row] = await tx
    .select({
      id: magicLinks.id,
      userId: magicLinks.userId,
      email: magicLinks.email,
      purpose: magicLinks.purpose,
      expiresAt: magicLinks.expiresAt,
      usedAt: magicLinks.usedAt
    })
    .from(magicLinks)
    .where(eq(magicLinks.tokenHash, hashToken(rawToken)))
    .limit(1)
    .for("update");
  if (row === undefined || row.userId === null || row.purpose !== purpose || row.usedAt !== null) return null;
  if (row.expiresAt <= now) return null;

  const [user] = await tx
    .select({ id: users.id, email: users.email, status: users.status })
    .from(users)
    .where(eq(users.id, row.userId))
    .limit(1);
  if (user === undefined || user.status !== "active") return null;

  await tx.update(magicLinks).set({ usedAt: now }).where(and(eq(magicLinks.id, row.id), isNull(magicLinks.usedAt)));
  return { tokenId: row.id, userId: user.id, email: row.email, userEmail: user.email };
}

/**
 * Mark the user's email verified after they followed a link sent to it, but
 * only if the link went to their **current** address (it may have changed
 * since the email was sent). Keeps an earlier verification time.
 *
 * @param tx - Open transaction.
 * @param consumed - Result of {@link consumeEmailToken}.
 * @param now - Verification time.
 * @returns `true` when the address now counts as verified because of this link.
 */
export async function markEmailVerified(tx: Transaction, consumed: ConsumedEmailToken, now: Date): Promise<boolean> {
  if (consumed.email.toLowerCase() !== consumed.userEmail.toLowerCase()) return false;
  await tx
    .update(users)
    .set({ emailVerifiedAt: now })
    .where(and(eq(users.id, consumed.userId), isNull(users.emailVerifiedAt)));
  return true;
}

/**
 * Run a mail send off the request path on the auth module's bounded, retrying
 * mail queue ({@link enqueueMail}), so request-for-token endpoints answer the
 * same way whether or not an email goes out (no account enumeration).
 *
 * @param app - Needs `jobs` (identifies the app's mail queue) and `log`.
 * @param name - Job label for logs (no PII, no token).
 * @param send - The send (with an idempotency key).
 */
export function sendInBackground(
  app: Pick<FastifyInstance, "jobs" | "log">,
  name: string,
  send: () => Promise<unknown>
): void {
  enqueueMail(app, name, send);
}
