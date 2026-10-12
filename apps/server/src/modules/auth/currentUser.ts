/**
 * Builds the contract's `CurrentUser` and `AuthTokenResponse` from the
 * database, so every auth response reflects the stored role, status,
 * must-change flag and verification state (never request input or claims).
 */
import type { AuthTokenResponse, CurrentUser } from "@cuencada/types";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { people, profiles, sessions, users, userTotp } from "../../db/schema/index.js";
import { accessTokenSettings, signAccessToken } from "../../lib/tokens.js";
import { setRefreshCookie } from "./cookies.js";
import type { IssuedRefresh } from "./sessions.js";

/** Avatar URLs in auth responses live for an hour (contract). */
const AVATAR_URL_TTL_SECONDS = 3600;

/** What {@link loadCurrentUser} needs from the app. */
type CurrentUserContext = Pick<FastifyInstance, "db" | "storage" | "log">;

async function avatarUrl(app: CurrentUserContext, avatarKey: string | null): Promise<string | null> {
  if (avatarKey === null) return null;
  try {
    const presigned = await app.storage.presignGet({ key: avatarKey, expiresInSeconds: AVATAR_URL_TTL_SECONDS });
    return presigned.url;
  } catch (error) {
    // Storage outages must not block login; the client falls back to initials.
    app.log.warn({ err: error }, "avatar presign failed; returning null avatarUrl");
    return null;
  }
}

/**
 * When the session proved a two-step code (WP-7), or `null` (also for an unknown session).
 *
 * @param app - Needs `db`.
 * @param sessionId - `sessions.id`.
 */
export async function sessionTwoFactorVerifiedAt(app: Pick<FastifyInstance, "db">, sessionId: string): Promise<Date | null> {
  const [row] = await app.db
    .select({ verifiedAt: sessions.twoFactorVerifiedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return row?.verifiedAt ?? null;
}

/** Whether the session proved a two-step code (WP-7). */
export async function sessionTwoFactorVerified(app: Pick<FastifyInstance, "db">, sessionId: string): Promise<boolean> {
  return (await sessionTwoFactorVerifiedAt(app, sessionId)) !== null;
}

/**
 * Load the `CurrentUser` for `userId`.
 *
 * @param app - Needs `db`, `storage` (avatar presign) and `log`.
 * @param userId - The user.
 * @param sessionId - The caller's session, to compute `twoFactorSetupRequired` (WP-7).
 * @returns The user, or `null` when the row is gone.
 */
export async function loadCurrentUser(
  app: CurrentUserContext,
  userId: string,
  sessionId?: string
): Promise<CurrentUser | null> {
  const [row] = await app.db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      status: users.status,
      mustChangePassword: users.mustChangePassword,
      emailVerifiedAt: users.emailVerifiedAt,
      personId: people.id,
      avatarKey: profiles.avatarKey,
      twoFactorEnabledAt: userTotp.enabledAt
    })
    .from(users)
    .leftJoin(people, eq(people.userId, users.id))
    .leftJoin(profiles, eq(profiles.userId, users.id))
    .leftJoin(userTotp, eq(userTotp.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1);
  if (row === undefined) return null;
  const sessionVerified = sessionId === undefined ? false : await sessionTwoFactorVerified(app, sessionId);
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    status: row.status,
    mustChangePassword: row.mustChangePassword,
    emailVerified: row.emailVerifiedAt !== null,
    personId: row.personId,
    avatarUrl: await avatarUrl(app, row.avatarKey),
    twoFactorEnabled: row.twoFactorEnabledAt !== null,
    // Same rule as the guard (`plugins/auth.ts`): the password gate comes first.
    twoFactorSetupRequired: row.role === "admin" && !row.mustChangePassword && !sessionVerified
  };
}

/**
 * Sign a fresh access token for an existing session (WP-7: after enable, so
 * the client gets `amr: ["otp"]` without a new refresh cookie).
 *
 * @param app - The app (config, db, storage, log).
 * @param userId - The session's user.
 * @param sessionId - The session.
 * @param now - Issue time.
 * @throws Error when the user disappeared (→ 500).
 */
export async function issueAccessResponse(
  app: FastifyInstance,
  userId: string,
  sessionId: string,
  now: Date
): Promise<AuthTokenResponse> {
  const user = await loadCurrentUser(app, userId, sessionId);
  if (user === null) throw new Error("issueAccessResponse: user row vanished");
  const verified = await sessionTwoFactorVerified(app, sessionId);
  const signed = await signAccessToken(
    accessTokenSettings(app.config),
    {
      userId,
      sessionId,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
      amr: verified ? ["otp"] : []
    },
    now
  );
  return { accessToken: signed.token, accessTokenExpiresAt: signed.expiresAt.toISOString(), user };
}

/**
 * Finish a successful authentication: set the refresh cookie, sign an access
 * token for the session and return the contract body.
 *
 * @param app - The app (config, db, storage, log).
 * @param reply - The reply that carries the cookie.
 * @param issued - Session id and the raw refresh token.
 * @param userId - The authenticated user.
 * @param now - Issue time.
 * @throws Error when the user disappeared between the transaction and now (→ 500).
 */
export async function issueAuthResponse(
  app: FastifyInstance,
  reply: FastifyReply,
  issued: IssuedRefresh,
  userId: string,
  now: Date
): Promise<AuthTokenResponse> {
  const body = await issueAccessResponse(app, userId, issued.sessionId, now);
  setRefreshCookie(reply, app.config, issued.refreshToken, issued.refreshExpiresAt, now);
  return body;
}
