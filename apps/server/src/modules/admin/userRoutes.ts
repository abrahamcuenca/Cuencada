/**
 * Admin user management [SEC]: list, role/status changes, session
 * revocation, forced password reset, manual email verification and (WP-7)
 * two-step verification reset.
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
  pageSchema,
  type UserRole
} from "@cuencada/types";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { CreatedEmailToken } from "../auth/emailTokens.js";
import type { LockedUser } from "./users.js";
import { AdminAccountChange, TwoFactorNotice } from "@cuencada/emails";
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
import { closeChatSockets as closeUserChatSockets } from "../auth/chatSockets.js";
import { chatUserRoleChanged } from "../chat/index.js";
import { revokeSessions } from "../auth/sessions.js";
import { isTwoFactorEnabled, queueTwoFactorNotice, removeTwoFactor, revokeTrustedDevices } from "../auth/twoFactor.js";
import { adminAlertMetadata, type AdminAlert, type AdminAlertPlan, planAdminAlert, queueAdminAlerts } from "./adminAlerts.js";
import {
  AdminUserMessages,
  countOtherActiveAdmins,
  countRecentRoleStatusChanges,
  isProtectiveChange,
  lastRecentRoleChange,
  getAdminUser,
  listAdminUsers,
  lockAdminUserChanges,
  lockTargetUser,
  TARGET_ROLE_STATUS_CHANGE_LIMIT
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
 * Close the user's live chat sockets after a disable or revocation (after
 * commit). Non-fatal: the chat hub's 5-minute re-check is the backstop.
 *
 * @param app - The app.
 * @param userId - The user whose sockets should close.
 */
function closeChatSockets(app: FastifyInstance, userId: string): void {
  closeUserChatSockets(app, { userId });
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

/** An alert decided inside a transaction, queued after commit. */
interface PendingAlert {
  plan: AdminAlertPlan;
  alert: AdminAlert;
}

/** Result of the PATCH transaction. */
interface PatchOutcome {
  disabled: boolean;
  /** The new role when it changed (event-room access in chat, WP-5.3). */
  newRole: UserRole | null;
  alert: PendingAlert | null;
}

/** Result of the force-reset transaction. */
interface ForceResetOutcome {
  target: LockedUser;
  token: CreatedEmailToken | null;
  alert: PendingAlert | null;
}

/** Inputs of {@link adminAccountChanges}. */
interface AccountChangeFacts {
  wasAdmin: boolean;
  nextRole: "admin" | "member";
  roleChanged: boolean;
  statusChanged: boolean;
  disabling: boolean;
  mustChangeChanged: boolean;
}

/**
 * The changes to an **administrator** account (before or after the patch)
 * that the other admins must hear about. Empty for member-only changes.
 *
 * @param facts - What the PATCH changed.
 */
function adminAccountChanges(facts: AccountChangeFacts): AdminAccountChange[] {
  if (!facts.wasAdmin && facts.nextRole !== "admin") return [];
  const changes: AdminAccountChange[] = [];
  if (facts.roleChanged) changes.push(facts.nextRole === "admin" ? "promoted" : "demoted");
  if (facts.statusChanged) changes.push(facts.disabling ? "disabled" : "enabled");
  if (facts.mustChangeChanged) changes.push("password_change_required");
  return changes;
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
      const { q, role, status, emailVerified, cursor, limit } = request.query;
      return listAdminUsers(app.db, { q, role, status, emailVerified, cursor, limit, now: app.clock.now() });
    }
  );

  /**
   * `PATCH /api/admin/users/:id`: role, status and/or `mustChangePassword`.
   * Disabling revokes every session (`user_disabled`) and burns pending email
   * tokens. The caller cannot change their own role or status (403), and the
   * last active admin cannot be demoted or disabled (409). At most
   * {@link TARGET_ROLE_STATUS_CHANGE_LIMIT} role/status changes per target
   * per hour, across all admins (429), except protective changes (disable,
   * re-promote after a recent demotion), which always go through.
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

      let promotedWithTwoFactor = false;
      const outcome = await app.db.transaction(async (tx): Promise<PatchOutcome> => {
        await lockAdminUserChanges(tx);
        const target = await lockTargetUser(tx, admin.id, targetId);
        const nextRole = input.role ?? target.role;
        const nextStatus = input.status ?? target.status;
        const roleChanged = nextRole !== target.role;
        const statusChanged = nextStatus !== target.status;

        if (target.id === admin.id && (roleChanged || statusChanged)) {
          throw new AppError("FORBIDDEN", AdminUserMessages.SelfChange);
        }
        // Defence in depth, unreachable today: the caller was just re-checked as an
        // active admin and cannot change themselves, so another active admin (the
        // caller) always exists. It keeps the invariant if a future path (a system
        // job, a script, or a relaxed self rule) reaches this code without that guarantee.
        const losesAdmin =
          target.role === "admin" && target.status === "active" && (nextRole !== "admin" || nextStatus !== "active");
        if (losesAdmin && (await countOtherActiveAdmins(tx, target.id)) === 0) {
          throw new AppError("CONFLICT", AdminUserMessages.LastAdmin);
        }
        if (
          (roleChanged || statusChanged) &&
          (await countRecentRoleStatusChanges(tx, target.id)) >= TARGET_ROLE_STATUS_CHANGE_LIMIT.max
        ) {
          // Over the limit: only protective changes (disable, restore a demoted admin) go through.
          const lastRecentRole = roleChanged ? await lastRecentRoleChange(tx, target.id) : null;
          if (!isProtectiveChange({ roleChanged, nextRole, statusChanged, nextStatus, lastRecentRole })) {
            throw new AppError("RATE_LIMITED", AdminUserMessages.TargetChangeLimit);
          }
        }

        const mustChangeChanged = input.mustChangePassword === true && !target.mustChangePassword;
        const fields: string[] = [];
        if (roleChanged) fields.push("role");
        if (statusChanged) fields.push("status");
        if (mustChangeChanged) fields.push("mustChangePassword");
        if (fields.length === 0) return { disabled: false, newRole: null, alert: null };

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
        // [SEC] WP-7: a promoted member must prove a code before using admin
        // access. Without 2FA the guard's enrollment gate stops their current
        // sessions; with 2FA, their sessions (perhaps from a trusted device,
        // without a code) are closed and trusted devices revoked, so the next
        // login asks for a code.
        if (roleChanged && nextRole === "admin" && !disabling && (await isTwoFactorEnabled(tx, target.id))) {
          const revoked = await revokeSessions(tx, { userId: target.id }, "admin_revoked", now);
          const devices = await revokeTrustedDevices(tx, target.id, now);
          metadata.revokedSessions = revoked.length;
          metadata.revokedTrustedDevices = devices.length;
          promotedWithTwoFactor = true;
        }
        // Metadata keys containing "token" are redacted by recordAudit, hence "EmailLinks".
        if (disabling) {
          const revoked = await revokeSessions(tx, { userId: target.id }, "user_disabled", now);
          metadata.revokedSessions = revoked.length;
          metadata.burnedEmailLinks = await burnPendingEmailTokens(tx, target.id, now);
        }
        const changes = adminAccountChanges({
          wasAdmin: target.role === "admin",
          nextRole,
          roleChanged,
          statusChanged,
          disabling,
          mustChangeChanged
        });
        const plan = changes.length > 0 ? await planAdminAlert(app, tx, { actorId: admin.id, target, changes, now }) : null;
        if (plan !== null) Object.assign(metadata, adminAlertMetadata(plan));
        const action = disabling
          ? AuditAction.UserDisabled
          : statusChanged
            ? AuditAction.UserEnabled
            : AuditAction.UserUpdated;
        const auditId = await recordAudit(tx, {
          actorUserId: admin.id,
          action,
          entityType: "user",
          entityId: target.id,
          metadata,
          ip: request.ip
        });
        const alert: PendingAlert | null =
          plan === null
            ? null
            : { plan, alert: { auditId, actorName: admin.displayName, targetName: target.displayName, changes, changedAt: now } };
        return { disabled: disabling, newRole: roleChanged ? nextRole : null, alert };
      });

      if (outcome.alert !== null) queueAdminAlerts(app, outcome.alert.plan, outcome.alert.alert);
      if (outcome.disabled || promotedWithTwoFactor) closeChatSockets(app, targetId);
      if (outcome.newRole !== null) chatUserRoleChanged(app, targetId, outcome.newRole);
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
    async (request, reply): Promise<void> => {
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
      await reply.code(204).send(null);
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

      const outcome = await app.db.transaction(async (tx): Promise<ForceResetOutcome> => {
        await lockAdminUserChanges(tx);
        const target = await lockTargetUser(tx, admin.id, targetId);
        // Only the first reset (flag false → true) is a lock-out worth an
        // always-sent alert; repeating it on an already-forced account counts
        // against the daily alert cap like any other change (quota burn).
        const flagFlipped = !target.mustChangePassword;
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
        const plan =
          target.role === "admin"
            ? await planAdminAlert(app, tx, {
                actorId: admin.id,
                target,
                changes: ["password_reset_forced"],
                now,
                capExempt: flagFlipped
              })
            : null;
        const auditId = await recordAudit(tx, {
          actorUserId: admin.id,
          action: AuditAction.UserPasswordResetForced,
          entityType: "user",
          entityId: target.id,
          metadata: {
            revokedSessions: revoked.length,
            burnedEmailLinks: burned,
            emailQueued: token !== null,
            ...(plan === null ? {} : adminAlertMetadata(plan))
          },
          ip: request.ip
        });
        const alert: PendingAlert | null =
          plan === null
            ? null
            : {
                plan,
                alert: {
                  auditId,
                  actorName: admin.displayName,
                  targetName: target.displayName,
                  changes: ["password_reset_forced"],
                  changedAt: now
                }
              };
        return { target, token, alert };
      });

      const { target, token, alert } = outcome;
      if (alert !== null) queueAdminAlerts(app, alert.plan, alert.alert);
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
   * `POST /api/admin/users/:id/2fa/reset` (WP-7): for a lost phone and lost
   * recovery codes. Never on yourself (403; another admin must do it). Deletes
   * the secret and recovery codes, revokes trusted devices and every session,
   * audits `user.2fa_reset`, alerts the other admins when the target is an
   * admin (cap-exempt, like a forced reset) and emails the target. 409 when
   * the account has no two-step verification.
   */
  app.post(
    "/admin/users/:id/2fa/reset",
    {
      config: mutationConfig,
      preHandler: adminLimit,
      schema: { params: idParamSchema, response: { 200: adminUserListItemSchema, ...errorResponses, 409: apiErrorSchema } }
    },
    async (request): Promise<AdminUserListItem> => {
      const admin = authUser(request);
      const targetId = request.params.id;
      if (targetId === admin.id) throw new AppError("FORBIDDEN", AdminUserMessages.SelfTwoFactorReset);
      const now = app.clock.now();
      const outcome = await app.db.transaction(async (tx) => {
        await lockAdminUserChanges(tx);
        const target = await lockTargetUser(tx, admin.id, targetId);
        const removed = await removeTwoFactor(tx, target.id, now);
        if (!removed.hadTwoFactor) throw new AppError("CONFLICT", AdminUserMessages.NoTwoFactor);
        const revoked = await revokeSessions(tx, { userId: target.id }, "admin_revoked", now);
        const changes = [AdminAccountChange.TwoFactorReset];
        const plan =
          target.role === "admin"
            ? await planAdminAlert(app, tx, { actorId: admin.id, target, changes, now, capExempt: true })
            : null;
        const auditId = await recordAudit(tx, {
          actorUserId: admin.id,
          action: AuditAction.UserTwoFactorReset,
          entityType: "user",
          entityId: target.id,
          metadata: {
            revokedSessions: revoked.length,
            revokedTrustedDevices: removed.revokedTrustedDevices,
            ...(plan === null ? {} : adminAlertMetadata(plan))
          },
          ip: request.ip
        });
        const alert: PendingAlert | null =
          plan === null
            ? null
            : { plan, alert: { auditId, actorName: admin.displayName, targetName: target.displayName, changes, changedAt: now } };
        return { target, auditId, alert };
      });
      if (outcome.alert !== null) queueAdminAlerts(app, outcome.alert.plan, outcome.alert.alert);
      closeChatSockets(app, targetId);
      if (outcome.target.status === "active") {
        await queueTwoFactorNotice(app, {
          to: outcome.target.email,
          displayName: outcome.target.displayName,
          notice: TwoFactorNotice.ResetByAdmin,
          at: now,
          operationId: outcome.auditId
        });
      }
      return getAdminUser(app.db, targetId, app.clock.now());
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
      // Verifying your own address by hand would bypass the email proof (Security review, PR #24).
      if (targetId === admin.id) throw new AppError("FORBIDDEN", AdminUserMessages.SelfVerify);
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
