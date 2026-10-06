/**
 * Admin user management [SEC]: list, role/status changes, session
 * revocation, forced password reset and manual email verification.
 *
 * Every mutation runs in one transaction that first takes the admin-users
 * advisory lock ({@link lockAdminUserChanges}), re-checks that the caller is
 * still an active admin, locks the target row, applies the guardrails and
 * writes one audit row (ids, field names and counts only; never PII values).
 */
import {
  type AdminForcePasswordResetResult,
  type AdminUserListItem,
  AuditAction,
  adminForcePasswordResetResultSchema,
  adminUserListItemSchema,
  adminUserListQuerySchema,
  adminUserPatchInputSchema,
  apiErrorSchema,
  idParamSchema,
  type Page,
  pageSchema
} from "@cuencada/types";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { users } from "../../db/schema/index.js";
import { recordAudit } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { AppLinkPath, appLink, sendTemplate } from "../../lib/mailer/index.js";
import { extraRateLimitHook, type RateLimitHook, rateLimitByIp } from "../../lib/rateLimit.js";
import { authUser } from "../../plugins/auth.js";
import {
  burnPendingEmailTokens,
  EMAIL_TOKEN_TTL_MINUTES,
  issueBudgetedEmailToken,
  sendInBackground
} from "../auth/emailTokens.js";
import { revokeSessions } from "../auth/sessions.js";
import {
  AdminUserMessages,
  countOtherActiveAdmins,
  getAdminUser,
  listAdminUsers,
  lockAdminUserChanges,
  lockTargetUser
} from "./users.js";

/** Admin mutations allowed per admin (and per IP) per minute. */
export const ADMIN_MUTATION_LIMIT = { max: 60, timeWindow: "1 minute" } as const;

const SELF_ACCOUNT_MESSAGE = "Para tu propia cuenta usa la sección de seguridad de tu perfil.";

const noContent = z.null().describe("No content");

const errorResponses = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  429: apiErrorSchema
} as const;

/**
 * Close the user's live chat sockets after a disable or revocation.
 *
 * TODO(T7): call `closeSocketsForUser(app, userId)` from `modules/chat` once
 * T7 lands on main. Until then a socket opened before the disable keeps
 * running until it reconnects (the ticket and REST guard already refuse it).
 *
 * @param _app - The app.
 * @param _userId - The user whose sockets should close.
 */
function closeChatSockets(_app: FastifyInstance, _userId: string): void {
  // Intentionally empty until T7's helper exists (see TODO above).
}

/**
 * Per-admin limiter shared by every admin user mutation (one counter per
 * admin across these routes), on top of the per-IP route limit.
 *
 * @param app - The plugin instance (rate-limit factory).
 */
function perAdminLimit(app: FastifyInstance): RateLimitHook {
  return extraRateLimitHook(app, {
    ...ADMIN_MUTATION_LIMIT,
    keyGenerator: (request: FastifyRequest) => `admin-mutation:${request.user?.id ?? request.ip}`
  });
}

/** Admin user routes, mounted under `/api`. */
const adminUserRoutes: FastifyPluginAsyncZod = async (app) => {
  const mutationConfig = { auth: "admin", rateLimit: rateLimitByIp(ADMIN_MUTATION_LIMIT) } as const;
  const adminLimit = perAdminLimit(app);

  /** `GET /api/admin/users`: newest first, keyset-paginated, search on name/email. */
  app.get(
    "/admin/users",
    {
      config: { auth: "admin" },
      schema: { querystring: adminUserListQuerySchema, response: { 200: pageSchema(adminUserListItemSchema), ...errorResponses } }
    },
    async (request): Promise<Page<AdminUserListItem>> => {
      const { q, role, status, cursor, limit } = request.query;
      return listAdminUsers(app.db, { q, role, status, cursor, limit, now: app.clock.now() });
    }
  );

  /**
   * `PATCH /api/admin/users/:id`: role, status and/or `mustChangePassword`.
   * Disabling revokes every session (`user_disabled`) and burns pending email
   * tokens. The caller cannot change their own role or status (403), and the
   * last active admin cannot be demoted or disabled (409).
   */
  app.patch(
    "/admin/users/:id",
    {
      config: mutationConfig,
      preHandler: adminLimit,
      schema: {
        params: idParamSchema,
        body: adminUserPatchInputSchema,
        response: { 200: adminUserListItemSchema, ...errorResponses, 409: apiErrorSchema }
      }
    },
    async (request): Promise<AdminUserListItem> => {
      const admin = authUser(request);
      const input = request.body;
      const targetId = request.params.id;
      const now = app.clock.now();

      const disabled = await app.db.transaction(async (tx) => {
        await lockAdminUserChanges(tx);
        const target = await lockTargetUser(tx, admin.id, targetId);
        const nextRole = input.role ?? target.role;
        const nextStatus = input.status ?? target.status;
        const roleChanged = nextRole !== target.role;
        const statusChanged = nextStatus !== target.status;

        if (target.id === admin.id && (roleChanged || statusChanged)) {
          throw new AppError("FORBIDDEN", AdminUserMessages.SelfChange);
        }
        const losesAdmin =
          target.role === "admin" && target.status === "active" && (nextRole !== "admin" || nextStatus !== "active");
        if (losesAdmin && (await countOtherActiveAdmins(tx, target.id)) === 0) {
          throw new AppError("CONFLICT", AdminUserMessages.LastAdmin);
        }

        const mustChangeChanged = input.mustChangePassword === true && !target.mustChangePassword;
        const fields: string[] = [];
        if (roleChanged) fields.push("role");
        if (statusChanged) fields.push("status");
        if (mustChangeChanged) fields.push("mustChangePassword");
        if (fields.length === 0) return false;

        await tx
          .update(users)
          .set({
            ...(roleChanged ? { role: nextRole } : {}),
            ...(statusChanged ? { status: nextStatus } : {}),
            ...(mustChangeChanged ? { mustChangePassword: true } : {})
          })
          .where(eq(users.id, target.id));

        const disabling = statusChanged && nextStatus === "disabled";
        const metadata: Record<string, unknown> = { fields };
        if (roleChanged) metadata.role = { from: target.role, to: nextRole };
        // Metadata keys containing "token" are redacted by recordAudit, hence "EmailLinks".
        if (disabling) {
          const revoked = await revokeSessions(tx, { userId: target.id }, "user_disabled", now);
          metadata.revokedSessions = revoked.length;
          metadata.burnedEmailLinks = await burnPendingEmailTokens(tx, target.id, now);
        }
        const action = disabling
          ? AuditAction.UserDisabled
          : statusChanged
            ? AuditAction.UserEnabled
            : AuditAction.UserUpdated;
        await recordAudit(tx, {
          actorUserId: admin.id,
          action,
          entityType: "user",
          entityId: target.id,
          metadata,
          ip: request.ip
        });
        return disabling;
      });

      if (disabled) closeChatSockets(app, targetId);
      return getAdminUser(app.db, targetId, app.clock.now());
    }
  );

  /** `POST /api/admin/users/:id/revoke-sessions`: revoke every live session (`admin_revoked`). */
  app.post(
    "/admin/users/:id/revoke-sessions",
    {
      config: mutationConfig,
      preHandler: adminLimit,
      schema: { params: idParamSchema, response: { 204: noContent, ...errorResponses } }
    },
    async (request, reply) => {
      const admin = authUser(request);
      const targetId = request.params.id;
      if (targetId === admin.id) throw new AppError("FORBIDDEN", SELF_ACCOUNT_MESSAGE);
      const now = app.clock.now();
      await app.db.transaction(async (tx) => {
        await lockAdminUserChanges(tx);
        const target = await lockTargetUser(tx, admin.id, targetId);
        const revoked = await revokeSessions(tx, { userId: target.id }, "admin_revoked", now);
        await recordAudit(tx, {
          actorUserId: admin.id,
          action: AuditAction.UserSessionsRevoked,
          entityType: "user",
          entityId: target.id,
          metadata: { revokedSessions: revoked.length },
          ip: request.ip
        });
      });
      closeChatSockets(app, targetId);
      return reply.code(204).send(null);
    }
  );

  /**
   * `POST /api/admin/users/:id/force-password-reset`: sets
   * `mustChangePassword`, revokes every session, burns pending email tokens
   * and (for active accounts, within T1's email budgets) queues a reset email.
   */
  app.post(
    "/admin/users/:id/force-password-reset",
    {
      config: mutationConfig,
      preHandler: adminLimit,
      schema: { params: idParamSchema, response: { 200: adminForcePasswordResetResultSchema, ...errorResponses } }
    },
    async (request): Promise<AdminForcePasswordResetResult> => {
      const admin = authUser(request);
      const targetId = request.params.id;
      if (targetId === admin.id) throw new AppError("FORBIDDEN", SELF_ACCOUNT_MESSAGE);
      const now = app.clock.now();

      const outcome = await app.db.transaction(async (tx) => {
        await lockAdminUserChanges(tx);
        const target = await lockTargetUser(tx, admin.id, targetId);
        await tx.update(users).set({ mustChangePassword: true }).where(eq(users.id, target.id));
        const revoked = await revokeSessions(tx, { userId: target.id }, "admin_revoked", now);
        const burned = await burnPendingEmailTokens(tx, target.id, now);
        const token =
          target.status === "active"
            ? await issueBudgetedEmailToken(app, tx, {
                userId: target.id,
                email: target.email,
                purpose: "password_reset",
                requestIp: request.ip,
                now
              })
            : null;
        await recordAudit(tx, {
          actorUserId: admin.id,
          action: AuditAction.UserPasswordResetForced,
          entityType: "user",
          entityId: target.id,
          metadata: { revokedSessions: revoked.length, burnedEmailLinks: burned, emailQueued: token !== null },
          ip: request.ip
        });
        return { target, token };
      });

      const { target, token } = outcome;
      if (token !== null) {
        sendInBackground(app, "mail.admin-password-reset", () =>
          sendTemplate(
            app,
            target.email,
            {
              kind: "password-reset",
              props: {
                displayName: target.displayName,
                resetUrl: appLink(app.config, AppLinkPath.PasswordReset, token.token),
                expiresInMinutes: EMAIL_TOKEN_TTL_MINUTES.password_reset
              }
            },
            { idempotencyKey: `password-reset:${token.id}` }
          )
        );
      }
      closeChatSockets(app, targetId);
      return { user: await getAdminUser(app.db, targetId, app.clock.now()), emailQueued: token !== null };
    }
  );

  /**
   * `POST /api/admin/users/:id/verify-email`: mark the address verified by
   * hand (relatives who cannot receive email). Idempotent: an already
   * verified address keeps its original time and writes no audit row.
   */
  app.post(
    "/admin/users/:id/verify-email",
    {
      config: mutationConfig,
      preHandler: adminLimit,
      schema: { params: idParamSchema, response: { 200: adminUserListItemSchema, ...errorResponses } }
    },
    async (request): Promise<AdminUserListItem> => {
      const admin = authUser(request);
      const targetId = request.params.id;
      const now = app.clock.now();
      await app.db.transaction(async (tx) => {
        await lockAdminUserChanges(tx);
        const target = await lockTargetUser(tx, admin.id, targetId);
        if (target.emailVerifiedAt !== null) return;
        await tx.update(users).set({ emailVerifiedAt: now }).where(eq(users.id, target.id));
        await recordAudit(tx, {
          actorUserId: admin.id,
          action: AuditAction.UserEmailVerifiedByAdmin,
          entityType: "user",
          entityId: target.id,
          metadata: { fields: ["emailVerified"] },
          ip: request.ip
        });
      });
      return getAdminUser(app.db, targetId, app.clock.now());
    }
  );
};

export default adminUserRoutes;
