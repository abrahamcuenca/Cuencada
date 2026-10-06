/**
 * Admin invite routes [SEC]: list, create, revoke and resend. Every mutation
 * is audited in its transaction. Token hashes never leave the server.
 */
import {
  type AdminInviteCreated,
  type AdminInviteListItem,
  AuditAction,
  adminInviteCreatedSchema,
  adminInviteCreateInputSchema,
  adminInviteListItemSchema,
  adminInviteListQuerySchema,
  apiErrorSchema,
  type InviteStatus,
  idParamSchema,
  type Page,
  pageSchema
} from "@cuencada/types";
import { and, desc, eq, gt, lte, or, type SQL, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { invites, people, users } from "../../db/schema/index.js";
import { recordAudit } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { AppLinkPath, appLink } from "../../lib/mailer/index.js";
import { rateLimitByIp } from "../../lib/rateLimit.js";
import { createOpaqueToken, hashToken } from "../../lib/tokens.js";
import { authUser } from "../../plugins/auth.js";
import {
  decodeInviteCursor,
  encodeInviteCursor,
  type InviteRow,
  isInviteUsable,
  sendInviteEmail,
  toAdminInviteListItem
} from "./service.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const errorResponses = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  429: apiErrorSchema
} as const;

/** Invite creation time truncated to ms, so keyset comparisons match JS `Date` cursors. */
const createdAtMs = sql<Date>`date_trunc('milliseconds', ${invites.createdAt})`;

function statusCondition(status: InviteStatus, now: Date): SQL | undefined {
  switch (status) {
    case "pending":
      return and(eq(invites.status, "pending"), gt(invites.expiresAt, now));
    case "expired":
      return or(eq(invites.status, "expired"), and(eq(invites.status, "pending"), lte(invites.expiresAt, now)));
    default:
      return eq(invites.status, status);
  }
}

/** Admin invite routes, mounted under `/api`. */
const adminInviteRoutes: FastifyPluginAsyncZod = async (app) => {
  const mutationLimit = rateLimitByIp({ max: 60, timeWindow: "1 minute" });

  async function loadListItem(inviteId: string): Promise<AdminInviteListItem> {
    const [row] = await app.db
      .select({ invite: invites, createdByName: users.displayName })
      .from(invites)
      .leftJoin(users, eq(users.id, invites.createdByUserId))
      .where(eq(invites.id, inviteId))
      .limit(1);
    if (row === undefined) throw new AppError("NOT_FOUND");
    return toAdminInviteListItem(row.invite, row.createdByName, app.clock.now());
  }

  /** `GET /api/admin/invites`: newest first, keyset-paginated, optional status filter. */
  app.get(
    "/admin/invites",
    {
      config: { auth: "admin" },
      schema: { querystring: adminInviteListQuerySchema, response: { 200: pageSchema(adminInviteListItemSchema), ...errorResponses } }
    },
    async (request): Promise<Page<AdminInviteListItem>> => {
      const { cursor, limit, status } = request.query;
      const now = app.clock.now();
      const conditions: Array<SQL | undefined> = [];
      if (status !== undefined) conditions.push(statusCondition(status, now));
      if (cursor !== undefined) {
        const position = decodeInviteCursor(cursor);
        conditions.push(
          sql`(${createdAtMs}, ${invites.id}) < (${position.createdAt.toISOString()}::timestamptz, ${position.id}::uuid)`
        );
      }
      const rows = await app.db
        .select({ invite: invites, createdByName: users.displayName })
        .from(invites)
        .leftJoin(users, eq(users.id, invites.createdByUserId))
        .where(and(...conditions))
        .orderBy(desc(createdAtMs), desc(invites.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map((row) => toAdminInviteListItem(row.invite, row.createdByName, now)),
        nextCursor:
          rows.length > limit && last !== undefined
            ? encodeInviteCursor({ createdAt: last.invite.createdAt, id: last.invite.id })
            : null
      };
    }
  );

  /**
   * `POST /api/admin/invites`: create an invite. Bound invites with
   * `sendEmail` are emailed now and get no copy-link; copy-link invites get
   * `inviteUrl` exactly once.
   */
  app.post(
    "/admin/invites",
    {
      config: { auth: "admin", rateLimit: mutationLimit },
      schema: {
        body: adminInviteCreateInputSchema,
        response: { 201: adminInviteCreatedSchema, ...errorResponses, 409: apiErrorSchema, 503: apiErrorSchema }
      }
    },
    async (request, reply) => {
      const admin = authUser(request);
      const input = request.body;
      const now = app.clock.now();

      let suggestedName: string | null = null;
      if (input.personId !== null) {
        const [person] = await app.db
          .select({ fullName: people.fullName, userId: people.userId })
          .from(people)
          .where(eq(people.id, input.personId))
          .limit(1);
        if (person === undefined || person.userId !== null) {
          throw new AppError("VALIDATION", undefined, {
            details: [{ path: "personId", message: "La persona no existe o ya tiene una cuenta." }]
          });
        }
        suggestedName = person.fullName;
      }
      if (input.email !== null) {
        const [existing] = await app.db
          .select({ id: users.id })
          .from(users)
          .where(sql`lower(${users.email}) = ${input.email}`)
          .limit(1);
        if (existing !== undefined) throw new AppError("CONFLICT", "Ya existe una cuenta con ese correo.");
      }

      const token = createOpaqueToken();
      const expiresAt = new Date(now.getTime() + input.expiresInDays * DAY_MS);
      const invite = await app.db.transaction(async (tx): Promise<InviteRow> => {
        const [row] = await tx
          .insert(invites)
          .values({
            tokenHash: hashToken(token),
            email: input.email,
            displayName: suggestedName,
            role: input.role,
            maxUses: input.email === null ? input.maxUses : 1,
            personId: input.personId,
            note: input.note,
            expiresAt,
            createdByUserId: admin.id
          })
          .returning();
        if (!row) throw new Error("create invite: insert returned no row");
        await recordAudit(tx, {
          actorUserId: admin.id,
          action: AuditAction.InviteCreated,
          entityType: "invite",
          entityId: row.id,
          metadata: {
            role: row.role,
            bound: row.email !== null,
            maxUses: row.maxUses,
            expiresInDays: input.expiresInDays,
            sendEmail: input.sendEmail,
            personId: row.personId
          },
          ip: request.ip
        });
        return row;
      });

      if (input.sendEmail && invite.email !== null) {
        await sendInviteEmail(app, {
          inviteId: invite.id,
          to: invite.email,
          token,
          inviterName: admin.displayName,
          inviteeName: suggestedName,
          expiresAt,
          sentAt: now
        });
        await app.db.update(invites).set({ lastSentAt: now }).where(eq(invites.id, invite.id));
      }

      const body: AdminInviteCreated = {
        invite: await loadListItem(invite.id),
        inviteUrl: input.sendEmail ? null : appLink(app.config, AppLinkPath.Invite, token)
      };
      return reply.code(201).send(body);
    }
  );

  /** `POST /api/admin/invites/:id/revoke`: stop a pending invite (idempotent; 409 once accepted). */
  app.post(
    "/admin/invites/:id/revoke",
    {
      config: { auth: "admin", rateLimit: mutationLimit },
      schema: {
        params: idParamSchema,
        response: { 200: adminInviteListItemSchema, ...errorResponses, 404: apiErrorSchema, 409: apiErrorSchema }
      }
    },
    async (request) => {
      const admin = authUser(request);
      const now = app.clock.now();
      await app.db.transaction(async (tx) => {
        const [invite] = await tx
          .select({ status: invites.status })
          .from(invites)
          .where(eq(invites.id, request.params.id))
          .limit(1)
          .for("update");
        if (invite === undefined) throw new AppError("NOT_FOUND");
        if (invite.status === "revoked") return;
        if (invite.status === "accepted") {
          throw new AppError("CONFLICT", "La invitación ya se usó; desactiva la cuenta si hace falta.");
        }
        await tx.update(invites).set({ status: "revoked", revokedAt: now }).where(eq(invites.id, request.params.id));
        await recordAudit(tx, {
          actorUserId: admin.id,
          action: AuditAction.InviteRevoked,
          entityType: "invite",
          entityId: request.params.id,
          ip: request.ip
        });
      });
      return loadListItem(request.params.id);
    }
  );

  /**
   * `POST /api/admin/invites/:id/resend`: new token (the old link dies), email
   * it, set `lastSentAt`. Only pending, unexpired, email-bound invites.
   */
  app.post(
    "/admin/invites/:id/resend",
    {
      config: { auth: "admin", rateLimit: rateLimitByIp({ max: 10, timeWindow: "15 minutes" }) },
      schema: {
        params: idParamSchema,
        response: {
          200: adminInviteListItemSchema,
          ...errorResponses,
          404: apiErrorSchema,
          409: apiErrorSchema,
          503: apiErrorSchema
        }
      }
    },
    async (request) => {
      const admin = authUser(request);
      const now = app.clock.now();
      const token = createOpaqueToken();
      const invite = await app.db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(invites)
          .where(eq(invites.id, request.params.id))
          .limit(1)
          .for("update");
        if (row === undefined) throw new AppError("NOT_FOUND");
        if (row.email === null || !isInviteUsable(row, now)) {
          throw new AppError("CONFLICT", "Solo se pueden reenviar invitaciones pendientes ligadas a un correo.");
        }
        await tx.update(invites).set({ tokenHash: hashToken(token) }).where(eq(invites.id, row.id));
        await recordAudit(tx, {
          actorUserId: admin.id,
          action: AuditAction.InviteResent,
          entityType: "invite",
          entityId: row.id,
          ip: request.ip
        });
        return { ...row, email: row.email };
      });

      await sendInviteEmail(app, {
        inviteId: invite.id,
        to: invite.email,
        token,
        inviterName: admin.displayName,
        inviteeName: invite.displayName,
        expiresAt: invite.expiresAt,
        sentAt: now
      });
      await app.db.update(invites).set({ lastSentAt: now }).where(eq(invites.id, invite.id));
      return loadListItem(invite.id);
    }
  );
};

export default adminInviteRoutes;
