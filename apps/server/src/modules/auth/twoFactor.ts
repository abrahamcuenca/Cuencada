/**
 * Two-step verification service (WP-7, ADR 0001 §9) [SEC]: the login gate
 * (challenge or trusted device), second-factor checks with replay prevention
 * and a row lock, recovery codes, trusted devices and the security notices.
 *
 * Nothing here logs or returns secrets, codes, otpauth URIs or tokens; audit
 * metadata holds ids, enums and counts only.
 */
import {
  RECOVERY_CODE_COUNT,
  TRUSTED_DEVICE_COOKIE,
  TRUSTED_DEVICE_COOKIE_INSECURE,
  TRUSTED_DEVICE_DAYS,
  TWO_FACTOR_CHALLENGE_TTL_MINUTES,
  TWO_FACTOR_MAX_ATTEMPTS,
  type TwoFactorChallenge,
  type UserRole
} from "@cuencada/types";
import type { TwoFactorNotice } from "@cuencada/emails";
import { and, count, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../../config.js";
import {
  type TwoFactorLoginMethod,
  trustedDevices,
  twoFactorChallenges,
  userRecoveryCodes,
  userTotp
} from "../../db/schema/index.js";
import type { DbOrTx, Transaction } from "../../lib/audit.js";
import { sendTemplate } from "../../lib/mailer/index.js";
import { createOpaqueToken, hashToken } from "../../lib/tokens.js";
import {
  createRecoveryCodes,
  decryptSecret,
  hashRecoveryCode,
  TotpDecryptionError,
  totpKey,
  verifyTotpCode
} from "../../lib/totp.js";
import { REFRESH_COOKIE_PATH } from "./cookies.js";
import { sendInBackground } from "./emailTokens.js";
import { MailTier, withinGlobalMailCap } from "./mailBudget.js";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Shape of a trusted-device token we issued (`createOpaqueToken`). */
const DEVICE_TOKEN_FORMAT = /^[A-Za-z0-9_-]{32,256}$/;

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

/** Whether `userId` has two-step verification enabled (not just a pending setup). */
export async function isTwoFactorEnabled(db: DbOrTx, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ enabledAt: userTotp.enabledAt })
    .from(userTotp)
    .where(eq(userTotp.userId, userId))
    .limit(1);
  return row?.enabledAt != null;
}

/** Unused recovery codes of a user. */
export async function remainingRecoveryCodes(db: DbOrTx, userId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(userRecoveryCodes)
    .where(and(eq(userRecoveryCodes.userId, userId), isNull(userRecoveryCodes.usedAt)));
  return row?.value ?? 0;
}

/* -------------------------------------------------------------------------- */
/* Trusted-device cookie                                                       */
/* -------------------------------------------------------------------------- */

type CookieConfig = Pick<AppConfig, "COOKIE_SECURE">;

/** Cookie name for this environment (`__Secure-` only when cookies are Secure). */
export function trustedDeviceCookieName(config: CookieConfig): string {
  return config.COOKIE_SECURE ? TRUSTED_DEVICE_COOKIE : TRUSTED_DEVICE_COOKIE_INSECURE;
}

function deviceCookieOptions(config: CookieConfig): { path: string; httpOnly: true; secure: boolean; sameSite: "strict" } {
  return { path: REFRESH_COOKIE_PATH, httpOnly: true, secure: config.COOKIE_SECURE, sameSite: "strict" };
}

/** The raw trusted-device token from the request, or `null` when missing or malformed. */
export function readTrustedDeviceCookie(request: FastifyRequest, config: CookieConfig): string | null {
  const value = request.cookies[trustedDeviceCookieName(config)];
  if (value === undefined || !DEVICE_TOKEN_FORMAT.test(value)) return null;
  return value;
}

/** Set the trusted-device cookie (HttpOnly, SameSite=Strict, Path=/api/auth) until `expiresAt`. */
export function setTrustedDeviceCookie(reply: FastifyReply, config: CookieConfig, token: string, expiresAt: Date, now: Date): void {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
  void reply.setCookie(trustedDeviceCookieName(config), token, { ...deviceCookieOptions(config), maxAge });
}

/** Expire the trusted-device cookie. */
export function clearTrustedDeviceCookie(reply: FastifyReply, config: CookieConfig): void {
  void reply.clearCookie(trustedDeviceCookieName(config), deviceCookieOptions(config));
}

/**
 * A coarse device label from a User-Agent ("iPhone · Safari"). The full
 * User-Agent is never stored for trusted devices.
 *
 * @param userAgent - The request's User-Agent header, if any.
 */
export function deviceLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  const device = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Macintosh|Mac OS X/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /CrOS/.test(ua)
              ? "Chromebook"
              : /Linux/.test(ua)
                ? "Linux"
                : "Dispositivo";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /SamsungBrowser/.test(ua)
      ? "Samsung Internet"
      : /Firefox\/|FxiOS/.test(ua)
        ? "Firefox"
        : /CriOS|Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "navegador";
  return `${device} · ${browser}`;
}

/**
 * The live trusted device behind `rawToken`, **for this user** (a cookie of
 * another account on the same browser never counts). Touches `last_used_at`.
 *
 * @returns The device id, or `null`.
 */
export async function useTrustedDevice(tx: Transaction, userId: string, rawToken: string, now: Date): Promise<string | null> {
  const [row] = await tx
    .update(trustedDevices)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(trustedDevices.tokenHash, hashToken(rawToken)),
        eq(trustedDevices.userId, userId),
        isNull(trustedDevices.revokedAt),
        gt(trustedDevices.expiresAt, now)
      )
    )
    .returning({ id: trustedDevices.id });
  return row?.id ?? null;
}

/** A newly trusted device. */
export interface CreatedTrustedDevice {
  id: string;
  /** Raw cookie token; only its hash is stored. */
  token: string;
  expiresAt: Date;
}

/** Trust this browser for {@link TRUSTED_DEVICE_DAYS} days (members only; the caller checks the role). */
export async function createTrustedDevice(
  tx: Transaction,
  userId: string,
  label: string,
  now: Date
): Promise<CreatedTrustedDevice> {
  const token = createOpaqueToken();
  const expiresAt = new Date(now.getTime() + TRUSTED_DEVICE_DAYS * DAY_MS);
  const [row] = await tx
    .insert(trustedDevices)
    .values({ userId, tokenHash: hashToken(token), userAgentLabel: label.slice(0, 80), createdAt: now, expiresAt, lastUsedAt: now })
    .returning({ id: trustedDevices.id });
  if (!row) throw new Error("createTrustedDevice: insert returned no row");
  return { id: row.id, token, expiresAt };
}

/**
 * Revoke a user's live trusted devices (all, or one).
 *
 * @returns Ids of the devices revoked by this call.
 */
export async function revokeTrustedDevices(tx: DbOrTx, userId: string, now: Date, deviceId?: string): Promise<string[]> {
  const conditions = [eq(trustedDevices.userId, userId), isNull(trustedDevices.revokedAt)];
  if (deviceId !== undefined) conditions.push(eq(trustedDevices.id, deviceId));
  const rows = await tx
    .update(trustedDevices)
    .set({ revokedAt: now })
    .where(and(...conditions))
    .returning({ id: trustedDevices.id });
  return rows.map((row) => row.id);
}

/* -------------------------------------------------------------------------- */
/* Login gate                                                                  */
/* -------------------------------------------------------------------------- */

/** What happens after a correct first factor. */
export type LoginGate =
  /** No 2FA: issue the session as before. */
  | { kind: "none" }
  /** 2FA on, but a valid trusted-device cookie of this member: issue the session. */
  | { kind: "trusted_device"; deviceId: string }
  /** 2FA on: no session; answer the challenge. */
  | { kind: "challenge"; challengeId: string; body: TwoFactorChallenge };

/** The user who passed the first factor. */
export interface FirstFactorUser {
  id: string;
  role: UserRole;
}

/**
 * Decide what a correct password or magic link leads to (WP-7). Call inside
 * the login transaction. For a user with 2FA it creates a challenge (hashed,
 * {@link TWO_FACTOR_CHALLENGE_TTL_MINUTES} minutes) unless the request carries
 * a valid trusted-device cookie of this **member** (administrators always get
 * a challenge).
 *
 * @param tx - Login transaction.
 * @param request - For the trusted-device cookie.
 * @param config - Cookie settings.
 * @param user - Id and database role.
 * @param method - The first factor.
 * @param now - Current time.
 */
export async function gateLogin(
  tx: Transaction,
  request: FastifyRequest,
  config: CookieConfig,
  user: FirstFactorUser,
  method: TwoFactorLoginMethod,
  now: Date
): Promise<LoginGate> {
  if (!(await isTwoFactorEnabled(tx, user.id))) return { kind: "none" };
  const isAdmin = user.role === "admin";
  if (!isAdmin) {
    const deviceToken = readTrustedDeviceCookie(request, config);
    const deviceId = deviceToken === null ? null : await useTrustedDevice(tx, user.id, deviceToken, now);
    if (deviceId !== null) return { kind: "trusted_device", deviceId };
  }
  const token = createOpaqueToken();
  const expiresAt = new Date(now.getTime() + TWO_FACTOR_CHALLENGE_TTL_MINUTES * MINUTE_MS);
  const [row] = await tx
    .insert(twoFactorChallenges)
    .values({ tokenHash: hashToken(token), userId: user.id, purpose: "login", method, createdAt: now, expiresAt })
    .returning({ id: twoFactorChallenges.id });
  if (!row) throw new Error("gateLogin: challenge insert returned no row");
  return {
    kind: "challenge",
    challengeId: row.id,
    body: { twoFactorRequired: true, challengeToken: token, trustDeviceAllowed: !isAdmin, expiresAt: expiresAt.toISOString() }
  };
}

/** A challenge locked for verification. */
export interface LockedChallenge {
  id: string;
  userId: string;
  method: TwoFactorLoginMethod;
  attempts: number;
}

/**
 * Lock a usable challenge: known, unconsumed, unexpired, attempts left.
 *
 * @returns The challenge, or `null` (one generic failure for every reason).
 */
export async function lockChallenge(tx: Transaction, rawToken: string, now: Date): Promise<LockedChallenge | null> {
  const [row] = await tx
    .select({
      id: twoFactorChallenges.id,
      userId: twoFactorChallenges.userId,
      method: twoFactorChallenges.method,
      attempts: twoFactorChallenges.attempts,
      expiresAt: twoFactorChallenges.expiresAt,
      consumedAt: twoFactorChallenges.consumedAt
    })
    .from(twoFactorChallenges)
    .where(eq(twoFactorChallenges.tokenHash, hashToken(rawToken)))
    .limit(1)
    .for("update");
  if (row === undefined || row.consumedAt !== null || row.expiresAt <= now || row.attempts >= TWO_FACTOR_MAX_ATTEMPTS) {
    return null;
  }
  return { id: row.id, userId: row.userId, method: row.method, attempts: row.attempts };
}

/** The owner of a challenge token (no lock), for the per-user limiter. */
export async function challengeOwner(db: DbOrTx, rawToken: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: twoFactorChallenges.userId })
    .from(twoFactorChallenges)
    .where(eq(twoFactorChallenges.tokenHash, hashToken(rawToken)))
    .limit(1);
  return row?.userId ?? null;
}

/**
 * Count one wrong answer; the {@link TWO_FACTOR_MAX_ATTEMPTS}th burns the challenge.
 *
 * @returns The new attempt count and whether it is burned.
 */
export async function failChallenge(tx: Transaction, challenge: LockedChallenge, now: Date): Promise<{ attempts: number; burned: boolean }> {
  const attempts = challenge.attempts + 1;
  const burned = attempts >= TWO_FACTOR_MAX_ATTEMPTS;
  await tx
    .update(twoFactorChallenges)
    .set({ attempts, ...(burned ? { consumedAt: now } : {}) })
    .where(eq(twoFactorChallenges.id, challenge.id));
  return { attempts, burned };
}

/** Mark a challenge used (success). */
export async function consumeChallenge(tx: Transaction, challengeId: string, now: Date): Promise<void> {
  await tx.update(twoFactorChallenges).set({ consumedAt: now }).where(eq(twoFactorChallenges.id, challengeId));
}

/** Burn every open challenge of a user (2FA reset or disable). */
export async function burnChallenges(tx: DbOrTx, userId: string, now: Date): Promise<void> {
  await tx
    .update(twoFactorChallenges)
    .set({ consumedAt: now })
    .where(and(eq(twoFactorChallenges.userId, userId), isNull(twoFactorChallenges.consumedAt)));
}

/* -------------------------------------------------------------------------- */
/* Second-factor checks                                                        */
/* -------------------------------------------------------------------------- */

/** What the caller typed. */
export interface SecondFactorInput {
  code?: string | undefined;
  recoveryCode?: string | undefined;
}

/** Outcome of {@link checkSecondFactor}. */
export type SecondFactorResult =
  | { ok: true; factor: "totp" }
  | { ok: true; factor: "recovery_code"; remaining: number }
  | { ok: false };

/** What the TOTP check needs from the app. */
export type TotpContext = Pick<FastifyInstance, "config" | "log">;

/**
 * Check a TOTP code against the user's **enabled** secret. Locks the
 * `user_totp` row so two concurrent requests cannot both use one step, and
 * records the accepted step (replay prevention). A secret that does not
 * decrypt (wrong key, tampering) fails closed and is logged without secrets.
 *
 * @param app - Config (key) and log.
 * @param tx - Open transaction.
 * @param userId - The user.
 * @param code - Six digits.
 * @param now - Current time.
 * @param options - `pending: true` checks the pending (not yet enabled) secret instead.
 */
export async function checkTotp(
  app: TotpContext,
  tx: Transaction,
  userId: string,
  code: string,
  now: Date,
  options: { pending?: boolean } = {}
): Promise<boolean> {
  const [row] = await tx
    .select({
      secretCiphertext: userTotp.secretCiphertext,
      secretIv: userTotp.secretIv,
      secretTag: userTotp.secretTag,
      enabledAt: userTotp.enabledAt,
      lastUsedStep: userTotp.lastUsedStep
    })
    .from(userTotp)
    .where(eq(userTotp.userId, userId))
    .limit(1)
    .for("update");
  if (row === undefined) return false;
  if ((options.pending === true) !== (row.enabledAt === null)) return false;
  let secret: string;
  try {
    secret = decryptSecret(totpKey(app.config), userId, {
      ciphertext: row.secretCiphertext,
      iv: row.secretIv,
      tag: row.secretTag
    });
  } catch (error) {
    if (!(error instanceof TotpDecryptionError)) throw error;
    app.log.error({ event: "totp.decrypt_failed", userId }, "TOTP secret could not be decrypted; failing closed");
    return false;
  }
  const result = await verifyTotpCode(secret, code, now, row.lastUsedStep);
  if (!result.ok) return false;
  await tx
    .update(userTotp)
    .set({ lastUsedStep: result.step, ...(options.pending === true ? { enabledAt: now } : {}) })
    .where(eq(userTotp.userId, userId));
  return true;
}

/**
 * Consume an unused recovery code of the user (single-use, row locked).
 *
 * @param normalized - Lowercase code without separators.
 * @returns Codes left after this one, or `null` when it is not a valid unused code.
 */
export async function consumeRecoveryCode(tx: Transaction, userId: string, normalized: string, now: Date): Promise<number | null> {
  const [row] = await tx
    .select({ id: userRecoveryCodes.id })
    .from(userRecoveryCodes)
    .where(
      and(
        eq(userRecoveryCodes.userId, userId),
        eq(userRecoveryCodes.codeHash, hashRecoveryCode(normalized)),
        isNull(userRecoveryCodes.usedAt)
      )
    )
    .limit(1)
    .for("update");
  if (row === undefined) return null;
  await tx.update(userRecoveryCodes).set({ usedAt: now }).where(eq(userRecoveryCodes.id, row.id));
  return remainingRecoveryCodes(tx, userId);
}

/**
 * Check either factor the caller typed against an **enabled** 2FA.
 *
 * @param app - Config and log.
 * @param tx - Open transaction.
 * @param userId - The user.
 * @param input - `code` or `recoveryCode` (the contract allows exactly one).
 * @param now - Current time.
 */
export async function checkSecondFactor(
  app: TotpContext,
  tx: Transaction,
  userId: string,
  input: SecondFactorInput,
  now: Date
): Promise<SecondFactorResult> {
  if (!(await isTwoFactorEnabled(tx, userId))) return { ok: false };
  if (input.code !== undefined) {
    return (await checkTotp(app, tx, userId, input.code, now)) ? { ok: true, factor: "totp" } : { ok: false };
  }
  if (input.recoveryCode !== undefined) {
    const remaining = await consumeRecoveryCode(tx, userId, input.recoveryCode, now);
    return remaining === null ? { ok: false } : { ok: true, factor: "recovery_code", remaining };
  }
  return { ok: false };
}

/**
 * Replace every recovery code of the user with {@link RECOVERY_CODE_COUNT} new ones.
 *
 * @returns The raw codes (normalized), to show once.
 */
export async function replaceRecoveryCodes(tx: Transaction, userId: string, now: Date): Promise<string[]> {
  await tx.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
  const codes = createRecoveryCodes();
  await tx
    .insert(userRecoveryCodes)
    .values(codes.map((code) => ({ userId, codeHash: hashRecoveryCode(code), createdAt: now })));
  return codes;
}

/**
 * Remove a user's 2FA entirely (disable or admin reset): the secret, the
 * recovery codes, every trusted device (revoked) and open challenges.
 *
 * @returns How many trusted devices were revoked.
 */
export async function removeTwoFactor(tx: Transaction, userId: string, now: Date): Promise<{ revokedTrustedDevices: number; hadTwoFactor: boolean }> {
  const deleted = await tx.delete(userTotp).where(eq(userTotp.userId, userId)).returning({ enabledAt: userTotp.enabledAt });
  await tx.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
  const revoked = await revokeTrustedDevices(tx, userId, now);
  await burnChallenges(tx, userId, now);
  return { revokedTrustedDevices: revoked.length, hadTwoFactor: deleted.some((row) => row.enabledAt !== null) };
}

/** Trusted devices of a user that still work. */
export async function liveTrustedDevices(db: DbOrTx, userId: string, now: Date) {
  return db
    .select({
      id: trustedDevices.id,
      tokenHash: trustedDevices.tokenHash,
      label: trustedDevices.userAgentLabel,
      createdAt: trustedDevices.createdAt,
      lastUsedAt: trustedDevices.lastUsedAt,
      expiresAt: trustedDevices.expiresAt
    })
    .from(trustedDevices)
    .where(and(eq(trustedDevices.userId, userId), isNull(trustedDevices.revokedAt), gt(trustedDevices.expiresAt, now)));
}

/** Users (by id) whose 2FA is enabled, among `userIds`. */
export async function twoFactorEnabledSet(db: DbOrTx, userIds: readonly string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await db
    .select({ userId: userTotp.userId })
    .from(userTotp)
    .where(and(inArray(userTotp.userId, [...userIds]), isNotNull(userTotp.enabledAt)));
  return new Set(rows.map((row) => row.userId));
}

/* -------------------------------------------------------------------------- */
/* Notices                                                                     */
/* -------------------------------------------------------------------------- */

/** A notice to send after commit. */
export interface TwoFactorNoticeMail {
  to: string;
  displayName: string;
  notice: TwoFactorNotice;
  at: Date;
  /** Stable id for the idempotency key (an audit or row id, never a token). */
  operationId: string;
  remainingCodes?: number;
}

/**
 * Queue a two-step verification security notice. Like the password-changed
 * notice it uses the reserved part of the daily cap (its audit row is
 * already committed and counted); past that it is skipped and logged.
 *
 * @param app - The app (mailer, jobs, config, db, log).
 * @param mail - Recipient, notice and ids.
 */
export async function queueTwoFactorNotice(app: FastifyInstance, mail: TwoFactorNoticeMail): Promise<void> {
  if (!(await withinGlobalMailCap(app, app.db, MailTier.Reserved, mail.at))) return;
  sendInBackground(app, `mail.two-factor-${mail.notice}`, () =>
    sendTemplate(
      app,
      mail.to,
      {
        kind: "two-factor-notice",
        props: {
          displayName: mail.displayName,
          notice: mail.notice,
          at: mail.at,
          supportContact: app.config.SUPPORT_EMAIL,
          ...(mail.remainingCodes === undefined ? {} : { remainingCodes: mail.remainingCodes })
        }
      },
      { idempotencyKey: `two-factor-${mail.notice}:${mail.operationId}` }
    )
  );
}
