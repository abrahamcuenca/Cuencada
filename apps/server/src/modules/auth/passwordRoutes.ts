/**
 * Change password (logged in) and password reset by email [SEC].
 */
import {
  apiErrorSchema,
  authTokenResponseSchema,
  changePasswordInputSchema,
  okResponseSchema,
  passwordResetConfirmInputSchema,
  passwordResetRequestInputSchema
} from "@cuencada/types";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { magicLinks, users } from "../../db/schema/index.js";
import { recordAudit, type Transaction } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { AppLinkPath, appLink, sendTemplate } from "../../lib/mailer/index.js";
import { hashPassword, verifyDummyPassword, verifyPassword } from "../../lib/passwords.js";
import { credentialRateLimits, extraRateLimitHook, ipKey, rateLimitByIp } from "../../lib/rateLimit.js";
import { authUser } from "../../plugins/auth.js";
import { issueAuthResponse } from "./currentUser.js";
import {
  AuthAuditAction,
  consumeEmailToken,
  createEmailToken,
  EMAIL_TOKEN_TTL_MINUTES,
  markEmailVerified,
  sendInBackground
} from "./emailTokens.js";
import { revokeSessions, sessionOrigin, startSession } from "./sessions.js";

const noContent = z.null().describe("No content");

const errorResponses = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  429: apiErrorSchema
} as const;

/**
 * Queue the "your password changed" notice (no button, names the support contact).
 *
 * @param app - The app (mailer, jobs, config).
 * @param to - The account's address.
 * @param displayName - Greeting name.
 * @param changedAt - When the change happened.
 * @param operationId - Stable id for the idempotency key (never a token).
 */
export function queuePasswordChangedEmail(
  app: FastifyInstance,
  to: string,
  displayName: string,
  changedAt: Date,
  operationId: string
): void {
  sendInBackground(app, "mail.password-changed", () =>
    sendTemplate(
      app,
      to,
      { kind: "password-changed", props: { displayName, changedAt, supportContact: app.config.SUPPORT_EMAIL } },
      { idempotencyKey: `password-changed:${operationId}` }
    )
  );
}

/** Burn every outstanding password-reset link of a user (after any password change). */
async function invalidateResetLinks(tx: Transaction, userId: string, now: Date): Promise<void> {
  await tx
    .update(magicLinks)
    .set({ usedAt: now })
    .where(and(eq(magicLinks.userId, userId), eq(magicLinks.purpose, "password_reset"), isNull(magicLinks.usedAt)));
}

/** Password routes, mounted under `/api`. */
const passwordRoutes: FastifyPluginAsyncZod = async (app) => {
  const resetRequestLimits = credentialRateLimits(app);

  /**
   * `POST /api/auth/change-password` (allowed while a change is pending).
   * Revokes every session (`password_changed`), starts a fresh one for this
   * device, and returns a new `AuthTokenResponse` + refresh cookie.
   */
  app.post(
    "/auth/change-password",
    {
      config: {
        auth: "user",
        allowPendingPasswordChange: true,
        // The body has no email, so the credential limiter's email keys would be
        // shared by every user; limit per IP here and per user in preHandler.
        rateLimit: rateLimitByIp({ max: 20, timeWindow: "15 minutes" })
      },
      preHandler: extraRateLimitHook(app, {
        max: 10,
        timeWindow: "15 minutes",
        keyGenerator: (request) => `change-password-user:${request.user?.id ?? ipKey(request)}`
      }),
      schema: {
        body: changePasswordInputSchema,
        response: { 200: authTokenResponseSchema, ...errorResponses }
      }
    },
    async (request, reply) => {
      const current = authUser(request);
      const [user] = await app.db
        .select({ passwordHash: users.passwordHash, email: users.email, displayName: users.displayName })
        .from(users)
        .where(eq(users.id, current.id))
        .limit(1);
      const currentOk =
        user?.passwordHash != null
          ? await verifyPassword(user.passwordHash, request.body.currentPassword)
          : await verifyDummyPassword(request.body.currentPassword);
      if (user === undefined || !currentOk) {
        // 400, not 401: a 401 would make the web client try to refresh.
        throw new AppError("VALIDATION", undefined, {
          details: [{ path: "currentPassword", message: "La contraseña actual no es correcta." }]
        });
      }

      const passwordHash = await hashPassword(request.body.newPassword);
      const now = app.clock.now();
      const issued = await app.db.transaction(async (tx) => {
        await tx
          .update(users)
          .set({ passwordHash, mustChangePassword: false, passwordChangedAt: now })
          .where(eq(users.id, current.id));
        const revoked = await revokeSessions(tx, { userId: current.id }, "password_changed", now);
        await invalidateResetLinks(tx, current.id, now);
        const started = await startSession(tx, app.config, current.id, sessionOrigin(request), now);
        await recordAudit(tx, {
          actorUserId: current.id,
          action: AuthAuditAction.PasswordChanged,
          entityType: "user",
          entityId: current.id,
          metadata: { revokedSessions: revoked.length, newSessionId: started.sessionId },
          ip: request.ip
        });
        return started;
      });
      queuePasswordChangedEmail(app, user.email, user.displayName, now, issued.sessionId);
      return issueAuthResponse(app, reply, issued, current.id, now);
    }
  );

  /** `POST /api/auth/password-reset/request`: always 202; only active accounts get an email. */
  app.post(
    "/auth/password-reset/request",
    {
      config: { auth: "public", rateLimit: resetRequestLimits.rateLimit },
      preHandler: resetRequestLimits.preHandler,
      schema: { body: passwordResetRequestInputSchema, response: { 202: okResponseSchema, ...errorResponses } }
    },
    async (request, reply) => {
      const { email } = request.body;
      const [user] = await app.db
        .select({ id: users.id, email: users.email, displayName: users.displayName, status: users.status })
        .from(users)
        .where(sql`lower(${users.email}) = ${email}`)
        .limit(1);
      if (user !== undefined && user.status === "active") {
        const now = app.clock.now();
        const created = await app.db.transaction(async (tx) => {
          const token = await createEmailToken(tx, {
            userId: user.id,
            email: user.email,
            purpose: "password_reset",
            requestIp: request.ip,
            now
          });
          await recordAudit(tx, {
            actorUserId: null,
            action: AuthAuditAction.PasswordResetRequested,
            entityType: "user",
            entityId: user.id,
            ip: request.ip
          });
          return token;
        });
        sendInBackground(app, "mail.password-reset", () =>
          sendTemplate(
            app,
            user.email,
            {
              kind: "password-reset",
              props: {
                displayName: user.displayName,
                resetUrl: appLink(app.config, AppLinkPath.PasswordReset, created.token),
                expiresInMinutes: EMAIL_TOKEN_TTL_MINUTES.password_reset
              }
            },
            { idempotencyKey: `password-reset:${created.id}` }
          )
        );
      }
      return reply.code(202).send({ ok: true });
    }
  );

  /**
   * `POST /api/auth/password-reset/confirm`: single-use token + new password.
   * Revokes **every** session and does not log in (contract: 204).
   */
  app.post(
    "/auth/password-reset/confirm",
    {
      // Tokens carry 256 bits, so guessing is hopeless; the IP cap bounds abuse.
      config: { auth: "public", rateLimit: rateLimitByIp({ max: 10, timeWindow: "15 minutes" }) },
      schema: { body: passwordResetConfirmInputSchema, response: { 204: noContent, ...errorResponses } }
    },
    async (request, reply) => {
      const passwordHash = await hashPassword(request.body.newPassword);
      const now = app.clock.now();
      const result = await app.db.transaction(async (tx) => {
        const consumed = await consumeEmailToken(tx, request.body.token, "password_reset", now);
        if (consumed === null) return null;
        const [user] = await tx
          .update(users)
          .set({ passwordHash, mustChangePassword: false, passwordChangedAt: now })
          .where(eq(users.id, consumed.userId))
          .returning({ email: users.email, displayName: users.displayName });
        if (!user) throw new Error("password-reset confirm: user update returned no row");
        await markEmailVerified(tx, consumed, now);
        const revoked = await revokeSessions(tx, { userId: consumed.userId }, "password_reset", now);
        await invalidateResetLinks(tx, consumed.userId, now);
        await recordAudit(tx, {
          actorUserId: consumed.userId,
          action: AuthAuditAction.PasswordReset,
          entityType: "user",
          entityId: consumed.userId,
          metadata: { revokedSessions: revoked.length },
          ip: request.ip
        });
        return { ...user, operationId: consumed.tokenId };
      });
      if (result === null) throw new AppError("TOKEN_INVALID");
      queuePasswordChangedEmail(app, result.email, result.displayName, now, result.operationId);
      return reply.code(204).send(null);
    }
  );
};

export default passwordRoutes;
