/**
 * Login, refresh, logout, `/me` and session management [SEC].
 */
import {
  apiErrorSchema,
  authTokenResponseSchema,
  currentUserSchema,
  idParamSchema,
  loginInputSchema,
  refreshResponseSchema,
  type SessionListItem,
  sessionListItemSchema
} from "@cuencada/types";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { sessions, users } from "../../db/schema/index.js";
import { recordAudit } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { hashPassword, needsRehash, verifyDummyPassword, verifyPassword } from "../../lib/passwords.js";
import { credentialRateLimits, rateLimitByIp } from "../../lib/rateLimit.js";
import { authUser } from "../../plugins/auth.js";
import { clearRefreshCookie, readRefreshCookie } from "./cookies.js";
import { issueAuthResponse, loadCurrentUser } from "./currentUser.js";
import { AuthAuditAction } from "./emailTokens.js";
import {
  findCookieSession,
  revokeSessions,
  rotateRefreshToken,
  sessionOrigin,
  startSession,
  USER_AGENT_MAX
} from "./sessions.js";

/** Most sessions listed for one user (the list is bounded by design). */
const SESSION_LIST_MAX = 100;

const noContent = z.null().describe("No content");

const errorResponses = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  429: apiErrorSchema
} as const;

/** Session routes, mounted under `/api`. */
const sessionRoutes: FastifyPluginAsyncZod = async (app) => {
  const loginLimits = credentialRateLimits(app);

  /** `POST /api/auth/login`: email + password → access token + refresh cookie. */
  app.post(
    "/auth/login",
    {
      config: { auth: "public", rateLimit: loginLimits.rateLimit },
      preHandler: loginLimits.preHandler,
      schema: { body: loginInputSchema, response: { 200: authTokenResponseSchema, ...errorResponses } }
    },
    async (request, reply) => {
      const { email, password } = request.body;
      const [user] = await app.db
        .select({
          id: users.id,
          passwordHash: users.passwordHash,
          status: users.status
        })
        .from(users)
        .where(sql`lower(${users.email}) = ${email}`)
        .limit(1);

      // Same argon2 cost whether or not the account exists (no enumeration by timing).
      const passwordOk =
        user?.passwordHash != null
          ? await verifyPassword(user.passwordHash, password)
          : await verifyDummyPassword(password);
      if (user === undefined) throw new AppError("INVALID_CREDENTIALS");
      if (!passwordOk || user.status !== "active" || user.passwordHash === null) {
        await recordAudit(app.db, {
          actorUserId: null,
          action: AuthAuditAction.LoginFailed,
          entityType: "user",
          entityId: user.id,
          metadata: { reason: passwordOk ? "inactive" : "bad_password" },
          ip: request.ip
        });
        throw new AppError("INVALID_CREDENTIALS");
      }

      const now = app.clock.now();
      const rehash = needsRehash(user.passwordHash) ? await hashPassword(password) : null;
      const issued = await app.db.transaction(async (tx) => {
        await tx
          .update(users)
          .set({ lastLoginAt: now, ...(rehash === null ? {} : { passwordHash: rehash }) })
          .where(eq(users.id, user.id));
        const started = await startSession(tx, app.config, user.id, sessionOrigin(request), now);
        await recordAudit(tx, {
          actorUserId: user.id,
          action: AuthAuditAction.LoggedIn,
          entityType: "session",
          entityId: started.sessionId,
          metadata: { method: "password" },
          ip: request.ip
        });
        return started;
      });
      return issueAuthResponse(app, reply, issued, user.id, now);
    }
  );

  /**
   * `POST /api/auth/refresh` (cookie + CSRF): rotate the refresh token.
   * 401 for unknown/expired/revoked, 409 `REFRESH_RACE` inside the grace
   * window, and reuse after it revokes the session.
   */
  app.post(
    "/auth/refresh",
    {
      config: { auth: "cookie", rateLimit: rateLimitByIp({ max: 60, timeWindow: "1 minute" }) },
      schema: { response: { 200: refreshResponseSchema, ...errorResponses, 409: apiErrorSchema } }
    },
    async (request, reply) => {
      const rawToken = readRefreshCookie(request, app.config);
      if (rawToken === null) {
        clearRefreshCookie(reply, app.config);
        throw new AppError("UNAUTHENTICATED");
      }
      const now = app.clock.now();
      const outcome = await app.db.transaction(async (tx) => {
        const result = await rotateRefreshToken(tx, app.config, rawToken, now);
        if (result.kind === "reuse") {
          await recordAudit(tx, {
            actorUserId: null,
            action: AuthAuditAction.RefreshReuseDetected,
            entityType: "session",
            entityId: result.sessionId,
            metadata: { userId: result.userId },
            ip: request.ip
          });
        }
        return result;
      });

      switch (outcome.kind) {
        case "rotated":
          return issueAuthResponse(app, reply, outcome, outcome.userId, now);
        case "race":
          throw new AppError("REFRESH_RACE");
        case "reuse":
          request.log.warn({ sessionId: outcome.sessionId }, "refresh token reuse detected; session revoked");
          clearRefreshCookie(reply, app.config);
          throw new AppError("UNAUTHENTICATED");
        case "invalid":
          clearRefreshCookie(reply, app.config);
          throw new AppError("UNAUTHENTICATED");
      }
    }
  );

  /** `POST /api/auth/logout` (cookie + CSRF): revoke this session. 401 when already dead. */
  app.post(
    "/auth/logout",
    {
      config: { auth: "cookie", rateLimit: rateLimitByIp({ max: 30, timeWindow: "1 minute" }) },
      schema: { response: { 204: noContent, ...errorResponses } }
    },
    async (request, reply) => {
      clearRefreshCookie(reply, app.config);
      const rawToken = readRefreshCookie(request, app.config);
      if (rawToken === null) throw new AppError("UNAUTHENTICATED");
      const now = app.clock.now();
      const revoked = await app.db.transaction(async (tx) => {
        const session = await findCookieSession(tx, rawToken, now);
        if (session === null) return false;
        await revokeSessions(tx, { userId: session.userId, sessionId: session.sessionId }, "logout", now);
        await recordAudit(tx, {
          actorUserId: session.userId,
          action: AuthAuditAction.LoggedOut,
          entityType: "session",
          entityId: session.sessionId,
          ip: request.ip
        });
        return true;
      });
      if (!revoked) throw new AppError("UNAUTHENTICATED");
      return reply.code(204).send(null);
    }
  );

  /** `POST /api/auth/logout-all`: revoke every session of the caller, including this one. */
  app.post(
    "/auth/logout-all",
    {
      config: { auth: "user", rateLimit: rateLimitByIp({ max: 10, timeWindow: "1 minute" }) },
      schema: { response: { 204: noContent, ...errorResponses } }
    },
    async (request, reply) => {
      const user = authUser(request);
      const now = app.clock.now();
      await app.db.transaction(async (tx) => {
        const revoked = await revokeSessions(tx, { userId: user.id }, "user_revoked", now);
        await recordAudit(tx, {
          actorUserId: user.id,
          action: AuthAuditAction.SessionsRevoked,
          entityType: "user",
          entityId: user.id,
          metadata: { scope: "all", count: revoked.length },
          ip: request.ip
        });
      });
      clearRefreshCookie(reply, app.config);
      return reply.code(204).send(null);
    }
  );

  /** `GET /api/me`: the caller as stored in the database. */
  app.get(
    "/me",
    {
      config: { auth: "user", allowPendingPasswordChange: true },
      schema: { response: { 200: currentUserSchema, ...errorResponses } }
    },
    async (request) => {
      const user = await loadCurrentUser(app, authUser(request).id);
      if (user === null) throw new AppError("UNAUTHENTICATED");
      return user;
    }
  );

  /** `GET /api/auth/sessions`: the caller's live sessions (never token hashes). */
  app.get(
    "/auth/sessions",
    { config: { auth: "user" }, schema: { response: { 200: z.array(sessionListItemSchema), ...errorResponses } } },
    async (request): Promise<SessionListItem[]> => {
      const user = authUser(request);
      const now = app.clock.now();
      const rows = await app.db
        .select({
          id: sessions.id,
          createdAt: sessions.createdAt,
          lastUsedAt: sessions.lastUsedAt,
          idleExpiresAt: sessions.idleExpiresAt,
          absoluteExpiresAt: sessions.absoluteExpiresAt,
          userAgent: sessions.userAgent,
          ipAddress: sessions.ipAddress
        })
        .from(sessions)
        .where(
          and(
            eq(sessions.userId, user.id),
            isNull(sessions.revokedAt),
            gt(sessions.idleExpiresAt, now),
            gt(sessions.absoluteExpiresAt, now)
          )
        )
        .orderBy(desc(sessions.lastUsedAt), desc(sessions.id))
        .limit(SESSION_LIST_MAX);
      return rows.map((row) => ({
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        lastUsedAt: row.lastUsedAt.toISOString(),
        expiresAt: new Date(Math.min(row.idleExpiresAt.getTime(), row.absoluteExpiresAt.getTime())).toISOString(),
        userAgent: row.userAgent === null ? null : row.userAgent.slice(0, USER_AGENT_MAX),
        ipAddress: row.ipAddress === null ? null : row.ipAddress.slice(0, 64),
        current: row.id === user.sessionId
      }));
    }
  );

  /** `DELETE /api/auth/sessions/:id`: revoke one of the caller's sessions (404 for anyone else's). */
  app.delete(
    "/auth/sessions/:id",
    {
      config: { auth: "user", rateLimit: rateLimitByIp({ max: 30, timeWindow: "1 minute" }) },
      schema: { params: idParamSchema, response: { 204: noContent, ...errorResponses, 404: apiErrorSchema } }
    },
    async (request, reply) => {
      const user = authUser(request);
      const now = app.clock.now();
      const revoked = await app.db.transaction(async (tx) => {
        const ids = await revokeSessions(tx, { userId: user.id, sessionId: request.params.id }, "user_revoked", now);
        if (ids.length === 0) return false;
        await recordAudit(tx, {
          actorUserId: user.id,
          action: AuthAuditAction.SessionRevoked,
          entityType: "session",
          entityId: request.params.id,
          metadata: { current: request.params.id === user.sessionId },
          ip: request.ip
        });
        return true;
      });
      if (!revoked) throw new AppError("NOT_FOUND");
      return reply.code(204).send(null);
    }
  );

  /** `POST /api/auth/sessions/revoke-others`: revoke every session except this one. */
  app.post(
    "/auth/sessions/revoke-others",
    {
      config: { auth: "user", rateLimit: rateLimitByIp({ max: 10, timeWindow: "1 minute" }) },
      schema: { response: { 204: noContent, ...errorResponses } }
    },
    async (request, reply) => {
      const user = authUser(request);
      const now = app.clock.now();
      await app.db.transaction(async (tx) => {
        const revoked = await revokeSessions(
          tx,
          { userId: user.id, exceptSessionId: user.sessionId },
          "revoke_others",
          now
        );
        await recordAudit(tx, {
          actorUserId: user.id,
          action: AuthAuditAction.SessionsRevoked,
          entityType: "user",
          entityId: user.id,
          metadata: { scope: "others", count: revoked.length },
          ip: request.ip
        });
      });
      return reply.code(204).send(null);
    }
  );
};

export default sessionRoutes;
