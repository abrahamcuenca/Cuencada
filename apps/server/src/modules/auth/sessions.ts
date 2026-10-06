/**
 * Sessions and rotating refresh tokens [SEC].
 *
 * - A session has a sliding idle expiry (`REFRESH_IDLE_DAYS`) and a hard
 *   absolute expiry (`REFRESH_ABSOLUTE_DAYS`); a refresh pushes the idle
 *   expiry forward but never past the absolute one.
 * - Each refresh token is single-use. Rotation marks the old row `used_at`
 *   and links `replaced_by_token_id`. Presenting a used token more than
 *   {@link REFRESH_REUSE_GRACE_MS} after its use is **reuse**: the whole
 *   session is revoked. Within the window it is a benign multi-tab race
 *   (409 `REFRESH_RACE`, nothing revoked).
 * - Only SHA-256 hashes of refresh tokens are stored.
 */
import { and, eq, isNull, ne, type SQL } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { AppConfig } from "../../config.js";
import { refreshTokens, type SessionRevokedReason, sessions, users } from "../../db/schema/index.js";
import type { DbOrTx, Transaction } from "../../lib/audit.js";
import { createOpaqueToken, hashToken } from "../../lib/tokens.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A used refresh token presented again within this window is a race, not reuse. */
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

/** Result of {@link rotateRefreshToken}. */
export type RefreshOutcome =
  | ({ kind: "rotated"; userId: string } & IssuedRefresh)
  /** Unknown token, expired token/session, revoked session or disabled user. */
  | { kind: "invalid" }
  /** Used within the grace window: another tab just rotated it. */
  | { kind: "race"; userId: string; sessionId: string }
  /** Used after the grace window: the session was revoked by this call. */
  | { kind: "reuse"; userId: string; sessionId: string };

/**
 * Rotate a refresh token inside `tx`, locking its row (`SELECT … FOR UPDATE`)
 * so two concurrent refreshes serialize: the second one sees `used_at` and
 * gets `race`.
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
  const [row] = await tx
    .select({
      tokenId: refreshTokens.id,
      tokenExpiresAt: refreshTokens.expiresAt,
      usedAt: refreshTokens.usedAt,
      sessionId: sessions.id,
      userId: sessions.userId,
      revokedAt: sessions.revokedAt,
      idleExpiresAt: sessions.idleExpiresAt,
      absoluteExpiresAt: sessions.absoluteExpiresAt,
      userStatus: users.status
    })
    .from(refreshTokens)
    .innerJoin(sessions, eq(sessions.id, refreshTokens.sessionId))
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(refreshTokens.tokenHash, hashToken(rawToken)))
    .limit(1)
    .for("update", { of: [refreshTokens, sessions] });

  if (row === undefined) return { kind: "invalid" };
  const sessionDead =
    row.revokedAt !== null ||
    row.userStatus !== "active" ||
    row.idleExpiresAt <= now ||
    row.absoluteExpiresAt <= now;
  if (sessionDead) return { kind: "invalid" };

  if (row.usedAt !== null) {
    if (now.getTime() - row.usedAt.getTime() <= REFRESH_REUSE_GRACE_MS) return { kind: "race", userId: row.userId, sessionId: row.sessionId };
    await revokeSessions(tx, { userId: row.userId, sessionId: row.sessionId }, "refresh_reuse", now);
    return { kind: "reuse", userId: row.userId, sessionId: row.sessionId };
  }
  if (row.tokenExpiresAt <= now) return { kind: "invalid" };

  const refreshExpiresAt = idleExpiry(config, now, row.absoluteExpiresAt);
  const next = await insertRefreshToken(tx, row.sessionId, refreshExpiresAt);
  await tx
    .update(refreshTokens)
    .set({ usedAt: now, replacedByTokenId: next.id })
    .where(eq(refreshTokens.id, row.tokenId));
  await tx
    .update(sessions)
    .set({ idleExpiresAt: refreshExpiresAt, lastUsedAt: now })
    .where(eq(sessions.id, row.sessionId));
  return {
    kind: "rotated",
    userId: row.userId,
    sessionId: row.sessionId,
    refreshToken: next.refreshToken,
    refreshExpiresAt
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
