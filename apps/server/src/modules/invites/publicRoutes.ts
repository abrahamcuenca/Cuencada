/**
 * Public invite routes [SEC]: inspect (what the invitee may see before
 * accepting) and accept (create the account and log in). Both take the token
 * in the JSON body; every failure is one generic `INVITE_INVALID`.
 */
import {
  apiErrorSchema,
  authTokenResponseSchema,
  AuditAction,
  type InviteInspectResponse,
  inviteAcceptInputSchema,
  inviteInspectInputSchema,
  inviteInspectResponseSchema,
  maskEmail,
  UserRole
} from "@cuencada/types";
import { AdminAccountChange } from "@cuencada/emails";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { invites, people, profiles, users } from "../../db/schema/index.js";
import { recordAudit, type Transaction } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { hashPassword } from "../../lib/passwords.js";
import { extraRateLimitHook, rateLimitByIp } from "../../lib/rateLimit.js";
import { hashToken } from "../../lib/tokens.js";
import {
  type AdminAlert,
  type AdminAlertPlan,
  adminAlertMetadata,
  planNewAdminAlert,
  queueAdminAlerts
} from "../admin/adminAlerts.js";
import { issueAuthResponse } from "../auth/currentUser.js";
import { type IssuedRefresh, sessionOrigin, startSession } from "../auth/sessions.js";
import {
  type InviteAcceptedAlert,
  type InviteAcceptedAlertPlan,
  inviteAlertMetadata,
  planInviteAcceptedAlert,
  queueInviteAcceptedAlerts
} from "./acceptAlerts.js";
import { effectiveInviteMaxUses, isInviteUsable, personName } from "./service.js";

const errorResponses = {
  400: apiErrorSchema,
  409: apiErrorSchema,
  429: apiErrorSchema
} as const;

const ACCOUNT_EXISTS_MESSAGE = "Ya tienes cuenta, inicia sesión.";

/** Accept attempts allowed per invite token, across all IPs. */
export const INVITE_ACCEPT_PER_TOKEN = { max: 5, timeWindow: "15 minutes" } as const;

/** Rate-limit key part for the body's token: its hash (never the raw token). */
function tokenKey(body: unknown): string {
  if (typeof body !== "object" || body === null || !("token" in body) || typeof body.token !== "string") return "none";
  return hashToken(body.token.trim()).slice(0, 32);
}

/** Outcome of the accept transaction. */
type AcceptOutcome =
  | {
      kind: "accepted";
      userId: string;
      issued: IssuedRefresh;
      /** Open invites only: the admin alert to queue after commit. */
      alert: { plan: InviteAcceptedAlertPlan; details: InviteAcceptedAlert } | null;
      /** Admin-role invites only: the new-admin alert to queue after commit. */
      adminAlert: { plan: AdminAlertPlan; details: AdminAlert } | null;
    }
  | { kind: "invalid" }
  | { kind: "exists" };

/**
 * Link the new account to the invite's family-tree person when that person is
 * still unlinked; otherwise create a person for the account.
 */
async function linkPerson(tx: Transaction, personId: string | null, userId: string, fullName: string): Promise<void> {
  if (personId !== null) {
    const linked = await tx
      .update(people)
      .set({ userId })
      .where(and(eq(people.id, personId), isNull(people.userId)))
      .returning({ id: people.id });
    if (linked.length > 0) return;
  }
  await tx.insert(people).values({ userId, fullName, createdByUserId: userId });
}

/** Display name of the admin who created the invite (`null` once that account is gone). */
async function inviterName(tx: Transaction, userId: string | null): Promise<string> {
  if (userId === null) return "";
  const [row] = await tx.select({ displayName: users.displayName }).from(users).where(eq(users.id, userId)).limit(1);
  // An empty name makes the template say "Un administrador".
  return row?.displayName ?? "";
}

/** Public invite routes, mounted under `/api`. */
const publicInviteRoutes: FastifyPluginAsyncZod = async (app) => {
  /** `POST /api/invites/inspect`: masked email, role and names for a usable invite. */
  app.post(
    "/invites/inspect",
    {
      config: { auth: "public", rateLimit: rateLimitByIp({ max: 30, timeWindow: "15 minutes" }) },
      schema: { body: inviteInspectInputSchema, response: { 200: inviteInspectResponseSchema, ...errorResponses } }
    },
    async (request): Promise<InviteInspectResponse> => {
      const now = app.clock.now();
      const [row] = await app.db
        .select({ invite: invites, invitedByName: users.displayName })
        .from(invites)
        .leftJoin(users, eq(users.id, invites.createdByUserId))
        .where(eq(invites.tokenHash, hashToken(request.body.token)))
        .limit(1);
      if (row === undefined || !isInviteUsable(row.invite, now)) throw new AppError("INVITE_INVALID");
      const { invite } = row;
      return {
        emailMasked: invite.email === null ? null : maskEmail(invite.email),
        role: invite.role,
        expiresAt: invite.expiresAt.toISOString(),
        invitedByName: row.invitedByName,
        suggestedDisplayName: invite.displayName ?? (await personName(app.db, invite.personId))
      };
    }
  );

  /**
   * `POST /api/invites/accept`: create the account, link the person, start a
   * session (201 + refresh cookie). The invite row is locked, so concurrent
   * accepts of a single-use invite cannot both succeed. Accepting an open
   * invite alerts every active admin after commit (WP-2.3b, `acceptAlerts.ts`).
   */
  app.post(
    "/invites/accept",
    {
      config: { auth: "public", rateLimit: rateLimitByIp({ max: 10, timeWindow: "15 minutes" }) },
      // Per invite as well as per IP: an open invite's 409 "account exists"
      // answer would otherwise let a link holder probe many emails from many IPs.
      preHandler: extraRateLimitHook(app, {
        ...INVITE_ACCEPT_PER_TOKEN,
        keyGenerator: (request) => `invite-accept:${tokenKey(request.body)}`
      }),
      schema: { body: inviteAcceptInputSchema, response: { 201: authTokenResponseSchema, ...errorResponses } }
    },
    async (request, reply) => {
      const { token, email, displayName, password } = request.body;
      // Hash before taking the row lock: argon2 is slow by design.
      const passwordHash = await hashPassword(password);
      const now = app.clock.now();

      const outcome = await app.db.transaction(async (tx): Promise<AcceptOutcome> => {
        const [invite] = await tx
          .select()
          .from(invites)
          .where(eq(invites.tokenHash, hashToken(token)))
          .limit(1)
          .for("update");
        if (invite === undefined || !isInviteUsable(invite, now)) return { kind: "invalid" };
        // Bound invites: the typed address must be the bound one (generic failure on mismatch).
        if (invite.email !== null && invite.email.toLowerCase() !== email) return { kind: "invalid" };

        const [existing] = await tx
          .select({ id: users.id })
          .from(users)
          .where(sql`lower(${users.email}) = ${email}`)
          .limit(1);
        if (existing !== undefined) return { kind: "exists" };

        // Verified only when the invite was bound to this address AND delivered by email.
        const emailVerified = invite.email !== null && invite.lastSentAt !== null;
        const [user] = await tx
          .insert(users)
          .values({
            email,
            displayName,
            passwordHash,
            role: invite.role,
            emailVerifiedAt: emailVerified ? now : null,
            passwordChangedAt: now,
            invitedByInviteId: invite.id,
            lastLoginAt: now
          })
          .onConflictDoNothing()
          .returning({ id: users.id });
        // A concurrent accept (another invite) took the address between the check and the insert.
        if (user === undefined) return { kind: "exists" };

        await tx.insert(profiles).values({ userId: user.id, fullName: displayName });
        await linkPerson(tx, invite.personId, user.id, displayName);

        const useCount = invite.useCount + 1;
        // Effective limit: open invites created before WP-2.3b stop at 10 uses.
        const maxUses = effectiveInviteMaxUses(invite);
        const exhausted = useCount >= maxUses;
        await tx
          .update(invites)
          .set({ useCount, ...(exhausted ? { status: "accepted" as const, acceptedAt: now } : {}) })
          .where(eq(invites.id, invite.id));

        const issued = await startSession(tx, app.config, user.id, sessionOrigin(request), now);
        const open = invite.email === null;
        const plan = open ? await planInviteAcceptedAlert(app, tx, now) : null;
        // Admin-role invites (always email-bound) create an admin: tell the other admins (Security P1).
        const adminPlan = invite.role === UserRole.Admin ? await planNewAdminAlert(tx, user.id) : null;
        const auditId = await recordAudit(tx, {
          actorUserId: user.id,
          action: AuditAction.InviteAccepted,
          entityType: "invite",
          entityId: invite.id,
          metadata: {
            userId: user.id,
            role: invite.role,
            emailVerified,
            open,
            useCount,
            maxUses,
            ...(plan === null ? {} : inviteAlertMetadata(plan)),
            ...(adminPlan === null ? {} : adminAlertMetadata(adminPlan))
          },
          ip: request.ip
        });
        const adminAlert =
          adminPlan === null
            ? null
            : {
                plan: adminPlan,
                details: {
                  auditId,
                  actorName: await inviterName(tx, invite.createdByUserId),
                  targetName: displayName,
                  changes: [AdminAccountChange.Promoted],
                  changedAt: now
                }
              };
        const alert =
          plan === null
            ? null
            : {
                plan,
                details: {
                  auditId,
                  inviteId: invite.id,
                  inviteNote: invite.note,
                  memberUserId: user.id,
                  memberName: displayName,
                  useCount,
                  maxUses,
                  acceptedAt: now
                }
              };
        return { kind: "accepted", userId: user.id, issued, alert, adminAlert };
      });

      if (outcome.kind === "invalid") throw new AppError("INVITE_INVALID");
      if (outcome.kind === "exists") throw new AppError("CONFLICT", ACCOUNT_EXISTS_MESSAGE);
      // Committed: queue the admin alert off the request path (a mail failure never fails the acceptance).
      if (outcome.alert !== null) queueInviteAcceptedAlerts(app, outcome.alert.plan, outcome.alert.details);
      if (outcome.adminAlert !== null) queueAdminAlerts(app, outcome.adminAlert.plan, outcome.adminAlert.details);
      const body = await issueAuthResponse(app, reply, outcome.issued, outcome.userId, now);
      return reply.code(201).send(body);
    }
  );
};

export default publicInviteRoutes;
