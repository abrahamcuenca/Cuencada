/**
 * Two-step verification routes (WP-7, ADR 0001 §9) [SEC], mounted under `/api`:
 *
 * - `POST /auth/2fa/verify` (public): finish a login challenge → session.
 * - `GET /auth/2fa/status`, `POST /auth/2fa/setup`, `POST /auth/2fa/enable`
 *   (also open to an administrator who still has to enroll).
 * - `POST /auth/2fa/recovery-codes`, `POST /auth/2fa/disable` (members only).
 * - `GET /auth/2fa/trusted-devices`, `DELETE /auth/2fa/trusted-devices/:id`.
 *
 * Only `setup` ever returns the secret (URI, QR, manual key), and only
 * `enable`/`recovery-codes` return recovery codes; all three answer
 * `Cache-Control: no-store`. Wrong codes are a generic 400
 * `TWO_FACTOR_INVALID`; every check is rate limited per IP and per user.
 */
import {
  AuditAction,
  apiErrorSchema,
  authTokenResponseSchema,
  idParamSchema,
  TOTP_ISSUER,
  TRUSTED_DEVICES_LIST_MAX,
  type TrustedDevice,
  TWO_FACTOR_FRESH_LOGIN_MINUTES,
  type TwoFactorStatus,
  trustedDeviceSchema,
  twoFactorDisableInputSchema,
  twoFactorEnabledSchema,
  twoFactorEnableInputSchema,
  twoFactorRecoveryCodesSchema,
  twoFactorRegenerateInputSchema,
  twoFactorSetupInputSchema,
  twoFactorSetupSchema,
  twoFactorStatusSchema,
  twoFactorVerifyInputSchema
} from "@cuencada/types";
import { TwoFactorNotice } from "@cuencada/emails";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { sessions, users, userTotp } from "../../db/schema/index.js";
import { recordAudit, type Transaction } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { verifyDummyPassword, verifyPassword } from "../../lib/passwords.js";
import { extraRateLimitHook, ipKey, keyedRateLimit, type RateLimitHook, rateLimitByIp } from "../../lib/rateLimit.js";
import { hashToken } from "../../lib/tokens.js";
import { createTotpSecret, displayRecoveryCodes, encryptSecret, manualKey, qrSvgDataUri, totpKey, totpUri } from "../../lib/totp.js";
import { authUser } from "../../plugins/auth.js";
import { closeChatSockets } from "./chatSockets.js";
import { issueAccessResponse, issueAuthResponse } from "./currentUser.js";
import { AuthAuditAction } from "./emailTokens.js";
import { revokeSessions, sessionOrigin, startSession } from "./sessions.js";
import {
  challengeOwner,
  checkSecondFactor,
  checkTotp,
  clearTrustedDeviceCookie,
  consumeChallenge,
  createTrustedDevice,
  deviceLabel,
  failChallenge,
  isTwoFactorEnabled,
  liveTrustedDevices,
  lockChallenge,
  queueTwoFactorNotice,
  readTrustedDeviceCookie,
  remainingRecoveryCodes,
  removeTwoFactor,
  replaceRecoveryCodes,
  revokeTrustedDevices,
  setTrustedDeviceCookie
} from "./twoFactor.js";

/** Login verifications per client IP. */
export const TWO_FACTOR_VERIFY_IP_LIMIT = { max: 20, timeWindow: "15 minutes" } as const;
/**
 * Code checks per user, across challenges and IPs (like the login's per-email
 * cap): with 5 attempts per challenge this bounds online guessing to about 10
 * codes per 15 minutes per account, whatever the attacker does.
 */
export const TWO_FACTOR_USER_LIMIT = { max: 10, timeWindow: "15 minutes" } as const;

const MINUTE_MS = 60_000;

const noContent = z.null().describe("No content");

const errorResponses = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
  429: apiErrorSchema
} as const;

/** Spanish messages. */
export const TwoFactorMessages = {
  AlreadyEnabled: "Ya tienes activada la verificación en dos pasos.",
  NoPendingSetup: "Empieza de nuevo la activación de la verificación en dos pasos.",
  NotEnabled: "No tienes activada la verificación en dos pasos.",
  WrongPassword: "La contraseña actual no es correcta.",
  PasswordRequired: "Escribe tu contraseña actual.",
  AdminCannotDisable: "Los administradores no pueden desactivar la verificación en dos pasos."
} as const;

/** Never cache a response that carries a secret or recovery codes. */
function noStore(reply: FastifyReply): void {
  void reply.header("cache-control", "no-store");
}

/** What the caller's password check needs. */
interface PasswordOwner {
  passwordHash: string | null;
  email: string;
  displayName: string;
  role: "admin" | "member";
}

async function loadPasswordOwner(app: FastifyInstance, userId: string): Promise<PasswordOwner> {
  const [row] = await app.db
    .select({ passwordHash: users.passwordHash, email: users.email, displayName: users.displayName, role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (row === undefined) throw new AppError("UNAUTHENTICATED");
  return row;
}

/**
 * Re-authenticate with the current password (400 on a wrong one, like
 * change-password: a 401 would make the web client refresh).
 */
async function assertCurrentPassword(owner: PasswordOwner, password: string): Promise<void> {
  const ok =
    owner.passwordHash !== null ? await verifyPassword(owner.passwordHash, password) : await verifyDummyPassword(password);
  if (!ok) {
    throw new AppError("VALIDATION", undefined, { details: [{ path: "currentPassword", message: TwoFactorMessages.WrongPassword }] });
  }
}

/** Record a wrong code on an authenticated 2FA route (ids and enums only). */
async function auditFailure(tx: Transaction, userId: string, context: string, ip: string): Promise<void> {
  await recordAudit(tx, {
    actorUserId: userId,
    action: AuditAction.TwoFactorFailed,
    entityType: "user",
    entityId: userId,
    metadata: { context },
    ip
  });
}

/** Two-step verification routes, mounted under `/api`. */
const twoFactorRoutes: FastifyPluginAsyncZod = async (app) => {
  const verifyUserLimit = keyedRateLimit(app, "2fa-verify-user", TWO_FACTOR_USER_LIMIT);
  /** Per-user cap on authenticated code checks (setup, enable, regenerate, disable). */
  const perUserHook = (name: string): RateLimitHook =>
    extraRateLimitHook(app, {
      ...TWO_FACTOR_USER_LIMIT,
      keyGenerator: (request) => `2fa-${name}-user:${request.user?.id ?? ipKey(request)}`
    });
  const userRouteLimit = rateLimitByIp({ max: 30, timeWindow: "15 minutes" });

  /**
   * `POST /api/auth/2fa/verify`: answer a login challenge with a TOTP code or
   * a recovery code. Success issues the session exactly like a login
   * (refresh cookie + access token, `amr: ["otp"]`) and, for members who ask,
   * a trusted-device cookie. A wrong code counts an attempt (the fifth burns
   * the challenge) and answers 400 `TWO_FACTOR_INVALID`; an unusable
   * challenge answers 400 `TOKEN_INVALID`.
   */
  app.post(
    "/auth/2fa/verify",
    {
      config: { auth: "public", rateLimit: rateLimitByIp(TWO_FACTOR_VERIFY_IP_LIMIT) },
      schema: { body: twoFactorVerifyInputSchema, response: { 200: authTokenResponseSchema, ...errorResponses } }
    },
    async (request, reply) => {
      const body = request.body;
      // Per-user cap before any code is checked (the owner is read without a lock).
      const owner = await challengeOwner(app.db, body.challengeToken);
      if (owner !== null) await verifyUserLimit(request, owner);
      const now = app.clock.now();

      type VerifyOutcome =
        | { kind: "invalid" }
        | { kind: "wrong" }
        | {
            kind: "ok";
            userId: string;
            email: string;
            displayName: string;
            started: Awaited<ReturnType<typeof startSession>>;
            device: Awaited<ReturnType<typeof createTrustedDevice>> | null;
            recovery: { remaining: number; auditId: string } | null;
          };

      const outcome = await app.db.transaction(async (tx): Promise<VerifyOutcome> => {
        const challenge = await lockChallenge(tx, body.challengeToken, now);
        if (challenge === null) return { kind: "invalid" };
        const [user] = await tx
          .select({ id: users.id, role: users.role, status: users.status, email: users.email, displayName: users.displayName })
          .from(users)
          .where(eq(users.id, challenge.userId))
          .limit(1);
        if (user === undefined || user.status !== "active") return { kind: "invalid" };

        const factor = await checkSecondFactor(app, tx, user.id, body, now);
        if (!factor.ok) {
          const { attempts, burned } = await failChallenge(tx, challenge, now);
          await recordAudit(tx, {
            actorUserId: null,
            action: AuditAction.TwoFactorFailed,
            entityType: "user",
            entityId: user.id,
            metadata: { context: "login", challengeId: challenge.id, attempts, burned },
            ip: request.ip
          });
          return { kind: "wrong" };
        }

        await consumeChallenge(tx, challenge.id, now);
        await tx.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id));
        const started = await startSession(tx, app.config, user.id, sessionOrigin(request), now, { twoFactorVerifiedAt: now });
        // [SEC] Trusted devices are for members only; an admin's request is ignored.
        const device =
          body.trustDevice && user.role !== "admin"
            ? await createTrustedDevice(tx, user.id, deviceLabel(request.headers["user-agent"]), now)
            : null;
        await recordAudit(tx, {
          actorUserId: user.id,
          action: AuthAuditAction.LoggedIn,
          entityType: "session",
          entityId: started.sessionId,
          metadata: { method: challenge.method, factor: factor.factor },
          ip: request.ip
        });
        await recordAudit(tx, {
          actorUserId: user.id,
          action: AuditAction.TwoFactorVerified,
          entityType: "session",
          entityId: started.sessionId,
          metadata: { method: challenge.method, factor: factor.factor, challengeId: challenge.id, trustedDevice: device !== null },
          ip: request.ip
        });
        if (device !== null) {
          await recordAudit(tx, {
            actorUserId: user.id,
            action: AuditAction.TwoFactorTrustedDeviceAdded,
            entityType: "user",
            entityId: user.id,
            metadata: { deviceId: device.id },
            ip: request.ip
          });
        }
        let recovery: { remaining: number; auditId: string } | null = null;
        if (factor.factor === "recovery_code") {
          const auditId = await recordAudit(tx, {
            actorUserId: user.id,
            action: AuditAction.TwoFactorRecoveryCodeUsed,
            entityType: "user",
            entityId: user.id,
            metadata: { remaining: factor.remaining, context: "login" },
            ip: request.ip
          });
          recovery = { remaining: factor.remaining, auditId };
        }
        return { kind: "ok", userId: user.id, email: user.email, displayName: user.displayName, started, device, recovery };
      });

      if (outcome.kind === "invalid") throw new AppError("TOKEN_INVALID", "La verificación venció. Vuelve a iniciar sesión.");
      if (outcome.kind === "wrong") throw new AppError("TWO_FACTOR_INVALID");
      if (outcome.device !== null) setTrustedDeviceCookie(reply, app.config, outcome.device.token, outcome.device.expiresAt, now);
      if (outcome.recovery !== null) {
        await queueTwoFactorNotice(app, {
          to: outcome.email,
          displayName: outcome.displayName,
          notice: TwoFactorNotice.RecoveryCodeUsed,
          at: now,
          operationId: outcome.recovery.auditId,
          remainingCodes: outcome.recovery.remaining
        });
      }
      return issueAuthResponse(app, reply, outcome.started, outcome.userId, now);
    }
  );

  /** `GET /api/auth/2fa/status`: the caller's two-step state (open to admins still enrolling). */
  app.get(
    "/auth/2fa/status",
    {
      config: { auth: "user", allowPendingTwoFactor: true },
      schema: { response: { 200: twoFactorStatusSchema, ...errorResponses } }
    },
    async (request): Promise<TwoFactorStatus> => {
      const user = authUser(request);
      const [row] = await app.db
        .select({ enabledAt: userTotp.enabledAt })
        .from(userTotp)
        .where(eq(userTotp.userId, user.id))
        .limit(1);
      const enabledAt = row?.enabledAt ?? null;
      return {
        enabled: enabledAt !== null,
        enabledAt: enabledAt?.toISOString() ?? null,
        required: user.role === "admin",
        recoveryCodesRemaining: enabledAt === null ? 0 : await remainingRecoveryCodes(app.db, user.id),
        sessionVerified: user.twoFactorVerified,
        trustDeviceAllowed: user.role !== "admin"
      };
    }
  );

  /**
   * `POST /api/auth/2fa/setup`: re-authenticate (current password, or a login
   * less than {@link TWO_FACTOR_FRESH_LOGIN_MINUTES} minutes old), create a
   * **pending** encrypted secret and return it once as an otpauth URI, a QR
   * code and a manual key. Running it again replaces the pending secret.
   */
  app.post(
    "/auth/2fa/setup",
    {
      config: { auth: "user", allowPendingTwoFactor: true, rateLimit: userRouteLimit },
      preHandler: perUserHook("setup"),
      schema: { body: twoFactorSetupInputSchema, response: { 200: twoFactorSetupSchema, ...errorResponses } }
    },
    async (request, reply) => {
      const current = authUser(request);
      const owner = await loadPasswordOwner(app, current.id);
      const now = app.clock.now();
      if (request.body.currentPassword !== undefined) {
        await assertCurrentPassword(owner, request.body.currentPassword);
      } else {
        const [session] = await app.db
          .select({ createdAt: sessions.createdAt })
          .from(sessions)
          .where(eq(sessions.id, current.sessionId))
          .limit(1);
        const fresh = session !== undefined && now.getTime() - session.createdAt.getTime() <= TWO_FACTOR_FRESH_LOGIN_MINUTES * MINUTE_MS;
        if (!fresh) {
          throw new AppError("VALIDATION", undefined, {
            details: [{ path: "currentPassword", message: TwoFactorMessages.PasswordRequired }]
          });
        }
      }

      const secret = createTotpSecret();
      const encrypted = encryptSecret(totpKey(app.config), current.id, secret);
      await app.db.transaction(async (tx) => {
        const [existing] = await tx
          .select({ enabledAt: userTotp.enabledAt })
          .from(userTotp)
          .where(eq(userTotp.userId, current.id))
          .limit(1)
          .for("update");
        if (existing?.enabledAt != null) throw new AppError("CONFLICT", TwoFactorMessages.AlreadyEnabled);
        const values = {
          secretCiphertext: encrypted.ciphertext,
          secretIv: encrypted.iv,
          secretTag: encrypted.tag,
          enabledAt: null,
          lastUsedStep: null,
          createdAt: now
        };
        await tx
          .insert(userTotp)
          .values({ userId: current.id, ...values })
          .onConflictDoUpdate({ target: userTotp.userId, set: values });
        await recordAudit(tx, {
          actorUserId: current.id,
          action: AuditAction.TwoFactorSetupStarted,
          entityType: "user",
          entityId: current.id,
          metadata: { reauth: request.body.currentPassword === undefined ? "fresh_login" : "password" },
          ip: request.ip
        });
      });

      const uri = totpUri(owner.email, secret);
      noStore(reply);
      return {
        otpauthUri: uri,
        qrSvgDataUri: qrSvgDataUri(uri),
        manualKey: manualKey(secret),
        issuer: TOTP_ISSUER,
        accountName: owner.email
      };
    }
  );

  /**
   * `POST /api/auth/2fa/enable`: the first code proves the pending secret.
   * Enables 2FA, returns 10 recovery codes **once**, closes every other
   * session, revokes trusted devices, marks this session verified and
   * re-issues its access token (`amr: ["otp"]`). Emails a notice.
   */
  app.post(
    "/auth/2fa/enable",
    {
      config: { auth: "user", allowPendingTwoFactor: true, rateLimit: userRouteLimit },
      preHandler: perUserHook("enable"),
      schema: { body: twoFactorEnableInputSchema, response: { 200: twoFactorEnabledSchema, ...errorResponses } }
    },
    async (request, reply) => {
      const current = authUser(request);
      const now = app.clock.now();
      type EnableOutcome =
        | { kind: "no_setup" }
        | { kind: "wrong" }
        | { kind: "ok"; codes: string[]; revokedSessions: string[]; auditId: string };
      const outcome = await app.db.transaction(async (tx): Promise<EnableOutcome> => {
        const [row] = await tx
          .select({ enabledAt: userTotp.enabledAt })
          .from(userTotp)
          .where(eq(userTotp.userId, current.id))
          .limit(1)
          .for("update");
        if (row === undefined) return { kind: "no_setup" };
        if (row.enabledAt !== null) throw new AppError("CONFLICT", TwoFactorMessages.AlreadyEnabled);
        if (!(await checkTotp(app, tx, current.id, request.body.code, now, { pending: true }))) {
          await auditFailure(tx, current.id, "enable", request.ip);
          return { kind: "wrong" };
        }
        const codes = await replaceRecoveryCodes(tx, current.id, now);
        const revokedSessions = await revokeSessions(
          tx,
          { userId: current.id, exceptSessionId: current.sessionId },
          "revoke_others",
          now
        );
        const revokedDevices = await revokeTrustedDevices(tx, current.id, now);
        await tx.update(sessions).set({ twoFactorVerifiedAt: now }).where(eq(sessions.id, current.sessionId));
        const auditId = await recordAudit(tx, {
          actorUserId: current.id,
          action: AuditAction.TwoFactorEnabled,
          entityType: "user",
          entityId: current.id,
          metadata: { revokedSessions: revokedSessions.length, revokedTrustedDevices: revokedDevices.length },
          ip: request.ip
        });
        return { kind: "ok", codes, revokedSessions, auditId };
      });
      if (outcome.kind === "no_setup") throw new AppError("CONFLICT", TwoFactorMessages.NoPendingSetup);
      if (outcome.kind === "wrong") throw new AppError("TWO_FACTOR_INVALID");

      closeChatSockets(app, { sessionIds: outcome.revokedSessions });
      const owner = await loadPasswordOwner(app, current.id);
      await queueTwoFactorNotice(app, {
        to: owner.email,
        displayName: owner.displayName,
        notice: TwoFactorNotice.Enabled,
        at: now,
        operationId: outcome.auditId
      });
      const auth = await issueAccessResponse(app, current.id, current.sessionId, now);
      noStore(reply);
      return { ...auth, recoveryCodes: displayRecoveryCodes(outcome.codes) };
    }
  );

  /** `POST /api/auth/2fa/recovery-codes`: password + a current code → 10 new codes (the old ones stop working). */
  app.post(
    "/auth/2fa/recovery-codes",
    {
      config: { auth: "user", rateLimit: userRouteLimit },
      preHandler: perUserHook("regenerate"),
      schema: { body: twoFactorRegenerateInputSchema, response: { 200: twoFactorRecoveryCodesSchema, ...errorResponses } }
    },
    async (request, reply) => {
      const current = authUser(request);
      await assertCurrentPassword(await loadPasswordOwner(app, current.id), request.body.currentPassword);
      const now = app.clock.now();
      const outcome = await app.db.transaction(async (tx) => {
        if (!(await isTwoFactorEnabled(tx, current.id))) return { kind: "not_enabled" as const };
        if (!(await checkTotp(app, tx, current.id, request.body.code, now))) {
          await auditFailure(tx, current.id, "regenerate", request.ip);
          return { kind: "wrong" as const };
        }
        const codes = await replaceRecoveryCodes(tx, current.id, now);
        await recordAudit(tx, {
          actorUserId: current.id,
          action: AuditAction.TwoFactorRecoveryCodesRegenerated,
          entityType: "user",
          entityId: current.id,
          ip: request.ip
        });
        return { kind: "ok" as const, codes };
      });
      if (outcome.kind === "not_enabled") throw new AppError("CONFLICT", TwoFactorMessages.NotEnabled);
      if (outcome.kind === "wrong") throw new AppError("TWO_FACTOR_INVALID");
      noStore(reply);
      return { recoveryCodes: displayRecoveryCodes(outcome.codes) };
    }
  );

  /**
   * `POST /api/auth/2fa/disable` (members only; 403 for administrators):
   * password + a code or recovery code. Removes the secret, the codes and
   * every trusted device, closes every other session and emails a notice.
   */
  app.post(
    "/auth/2fa/disable",
    {
      config: { auth: "user", rateLimit: userRouteLimit },
      preHandler: perUserHook("disable"),
      schema: { body: twoFactorDisableInputSchema, response: { 204: noContent, ...errorResponses } }
    },
    async (request, reply) => {
      const current = authUser(request);
      const owner = await loadPasswordOwner(app, current.id);
      if (owner.role === "admin") throw new AppError("FORBIDDEN", TwoFactorMessages.AdminCannotDisable);
      await assertCurrentPassword(owner, request.body.currentPassword);
      const now = app.clock.now();
      const outcome = await app.db.transaction(async (tx) => {
        // Re-read the role under the row lock: a promotion may have committed since.
        const [locked] = await tx.select({ role: users.role }).from(users).where(eq(users.id, current.id)).limit(1).for("update");
        if (locked?.role !== "member") throw new AppError("FORBIDDEN", TwoFactorMessages.AdminCannotDisable);
        if (!(await isTwoFactorEnabled(tx, current.id))) return { kind: "not_enabled" as const };
        const factor = await checkSecondFactor(app, tx, current.id, request.body, now);
        if (!factor.ok) {
          await auditFailure(tx, current.id, "disable", request.ip);
          return { kind: "wrong" as const };
        }
        const removed = await removeTwoFactor(tx, current.id, now);
        const revokedSessions = await revokeSessions(
          tx,
          { userId: current.id, exceptSessionId: current.sessionId },
          "revoke_others",
          now
        );
        const auditId = await recordAudit(tx, {
          actorUserId: current.id,
          action: AuditAction.TwoFactorDisabled,
          entityType: "user",
          entityId: current.id,
          metadata: {
            factor: factor.factor,
            revokedSessions: revokedSessions.length,
            revokedTrustedDevices: removed.revokedTrustedDevices
          },
          ip: request.ip
        });
        return { kind: "ok" as const, revokedSessions, auditId };
      });
      if (outcome.kind === "not_enabled") throw new AppError("CONFLICT", TwoFactorMessages.NotEnabled);
      if (outcome.kind === "wrong") throw new AppError("TWO_FACTOR_INVALID");
      closeChatSockets(app, { sessionIds: outcome.revokedSessions });
      clearTrustedDeviceCookie(reply, app.config);
      await queueTwoFactorNotice(app, {
        to: owner.email,
        displayName: owner.displayName,
        notice: TwoFactorNotice.Disabled,
        at: now,
        operationId: outcome.auditId
      });
      return reply.code(204).send(null);
    }
  );

  /** `GET /api/auth/2fa/trusted-devices`: the caller's live trusted devices (never tokens). */
  app.get(
    "/auth/2fa/trusted-devices",
    { config: { auth: "user" }, schema: { response: { 200: z.array(trustedDeviceSchema), ...errorResponses } } },
    async (request): Promise<TrustedDevice[]> => {
      const user = authUser(request);
      const now = app.clock.now();
      const cookie = readTrustedDeviceCookie(request, app.config);
      const currentHash = cookie === null ? null : hashToken(cookie);
      const rows = await liveTrustedDevices(app.db, user.id, now);
      return rows
        .sort((a, b) => (b.lastUsedAt ?? b.createdAt).getTime() - (a.lastUsedAt ?? a.createdAt).getTime())
        .slice(0, TRUSTED_DEVICES_LIST_MAX)
        .map((row) => ({
          id: row.id,
          label: row.label,
          createdAt: row.createdAt.toISOString(),
          lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
          expiresAt: row.expiresAt.toISOString(),
          current: currentHash !== null && row.tokenHash === currentHash
        }));
    }
  );

  /** `DELETE /api/auth/2fa/trusted-devices/:id`: stop trusting one of the caller's devices (404 for anyone else's). */
  app.delete(
    "/auth/2fa/trusted-devices/:id",
    {
      config: { auth: "user", rateLimit: rateLimitByIp({ max: 30, timeWindow: "1 minute" }) },
      schema: { params: idParamSchema, response: { 204: noContent, ...errorResponses } }
    },
    async (request, reply) => {
      const user = authUser(request);
      const now = app.clock.now();
      const revoked = await app.db.transaction(async (tx) => {
        const ids = await revokeTrustedDevices(tx, user.id, now, request.params.id);
        if (ids.length === 0) return false;
        await recordAudit(tx, {
          actorUserId: user.id,
          action: AuditAction.TwoFactorTrustedDeviceRevoked,
          entityType: "user",
          entityId: user.id,
          metadata: { deviceId: request.params.id },
          ip: request.ip
        });
        return true;
      });
      if (!revoked) throw new AppError("NOT_FOUND");
      return reply.code(204).send(null);
    }
  );
};

export default twoFactorRoutes;
