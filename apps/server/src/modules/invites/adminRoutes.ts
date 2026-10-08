/**
 * Admin invite routes [SEC]: list, create, revoke and resend. Every mutation
 * is audited in its transaction. Token hashes never leave the server.
 */
import {
  type AdminInviteCandidate,
  type AdminInviteCandidates,
  adminInviteCandidateSchema,
  adminInviteCandidatesQuerySchema,
  adminInviteCandidatesSchema,
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
  OPEN_INVITE_MAX_HOURS,
  OPEN_INVITE_MAX_LIFETIME_MS,
  OPEN_INVITE_MAX_USES,
  type Page,
  pageSchema
} from "@cuencada/types";
import { and, desc, eq, or, type SQL, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { invites, people, users } from "../../db/schema/index.js";
import { recordAudit } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { AppLinkPath, appLink } from "../../lib/mailer/index.js";
import { rateLimitByIp } from "../../lib/rateLimit.js";
import { createOpaqueToken, hashToken } from "../../lib/tokens.js";
import { authUser } from "../../plugins/auth.js";
import { MailTier, withinGlobalMailCap } from "../auth/mailBudget.js";
import {
  decodeInviteCursor,
  effectiveInviteExpiresAtSql,
  encodeInviteCursor,
  inviteExhaustedSql,
  invitePendingSql,
  type InviteRow,
  isInviteUsable,
  sendInviteEmail,
  toAdminInviteListItem
} from "./service.js";
import {
  assertInvitablePerson,
  assertPersonInviteIsBound,
  findInviteCandidate,
  searchInviteCandidates
} from "./invitePerson.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const errorResponses = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  429: apiErrorSchema
} as const;

/** Invite creation time truncated to ms, so keyset comparisons match JS `Date` cursors. */
const createdAtMs = sql<Date>`date_trunc('milliseconds', ${invites.createdAt})`;

/** List columns: the invite, its creator's name and the tree person it is for (WP-4.2). */
const listColumns = {
  invite: invites,
  createdByName: users.displayName,
  personFullName: people.fullName
};

/** `{ id, fullName }` of the joined person, or `null` (none, or deleted). */
function joinedPerson(row: { invite: InviteRow; personFullName: string | null }): { id: string; fullName: string } | null {
  return row.invite.personId === null || row.personFullName === null ? null : { id: row.invite.personId, fullName: row.personFullName };
}

/**
 * Status filter matching `effectiveInviteStatus` (WP-2.3b): a stored pending
 * invite counts as `accepted` once its effective uses are used up, and as
 * `expired` once past its effective expiry.
 */
function statusCondition(status: InviteStatus, now: Date): SQL | undefined {
  const storedPending = and(eq(invites.status, "pending"), sql`not ${inviteExhaustedSql}`);
  switch (status) {
    case "pending":
      return invitePendingSql(now);
    case "expired":
      return or(
        eq(invites.status, "expired"),
        and(storedPending, sql`${effectiveInviteExpiresAtSql} <= ${now.toISOString()}::timestamptz`)
      );
    case "accepted":
      return or(eq(invites.status, "accepted"), and(eq(invites.status, "pending"), inviteExhaustedSql));
    default:
      return eq(invites.status, status);
  }
}

/**
 * Server-side guard for open invites (WP-2.3b), independent of the contract
 * schema: at most {@link OPEN_INVITE_MAX_USES} uses and
 * {@link OPEN_INVITE_MAX_LIFETIME_MS} (72 h) of life.
 *
 * @throws AppError `VALIDATION` when an open invite exceeds either limit.
 */
function assertOpenInviteLimits(email: string | null, maxUses: number, now: Date, expiresAt: Date): void {
  if (email !== null) return;
  if (maxUses > OPEN_INVITE_MAX_USES) {
    throw new AppError("VALIDATION", undefined, {
      details: [{ path: "maxUses", message: `Un enlace abierto admite como máximo ${OPEN_INVITE_MAX_USES} usos.` }]
    });
  }
  if (expiresAt.getTime() - now.getTime() > OPEN_INVITE_MAX_LIFETIME_MS) {
    throw new AppError("VALIDATION", undefined, {
      details: [{ path: "expiresInDays", message: `Un enlace abierto dura como máximo ${OPEN_INVITE_MAX_HOURS} horas.` }]
    });
  }
}

/** Admin invite routes, mounted under `/api`. */
const adminInviteRoutes: FastifyPluginAsyncZod = async (app) => {
  const mutationLimit = rateLimitByIp({ max: 60, timeWindow: "1 minute" });

  /** Invite emails use the reserved part of the daily cap; past it the admin gets 503. */
  async function assertInviteMailAllowed(now: Date): Promise<void> {
    if (!(await withinGlobalMailCap(app, app.db, MailTier.Reserved, now))) {
      throw new AppError(
        "SERVICE_UNAVAILABLE",
        "Se alcanzó el límite diario de correos. Intenta mañana o crea una invitación con enlace."
      );
    }
  }

  async function loadListItem(inviteId: string): Promise<AdminInviteListItem> {
    const [row] = await app.db
      .select(listColumns)
      .from(invites)
      .leftJoin(users, eq(users.id, invites.createdByUserId))
      .leftJoin(people, eq(people.id, invites.personId))
      .where(eq(invites.id, inviteId))
      .limit(1);
    if (row === undefined) throw new AppError("NOT_FOUND");
    return toAdminInviteListItem(row.invite, row.createdByName, app.clock.now(), joinedPerson(row));
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
        .select(listColumns)
        .from(invites)
        .leftJoin(users, eq(users.id, invites.createdByUserId))
        .leftJoin(people, eq(people.id, invites.personId))
        .where(and(...conditions))
        .orderBy(desc(createdAtMs), desc(invites.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map((row) => toAdminInviteListItem(row.invite, row.createdByName, now, joinedPerson(row))),
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

      // Open links never carry a person (checked before any lookup).
      if (input.personId !== null) assertPersonInviteIsBound(input.email);
      if (input.email !== null) {
        const [existing] = await app.db
          .select({ id: users.id })
          .from(users)
          .where(sql`lower(${users.email}) = ${input.email}`)
          .limit(1);
        if (existing !== undefined) throw new AppError("CONFLICT", "Ya existe una cuenta con ese correo.");
      }

      const expiresAt = new Date(now.getTime() + input.expiresInDays * DAY_MS);
      const maxUses = input.email === null ? input.maxUses : 1;
      assertOpenInviteLimits(input.email, maxUses, now, expiresAt);

      if (input.sendEmail) await assertInviteMailAllowed(now);

      const token = createOpaqueToken();
      const { invite, suggestedName } = await app.db.transaction(async (tx) => {
        // Locks the person until commit: concurrent creates for one person serialize here.
        const name = input.personId === null ? null : await assertInvitablePerson(tx, input.personId, now);
        const [row] = await tx
          .insert(invites)
          .values({
            tokenHash: hashToken(token),
            email: input.email,
            displayName: name,
            role: input.role,
            maxUses,
            personId: input.personId,
            note: input.note,
            // Same clock as `expiresAt`: the 72 h open-invite cap counts from here.
            createdAt: now,
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
        return { invite: row satisfies InviteRow, suggestedName: name };
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

  /**
   * `GET /api/admin/invites/people?q=`: invite picker (WP-4.2). Living people
   * without an account matching `q`; a pending invite is flagged, not hidden.
   */
  app.get(
    "/admin/invites/people",
    {
      config: { auth: "admin", rateLimit: rateLimitByIp({ max: 120, timeWindow: "1 minute" }) },
      schema: { querystring: adminInviteCandidatesQuerySchema, response: { 200: adminInviteCandidatesSchema, ...errorResponses } }
    },
    async (request): Promise<AdminInviteCandidates> => ({
      items: await searchInviteCandidates(app.db, request.query.q, request.query.limit, app.clock.now())
    })
  );

  /**
   * `GET /api/admin/invites/people/:id`: one person's invite status (any
   * person), for the "Invitar" button on a person page and a pre-filled form.
   */
  app.get(
    "/admin/invites/people/:id",
    {
      config: { auth: "admin" },
      schema: { params: idParamSchema, response: { 200: adminInviteCandidateSchema, ...errorResponses, 404: apiErrorSchema } }
    },
    async (request): Promise<AdminInviteCandidate> => {
      const candidate = await findInviteCandidate(app.db, request.params.id, app.clock.now());
      if (candidate === undefined) throw new AppError("NOT_FOUND", "No encontramos a esa persona en el árbol.");
      return candidate;
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
      await assertInviteMailAllowed(now);
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
