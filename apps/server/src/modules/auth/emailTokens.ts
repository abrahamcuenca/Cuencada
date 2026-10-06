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
import type { Transaction } from "../../lib/audit.js";
import { createOpaqueToken, hashToken } from "../../lib/tokens.js";

/** Lifetimes per purpose, in minutes. */
export const EMAIL_TOKEN_TTL_MINUTES = {
  login: 15,
  password_reset: 30,
  email_verify: 24 * 60
} as const satisfies Record<MagicLinkPurpose, number>;

/** Audit actions written by the auth module (`entity.verb_past`). */
export const AuthAuditAction = {
  LoggedIn: "auth.logged_in",
  LoginFailed: "auth.login_failed",
  LoggedOut: "auth.logged_out",
  SessionRevoked: "auth.session_revoked",
  SessionsRevoked: "auth.sessions_revoked",
  RefreshReuseDetected: AuditAction.RefreshReuseDetected,
  PasswordChanged: AuditAction.PasswordChanged,
  PasswordReset: AuditAction.PasswordReset,
  PasswordResetRequested: "auth.password_reset_requested",
  MagicLinkRequested: "auth.magic_link_requested",
  EmailVerificationRequested: "auth.email_verification_requested",
  EmailVerified: "auth.email_verified"
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
      expiresAt
    })
    .returning({ id: magicLinks.id });
  if (!row) throw new Error("createEmailToken: insert returned no row");
  return { id: row.id, token, expiresAt };
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
 * concurrent consumes cannot both succeed.
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
 * Run a mail send off the request path, on the app's serial job queue, so
 * request-for-token endpoints answer in the same time whether or not an email
 * goes out (no account enumeration by timing). Failures are logged by the
 * queue (never with the body or token).
 *
 * @param app - Needs `jobs`.
 * @param name - Job label for logs (no PII, no token).
 * @param send - The send.
 */
export function sendInBackground(app: Pick<FastifyInstance, "jobs">, name: string, send: () => Promise<unknown>): void {
  app.jobs.enqueue(name, async () => {
    await send();
  });
}
