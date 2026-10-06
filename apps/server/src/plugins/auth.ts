/**
 * Default-deny authentication guard [SEC].
 *
 * Every route declares `config.auth`:
 * - `"public"`: no authentication.
 * - `"user"` (the default when `auth` is missing): a valid access token whose
 *   session is live in the database and whose user is active.
 * - `"admin"`: as `"user"`, and the user's **database** role is `admin`.
 * - `"cookie"`: refresh/logout. No bearer token; instead a CSRF check
 *   (`X-Cuencada-CSRF: 1` and an exact allowed `Origin`). The route itself
 *   validates the refresh cookie.
 *
 * Extra options for `"user"`/`"admin"` routes:
 * - `allowPendingPasswordChange: true` lets users who must change their
 *   temporary password through (`/me`, change-password). Everything else
 *   answers 403 `PASSWORD_CHANGE_REQUIRED` for them.
 * - `requireVerifiedEmail: true` (directory, family tree, other PII) answers
 *   403 `EMAIL_UNVERIFIED` while `users.email_verified_at` is null.
 *
 * Role, status and must-change-password always come from the database, never
 * from token claims, so revocation, disabling and demotion apply immediately.
 */
import { CSRF_HEADER, type UserRole, type UserStatus } from "@cuencada/types";
import { and, eq, lt } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { allowedOrigins } from "../config.js";
import { sessions, users } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import { accessTokenSettings, verifyAccessToken } from "../lib/tokens.js";

/** Route authentication levels. */
export const AuthLevel = {
  Public: "public",
  User: "user",
  Admin: "admin",
  Cookie: "cookie"
} as const;
export type AuthLevel = (typeof AuthLevel)[keyof typeof AuthLevel];

const AUTH_LEVELS: ReadonlySet<string> = new Set(Object.values(AuthLevel));

/** `sessions.last_used_at` is written at most this often per session. */
export const SESSION_TOUCH_INTERVAL_MS = 60_000;

/** The authenticated caller, loaded from the database on every request. */
export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  mustChangePassword: boolean;
  emailVerified: boolean;
  /** `sessions.id` of the access token (the `sid` claim). */
  sessionId: string;
}

declare module "fastify" {
  interface FastifyContextConfig {
    /** Authentication level; missing means `"user"` (default deny). */
    auth?: AuthLevel;
    /** Allow users with `must_change_password` (only `/me`, change-password). */
    allowPendingPasswordChange?: boolean;
    /** Require a verified email (directory, family tree, PII). */
    requireVerifiedEmail?: boolean;
  }

  interface FastifyRequest {
    /** Set by the auth guard on `"user"`/`"admin"` routes; `null` elsewhere. */
    user: AuthUser | null;
  }
}

/**
 * The authenticated user on a `"user"`/`"admin"` route.
 *
 * @param request - The current request.
 * @throws AppError `UNAUTHENTICATED` if called on a route without a user (a programming error on a public route).
 */
export function authUser(request: FastifyRequest): AuthUser {
  if (request.user === null) throw new AppError("UNAUTHENTICATED");
  return request.user;
}

function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer ([A-Za-z0-9_\-.]{1,4096})$/.exec(header);
  return match?.[1] ?? null;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * CSRF check for cookie-authenticated routes: `X-Cuencada-CSRF: 1` plus an
 * `Origin` header that exactly equals an allowed origin.
 *
 * @throws AppError `CSRF_FAILED`.
 */
function assertCsrf(request: FastifyRequest, origins: ReadonlySet<string>): void {
  const marker = firstHeader(request.headers[CSRF_HEADER]);
  const origin = firstHeader(request.headers.origin);
  if (marker !== "1" || origin === undefined || !origins.has(origin)) {
    throw new AppError("CSRF_FAILED");
  }
}

/**
 * Install the guard on the root instance: an `onRoute` check that rejects
 * invalid `config.auth` values at boot, `request.user`, and the `onRequest`
 * hook. Register it **before** any route.
 *
 * @param app - Root instance (needs `config`, `db` and `clock` decorated).
 */
export function registerAuthGuard(app: FastifyInstance): void {
  const tokenSettings = accessTokenSettings(app.config);
  const csrfOrigins: ReadonlySet<string> = new Set(allowedOrigins(app.config));

  app.decorateRequest("user", null);

  app.addHook("onRoute", (route) => {
    const config = route.config;
    const level: unknown = config?.auth ?? AuthLevel.User;
    if (typeof level !== "string" || !AUTH_LEVELS.has(level)) {
      throw new Error(`Route ${route.method} ${route.url}: invalid config.auth`);
    }
    const userLevel = level === AuthLevel.User || level === AuthLevel.Admin;
    if (!userLevel && (config?.allowPendingPasswordChange === true || config?.requireVerifiedEmail === true)) {
      throw new Error(
        `Route ${route.method} ${route.url}: allowPendingPasswordChange/requireVerifiedEmail need auth "user" or "admin"`
      );
    }
  });

  app.addHook("onRequest", async (request) => {
    // Unknown routes fall through to the 404 handler.
    if (request.is404) return;
    const config = request.routeOptions.config;
    const level = config.auth ?? AuthLevel.User;
    if (level === AuthLevel.Public) return;
    if (level === AuthLevel.Cookie) {
      assertCsrf(request, csrfOrigins);
      return;
    }

    const token = bearerToken(request.headers.authorization);
    if (token === null) throw new AppError("UNAUTHENTICATED");

    const now = app.clock.now();
    const verification = await verifyAccessToken(tokenSettings, token, now);
    if (!verification.ok) {
      throw new AppError(verification.reason === "expired" ? "TOKEN_EXPIRED" : "UNAUTHENTICATED");
    }
    const { claims } = verification;

    const [row] = await app.db
      .select({
        userId: sessions.userId,
        lastUsedAt: sessions.lastUsedAt,
        idleExpiresAt: sessions.idleExpiresAt,
        absoluteExpiresAt: sessions.absoluteExpiresAt,
        revokedAt: sessions.revokedAt,
        email: users.email,
        displayName: users.displayName,
        role: users.role,
        status: users.status,
        mustChangePassword: users.mustChangePassword,
        emailVerifiedAt: users.emailVerifiedAt
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.id, claims.sessionId))
      .limit(1);

    if (
      row === undefined ||
      row.userId !== claims.userId ||
      row.revokedAt !== null ||
      row.idleExpiresAt <= now ||
      row.absoluteExpiresAt <= now ||
      row.status !== "active"
    ) {
      throw new AppError("UNAUTHENTICATED");
    }

    if (row.mustChangePassword && config.allowPendingPasswordChange !== true) {
      throw new AppError("PASSWORD_CHANGE_REQUIRED");
    }
    if (level === AuthLevel.Admin && row.role !== "admin") {
      throw new AppError("FORBIDDEN");
    }
    if (config.requireVerifiedEmail === true && row.emailVerifiedAt === null) {
      throw new AppError("EMAIL_UNVERIFIED");
    }

    if (now.getTime() - row.lastUsedAt.getTime() >= SESSION_TOUCH_INTERVAL_MS) {
      const threshold = new Date(now.getTime() - SESSION_TOUCH_INTERVAL_MS);
      await app.db
        .update(sessions)
        .set({ lastUsedAt: now })
        .where(and(eq(sessions.id, claims.sessionId), lt(sessions.lastUsedAt, threshold)));
    }

    request.user = {
      id: row.userId,
      email: row.email,
      displayName: row.displayName,
      role: row.role,
      status: row.status,
      mustChangePassword: row.mustChangePassword,
      emailVerified: row.emailVerifiedAt !== null,
      sessionId: claims.sessionId
    };
  });
}
