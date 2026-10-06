/**
 * Builds the contract's `CurrentUser` and `AuthTokenResponse` from the
 * database, so every auth response reflects the stored role, status,
 * must-change flag and verification state (never request input or claims).
 */
import type { AuthTokenResponse, CurrentUser } from "@cuencada/types";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { people, profiles, users } from "../../db/schema/index.js";
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
 * Load the `CurrentUser` for `userId`.
 *
 * @param app - Needs `db`, `storage` (avatar presign) and `log`.
 * @param userId - The user.
 * @returns The user, or `null` when the row is gone.
 */
export async function loadCurrentUser(app: CurrentUserContext, userId: string): Promise<CurrentUser | null> {
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
      avatarKey: profiles.avatarKey
    })
    .from(users)
    .leftJoin(people, eq(people.userId, users.id))
    .leftJoin(profiles, eq(profiles.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1);
  if (row === undefined) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    status: row.status,
    mustChangePassword: row.mustChangePassword,
    emailVerified: row.emailVerifiedAt !== null,
    personId: row.personId,
    avatarUrl: await avatarUrl(app, row.avatarKey)
  };
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
  const user = await loadCurrentUser(app, userId);
  if (user === null) throw new Error("issueAuthResponse: user row vanished");
  const signed = await signAccessToken(
    accessTokenSettings(app.config),
    { userId, sessionId: issued.sessionId, role: user.role, mustChangePassword: user.mustChangePassword },
    now
  );
  setRefreshCookie(reply, app.config, issued.refreshToken, issued.refreshExpiresAt, now);
  return { accessToken: signed.token, accessTokenExpiresAt: signed.expiresAt.toISOString(), user };
}
