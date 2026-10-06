/**
 * Auth module (T1 owns this folder).
 *
 * WP-0.4 keeps the scaffold's routes working on the new platform: login now
 * creates a DB session (the guard needs `sid`), but it does **not** issue the
 * refresh cookie yet. T1 replaces these with the full contract
 * (`AuthTokenResponse`, refresh rotation, logout, magic links, sessions).
 */
import {
  AuditAction,
  changePasswordInputSchema,
  loginInputSchema,
  magicLinkRequestInputSchema,
  okResponseSchema
} from "@cuencada/types";
import { eq, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { sessions, users } from "../../db/schema/index.js";
import { recordAudit } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { hashPassword, needsRehash, verifyDummyPassword, verifyPassword } from "../../lib/passwords.js";
import { credentialRateLimits, rateLimitByIp, rateLimitByIpAndEmail } from "../../lib/rateLimit.js";
import { accessTokenSettings, signAccessToken } from "../../lib/tokens.js";
import { authUser } from "../../plugins/auth.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const USER_AGENT_MAX = 512;

/** Auth routes under `/api`. */
const authModule: FastifyPluginAsyncZod = async (app) => {
  const tokenSettings = accessTokenSettings(app.config);
  const loginLimits = credentialRateLimits(app);

  app.post(
    "/auth/login",
    {
      config: { auth: "public", rateLimit: loginLimits.rateLimit },
      preHandler: loginLimits.preHandler,
      schema: { body: loginInputSchema }
    },
    async (request) => {
      const { email, password } = request.body;
      const [user] = await app.db
        .select()
        .from(users)
        .where(sql`lower(${users.email}) = ${email}`)
        .limit(1);

      // Same argon2 cost whether or not the account exists (no enumeration by timing).
      const passwordOk =
        user?.passwordHash != null
          ? await verifyPassword(user.passwordHash, password)
          : await verifyDummyPassword(password);
      if (user === undefined || !passwordOk || user.status !== "active" || user.passwordHash === null) {
        throw new AppError("INVALID_CREDENTIALS");
      }

      const now = app.clock.now();
      const [session] = await app.db.transaction(async (tx) => {
        const userUpdate: Partial<typeof users.$inferInsert> = { lastLoginAt: now };
        if (user.passwordHash !== null && needsRehash(user.passwordHash)) {
          userUpdate.passwordHash = await hashPassword(password);
        }
        await tx.update(users).set(userUpdate).where(eq(users.id, user.id));
        return tx
          .insert(sessions)
          .values({
            userId: user.id,
            userAgent: request.headers["user-agent"]?.slice(0, USER_AGENT_MAX) ?? null,
            ipAddress: request.ip,
            lastUsedAt: now,
            idleExpiresAt: new Date(now.getTime() + app.config.REFRESH_IDLE_DAYS * DAY_MS),
            absoluteExpiresAt: new Date(now.getTime() + app.config.REFRESH_ABSOLUTE_DAYS * DAY_MS)
          })
          .returning({ id: sessions.id });
      });
      if (session === undefined) throw new Error("login: session insert returned no row");

      const signed = await signAccessToken(
        tokenSettings,
        { userId: user.id, sessionId: session.id, role: user.role, mustChangePassword: user.mustChangePassword },
        now
      );
      return {
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          role: user.role,
          mustChangePassword: user.mustChangePassword
        },
        accessToken: signed.token,
        accessTokenExpiresAt: signed.expiresAt.toISOString()
      };
    }
  );

  app.get("/me", { config: { auth: "user", allowPendingPasswordChange: true } }, async (request) => {
    const user = authUser(request);
    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        mustChangePassword: user.mustChangePassword
      }
    };
  });

  app.post(
    "/auth/change-password",
    {
      config: {
        auth: "user",
        allowPendingPasswordChange: true,
        rateLimit: rateLimitByIp({ max: 10, timeWindow: "15 minutes" })
      },
      schema: { body: changePasswordInputSchema, response: { 200: okResponseSchema } }
    },
    async (request) => {
      const current = authUser(request);
      const [user] = await app.db
        .select({ passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, current.id))
        .limit(1);
      if (user?.passwordHash == null || !(await verifyPassword(user.passwordHash, request.body.currentPassword))) {
        throw new AppError("VALIDATION", undefined, {
          details: [{ path: "currentPassword", message: "La contraseña actual no es correcta." }]
        });
      }

      const passwordHash = await hashPassword(request.body.newPassword);
      const now = app.clock.now();
      await app.db.transaction(async (tx) => {
        await tx
          .update(users)
          .set({ passwordHash, mustChangePassword: false, passwordChangedAt: now })
          .where(eq(users.id, current.id));
        await recordAudit(tx, {
          actorUserId: current.id,
          action: AuditAction.PasswordChanged,
          entityType: "user",
          entityId: current.id,
          ip: request.ip
        });
      });
      return { ok: true } as const;
    }
  );

  app.post(
    "/auth/magic-link/request",
    {
      config: { auth: "public", rateLimit: rateLimitByIpAndEmail({ max: 5, timeWindow: "15 minutes" }) },
      schema: { body: magicLinkRequestInputSchema, response: { 202: okResponseSchema } }
    },
    async (_request, reply) => {
      // Sending is implemented by T1. The answer is always the same generic
      // 202, whether or not the email has an account (no enumeration).
      return reply.code(202).send({ ok: true });
    }
  );
};

export default authModule;
