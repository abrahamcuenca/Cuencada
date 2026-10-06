/**
 * Magic-link login and email verification [SEC]. Tokens travel in the link's
 * URL fragment (`#t=…`) and are POSTed back by the SPA.
 */
import {
  apiErrorSchema,
  authTokenResponseSchema,
  emailVerifyConfirmInputSchema,
  magicLinkConsumeInputSchema,
  magicLinkRequestInputSchema,
  okResponseSchema
} from "@cuencada/types";
import { eq, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { users } from "../../db/schema/index.js";
import { recordAudit } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { AppLinkPath, appLink, sendTemplate } from "../../lib/mailer/index.js";
import { credentialRateLimits, ipKey, rateLimitByIp } from "../../lib/rateLimit.js";
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
import { sessionOrigin, startSession } from "./sessions.js";

const noContent = z.null().describe("No content");

const errorResponses = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  429: apiErrorSchema
} as const;

/** Email-token routes, mounted under `/api`. */
const emailRoutes: FastifyPluginAsyncZod = async (app) => {
  const magicLinkLimits = credentialRateLimits(app);

  /** `POST /api/auth/magic-link/request`: always 202; only active accounts get an email. */
  app.post(
    "/auth/magic-link/request",
    {
      config: { auth: "public", rateLimit: magicLinkLimits.rateLimit },
      preHandler: magicLinkLimits.preHandler,
      schema: { body: magicLinkRequestInputSchema, response: { 202: okResponseSchema, ...errorResponses } }
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
            purpose: "login",
            requestIp: request.ip,
            now
          });
          await recordAudit(tx, {
            actorUserId: null,
            action: AuthAuditAction.MagicLinkRequested,
            entityType: "user",
            entityId: user.id,
            ip: request.ip
          });
          return token;
        });
        sendInBackground(app, "mail.magic-link", () =>
          sendTemplate(
            app,
            user.email,
            {
              kind: "magic-link",
              props: {
                displayName: user.displayName,
                loginUrl: appLink(app.config, AppLinkPath.MagicLink, created.token),
                expiresInMinutes: EMAIL_TOKEN_TTL_MINUTES.login
              }
            },
            { idempotencyKey: `magic-link:${created.id}` }
          )
        );
      }
      return reply.code(202).send({ ok: true });
    }
  );

  /** `POST /api/auth/magic-link/consume`: single-use token → session like login. */
  app.post(
    "/auth/magic-link/consume",
    {
      config: { auth: "public", rateLimit: rateLimitByIp({ max: 20, timeWindow: "15 minutes" }) },
      schema: { body: magicLinkConsumeInputSchema, response: { 200: authTokenResponseSchema, ...errorResponses } }
    },
    async (request, reply) => {
      const now = app.clock.now();
      const issued = await app.db.transaction(async (tx) => {
        const consumed = await consumeEmailToken(tx, request.body.token, "login", now);
        if (consumed === null) return null;
        await markEmailVerified(tx, consumed, now);
        await tx.update(users).set({ lastLoginAt: now }).where(eq(users.id, consumed.userId));
        const started = await startSession(tx, app.config, consumed.userId, sessionOrigin(request), now);
        await recordAudit(tx, {
          actorUserId: consumed.userId,
          action: AuthAuditAction.LoggedIn,
          entityType: "session",
          entityId: started.sessionId,
          metadata: { method: "magic_link" },
          ip: request.ip
        });
        return { started, userId: consumed.userId };
      });
      if (issued === null) throw new AppError("TOKEN_INVALID");
      return issueAuthResponse(app, reply, issued.started, issued.userId, now);
    }
  );

  /** `POST /api/auth/email/verify-request`: email a verification link to the caller (202). */
  app.post(
    "/auth/email/verify-request",
    {
      config: {
        auth: "user",
        // Keyed per user after the guard has run (preHandler), so a shared IP is not penalized.
        rateLimit: {
          max: 3,
          timeWindow: "15 minutes",
          hook: "preHandler",
          keyGenerator: (request) => `verify-request-user:${request.user?.id ?? ipKey(request)}`
        }
      },
      schema: { response: { 202: okResponseSchema, ...errorResponses } }
    },
    async (request, reply) => {
      const user = authUser(request);
      if (!user.emailVerified) {
        const now = app.clock.now();
        const created = await app.db.transaction(async (tx) => {
          const token = await createEmailToken(tx, {
            userId: user.id,
            email: user.email,
            purpose: "email_verify",
            requestIp: request.ip,
            now
          });
          await recordAudit(tx, {
            actorUserId: user.id,
            action: AuthAuditAction.EmailVerificationRequested,
            entityType: "user",
            entityId: user.id,
            ip: request.ip
          });
          return token;
        });
        sendInBackground(app, "mail.verify-email", () =>
          sendTemplate(
            app,
            user.email,
            {
              kind: "verify-email",
              props: {
                displayName: user.displayName,
                verifyUrl: appLink(app.config, AppLinkPath.VerifyEmail, created.token),
                expiresInMinutes: EMAIL_TOKEN_TTL_MINUTES.email_verify
              }
            },
            { idempotencyKey: `verify-email:${created.id}` }
          )
        );
      }
      return reply.code(202).send({ ok: true });
    }
  );

  /** `POST /api/auth/email/verify`: single-use token → `email_verified_at` (204). */
  app.post(
    "/auth/email/verify",
    {
      config: { auth: "public", rateLimit: rateLimitByIp({ max: 20, timeWindow: "15 minutes" }) },
      schema: { body: emailVerifyConfirmInputSchema, response: { 204: noContent, ...errorResponses } }
    },
    async (request, reply) => {
      const now = app.clock.now();
      const verified = await app.db.transaction(async (tx) => {
        const consumed = await consumeEmailToken(tx, request.body.token, "email_verify", now);
        if (consumed === null || !(await markEmailVerified(tx, consumed, now))) return false;
        await recordAudit(tx, {
          actorUserId: consumed.userId,
          action: AuthAuditAction.EmailVerified,
          entityType: "user",
          entityId: consumed.userId,
          ip: request.ip
        });
        return true;
      });
      if (!verified) throw new AppError("TOKEN_INVALID");
      return reply.code(204).send(null);
    }
  );
};

export default emailRoutes;
