/**
 * Sessions and rotating refresh tokens [SEC].
 *
 * - A session has a sliding idle expiry (`REFRESH_IDLE_DAYS`) and a hard
 *   absolute expiry (`REFRESH_ABSOLUTE_DAYS`); a refresh pushes the idle
 *   expiry forward but never past the absolute one.
 * - Each refresh token is single-use. Rotation marks the old row `used_at`
 *   and links `replaced_by_token_id`. Presenting a used token more than
 *   {@link REFRESH_REUSE_GRACE_MS} after its use is **reuse**: the whole
 *   session is revoked. Within the window (WP-4.6) the client most likely lost
 *   the rotation response (a reload or a second tab): its immediate, still
 *   unused successor is rotated once more and a fresh token issued for the
 *   same session ("grace re-issue"). A second grace use of the same token
 *   finds the successor used and is reuse.
 * - Only SHA-256 hashes of refresh tokens are stored.
 */
import { and, eq, isNull, ne, type SQL } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { AppConfig } from "../../config.js";
import { refreshTokens, type SessionRevokedReason, sessions, users } from "../../db/schema/index.js";
import type { DbOrTx, Transaction } from "../../lib/audit.js";
import { createOpaqueToken, hashToken } from "../../lib/tokens.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A used refresh token presented again within this window gets a grace re-issue, not reuse (WP-4.6). */
export const REFRESH_REUSE_GRACE_MS = 10_000;
/** Stored and returned User-Agent length (matches `sessionListItemSchema`). */
export const USER_AGENT_MAX = 300;

type SessionConfig = Pick<AppConfig, "REFRESH_IDLE_DAYS" | "REFRESH_ABSOLUTE_DAYS">;

/** Where a session was started from (shown in the session list). */
export interface SessionOrigin {
  userAgent: string | null;
  ip: string;
}

/** A freshly issued refresh token for a session. */
export interface IssuedRefresh {
  sessionId: string;
  /** Raw token for the cookie; never stored or logged. */
  refreshToken: string;
  /** Token expiry = the session's idle expiry. */
  refreshExpiresAt: Date;
}

/**
 * Request metadata for a new session.
 *
 * @param request - The login (or equivalent) request.
 */
export function sessionOrigin(request: FastifyRequest): SessionOrigin {
  const header = request.headers["user-agent"];
  const userAgent = typeof header === "string" && header.length > 0 ? header.slice(0, USER_AGENT_MAX) : null;
  return { userAgent, ip: request.ip };
}

function idleExpiry(config: SessionConfig, now: Date, absoluteExpiresAt: Date): Date {
  const idle = now.getTime() + config.REFRESH_IDLE_DAYS * DAY_MS;
  return new Date(Math.min(idle, absoluteExpiresAt.getTime()));
}

async function insertRefreshToken(
  tx: DbOrTx,
  sessionId: string,
  expiresAt: Date
): Promise<{ id: string; refreshToken: string }> {
  const refreshToken = createOpaqueToken();
  const [row] = await tx
    .insert(refreshTokens)
    .values({ sessionId, tokenHash: hashToken(refreshToken), expiresAt })
    .returning({ id: refreshTokens.id });
  if (!row) throw new Error("insertRefreshToken: insert returned no row");
  return { id: row.id, refreshToken };
}

/**
 * Create a session plus its first refresh token.
 *
 * @param tx - Open transaction.
 * @param config - Idle/absolute lifetimes.
 * @param userId - Owner.
 * @param origin - User-Agent and IP.
 * @param now - Current time.
 */
export async function startSession(
  tx: Transaction,
  config: SessionConfig,
  userId: string,
  origin: SessionOrigin,
  now: Date
): Promise<IssuedRefresh> {
  const absoluteExpiresAt = new Date(now.getTime() + config.REFRESH_ABSOLUTE_DAYS * DAY_MS);
  const idleExpiresAt = idleExpiry(config, now, absoluteExpiresAt);
  const [session] = await tx
    .insert(sessions)
    .values({
      userId,
      userAgent: origin.userAgent,
      ipAddress: origin.ip,
      lastUsedAt: now,
      idleExpiresAt,
      absoluteExpiresAt
    })
    .returning({ id: sessions.id });
  if (!session) throw new Error("startSession: session insert returned no row");
  const { refreshToken } = await insertRefreshToken(tx, session.id, idleExpiresAt);
  return { sessionId: session.id, refreshToken, refreshExpiresAt: idleExpiresAt };
}

/** Which of a user's live sessions to revoke. */
export interface RevokeScope {
  userId: string;
  /** Keep this session (revoke-others). */
  exceptSessionId?: string;
  /** Only this session. */
  sessionId?: string;
}

/**
 * Revoke live (not yet revoked) sessions of a user. Expired sessions are
 * revoked too, which is harmless and keeps the list honest.
 *
 * @param tx - Transaction or client.
 * @param scope - User and optional single/excluded session.
 * @param reason - `sessions.revoked_reason`.
 * @param now - Revocation time.
 * @returns Ids of the sessions revoked by this call.
 */
export async function revokeSessions(
  tx: DbOrTx,
  scope: RevokeScope,
  reason: SessionRevokedReason,
  now: Date
): Promise<string[]> {
  const conditions: SQL[] = [eq(sessions.userId, scope.userId), isNull(sessions.revokedAt)];
  if (scope.exceptSessionId !== undefined) conditions.push(ne(sessions.id, scope.exceptSessionId));
  if (scope.sessionId !== undefined) conditions.push(eq(sessions.id, scope.sessionId));
  const rows = await tx
    .update(sessions)
    .set({ revokedAt: now, revokedReason: reason })
    .where(and(...conditions))
    .returning({ id: sessions.id });
  return rows.map((row) => row.id);
}

/** Why a refresh was treated as reuse (audit metadata, no token data). */
export type RefreshReuseReason =
  /** A used token presented after the grace window. */
  | "after_grace"
  /** A used token presented inside the window, but its successor was already used (a second grace use or a stale chain). */
  | "successor_used"
  /** A used token inside the window whose successor is missing from its session (tampering or a bug: fail closed). */
  | "successor_missing";

/** Result of {@link rotateRefreshToken}. */
export type RefreshOutcome =
  | ({ kind: "rotated"; userId: string } & IssuedRefresh)
  /**
   * WP-4.6 grace re-issue: the presented token was rotated less than
   * {@link REFRESH_REUSE_GRACE_MS} ago and its successor is still unused, so
   * the successor was rotated in turn and a fresh token issued for the same
   * session (the browser most likely never stored the successor's cookie).
   */
  | ({
      kind: "grace_reissued";
      userId: string;
      /** Row id of the token the client presented (not token material). */
      presentedTokenId: string;
      /** Row id of the successor that was rotated on its behalf. */
      successorTokenId: string;
    } & IssuedRefresh)
  /** Unknown token, expired token/session, revoked session, disabled user, or an expired successor inside the grace window. */
  | { kind: "invalid" }
  /** Reuse: the session was revoked by this call. */
  | { kind: "reuse"; userId: string; sessionId: string; reason: RefreshReuseReason };

/** The locked session row a refresh works on. */
interface LockedSession {
  id: string;
  userId: string;
  absoluteExpiresAt: Date;
}

/**
 * Mark `tokenId` used, link it to a newly issued token and slide the session's
 * idle expiry. The caller holds the session lock.
 */
async function rotateTokenRow(
  tx: Transaction,
  config: SessionConfig,
  session: LockedSession,
  tokenId: string,
  now: Date
): Promise<IssuedRefresh> {
  const refreshExpiresAt = idleExpiry(config, now, session.absoluteExpiresAt);
  const next = await insertRefreshToken(tx, session.id, refreshExpiresAt);
  await tx
    .update(refreshTokens)
    .set({ usedAt: now, replacedByTokenId: next.id })
    .where(eq(refreshTokens.id, tokenId));
  await tx
    .update(sessions)
    .set({ idleExpiresAt: refreshExpiresAt, lastUsedAt: now })
    .where(eq(sessions.id, session.id));
  return { sessionId: session.id, refreshToken: next.refreshToken, refreshExpiresAt };
}

async function revokeForReuse(
  tx: Transaction,
  session: LockedSession,
  reason: RefreshReuseReason,
  now: Date
): Promise<RefreshOutcome> {
  await revokeSessions(tx, { userId: session.userId, sessionId: session.id }, "refresh_reuse", now);
  return { kind: "reuse", userId: session.userId, sessionId: session.id, reason };
}

/**
 * Rotate a refresh token inside `tx` [SEC].
 *
 * Locking: the token's **session** row is locked first (`SELECT … FOR UPDATE`),
 * then its token rows. Every token mutation of a session happens under that
 * lock, so two concurrent refreshes of one session (two tabs, or a reload that
 * re-sends a token whose rotation is still committing) serialize, always in
 * the same order (no deadlock between a predecessor and its successor).
 *
 * Outcomes for the presented token `P`:
 * - unused and unexpired: rotate it (`rotated`).
 * - used more than {@link REFRESH_REUSE_GRACE_MS} ago: reuse, revoke the session.
 * - used within the window (WP-4.6): look at its immediate successor `S`
 *   (`P.replaced_by_token_id`, same session). If `S` is unused and unexpired,
 *   rotate `S` and return a fresh token (`grace_reissued`); a client that lost
 *   the rotation response (page reload, dropped connection) is healed instead
 *   of logged out. If `S` was already used, `P` is being replayed a second time
 *   (the grace is spent) or behind a chain that moved on: reuse, revoke. A
 *   successor missing from the session also revokes (fail closed); an expired
 *   one is `invalid`.
 *
 * @param tx - Open transaction (the caller commits even for `reuse`, so the revocation sticks).
 * @param config - Idle lifetime.
 * @param rawToken - Token from the cookie.
 * @param now - Current time.
 */
export async function rotateRefreshToken(
  tx: Transaction,
  config: SessionConfig,
  rawToken: string,
  now: Date
): Promise<RefreshOutcome> {
  const tokenHash = hashToken(rawToken);
  // Which session? (No lock yet: the session lock comes first, see above.)
  const [owner] = await tx
    .select({ sessionId: refreshTokens.sessionId })
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, tokenHash))
    .limit(1);
  if (owner === undefined) return { kind: "invalid" };

  const [session] = await tx
    .select({
      id: sessions.id,
      userId: sessions.userId,
      revokedAt: sessions.revokedAt,
      idleExpiresAt: sessions.idleExpiresAt,
      absoluteExpiresAt: sessions.absoluteExpiresAt,
      userStatus: users.status
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, owner.sessionId))
    .limit(1)
    .for("update", { of: sessions });
  if (session === undefined) return { kind: "invalid" };
  const sessionDead =
    session.revokedAt !== null ||
    session.userStatus !== "active" ||
    session.idleExpiresAt <= now ||
    session.absoluteExpiresAt <= now;
  if (sessionDead) return { kind: "invalid" };

  // Re-read under the session lock: a concurrent refresh may have just used it.
  const [token] = await tx
    .select({
      id: refreshTokens.id,
      expiresAt: refreshTokens.expiresAt,
      usedAt: refreshTokens.usedAt,
      replacedByTokenId: refreshTokens.replacedByTokenId
    })
    .from(refreshTokens)
    .where(and(eq(refreshTokens.tokenHash, tokenHash), eq(refreshTokens.sessionId, session.id)))
    .limit(1)
    .for("update");
  if (token === undefined) return { kind: "invalid" };

  if (token.usedAt === null) {
    if (token.expiresAt <= now) return { kind: "invalid" };
    const issued = await rotateTokenRow(tx, config, session, token.id, now);
    return { kind: "rotated", userId: session.userId, ...issued };
  }

  if (now.getTime() - token.usedAt.getTime() > REFRESH_REUSE_GRACE_MS) {
    return revokeForReuse(tx, session, "after_grace", now);
  }
  // [SEC] Only the immediate successor, only in the same session.
  if (token.replacedByTokenId === null) return revokeForReuse(tx, session, "successor_missing", now);
  const [successor] = await tx
    .select({ id: refreshTokens.id, expiresAt: refreshTokens.expiresAt, usedAt: refreshTokens.usedAt })
    .from(refreshTokens)
    .where(and(eq(refreshTokens.id, token.replacedByTokenId), eq(refreshTokens.sessionId, session.id)))
    .limit(1)
    .for("update");
  if (successor === undefined) return revokeForReuse(tx, session, "successor_missing", now);
  if (successor.expiresAt <= now) return { kind: "invalid" };
  if (successor.usedAt !== null) return revokeForReuse(tx, session, "successor_used", now);

  const issued = await rotateTokenRow(tx, config, session, successor.id, now);
  return {
    kind: "grace_reissued",
    userId: session.userId,
    presentedTokenId: token.id,
    successorTokenId: successor.id,
    ...issued
  };
}

/** The live session a refresh token belongs to (logout). */
export interface CookieSession {
  sessionId: string;
  userId: string;
}

/**
 * Find the live session behind a refresh token, locking it. A token that was
 * already rotated still identifies its session (another tab may hold the
 * newer one), so logout works from any tab.
 *
 * @param tx - Open transaction.
 * @param rawToken - Token from the cookie.
 * @param now - Current time.
 * @returns The session, or `null` when unknown, revoked or expired.
 */
export async function findCookieSession(tx: Transaction, rawToken: string, now: Date): Promise<CookieSession | null> {
  const [row] = await tx
    .select({
      sessionId: sessions.id,
      userId: sessions.userId,
      revokedAt: sessions.revokedAt,
      idleExpiresAt: sessions.idleExpiresAt,
      absoluteExpiresAt: sessions.absoluteExpiresAt
    })
    .from(refreshTokens)
    .innerJoin(sessions, eq(sessions.id, refreshTokens.sessionId))
    .where(eq(refreshTokens.tokenHash, hashToken(rawToken)))
    .limit(1)
    .for("update", { of: sessions });
  if (row === undefined || row.revokedAt !== null || row.idleExpiresAt <= now || row.absoluteExpiresAt <= now) {
    return null;
  }
  return { sessionId: row.sessionId, userId: row.userId };
}
