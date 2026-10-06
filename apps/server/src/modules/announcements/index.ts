/**
 * Announcements module (T2). Mounted under `/api` by `app.ts`:
 * - `GET /announcements` (members): live portal-wide announcements, paginated.
 * - `/admin/announcements*` (admins): CRUD for portal-wide and per-Cuencada
 *   announcements, with pinning and a publish/expiry window.
 *
 * Public reads of announcements go through the cuencadas module
 * (`/cuencadas/home`, `/cuencadas/:year`), which filters by visibility.
 */
import {
  type Announcement,
  AnnouncementScope,
  AuditAction,
  AuditEntityType,
  adminAnnouncementQuerySchema,
  announcementSchema,
  apiErrorSchema,
  createAnnouncementInputSchema,
  cursorQuerySchema,
  idParamSchema,
  type Page,
  pageSchema,
  updateAnnouncementInputSchema
} from "@cuencada/types";
import { and, asc, eq, isNotNull, isNull, type SQL, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { announcements, cuencadas, users } from "../../db/schema/index.js";
import { type DbOrTx, recordAudit } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { authUser } from "../../plugins/auth.js";
import {
  announcementColumns,
  announcementOrder,
  findAnnouncement,
  isLive,
  toAnnouncement
} from "./repository.js";

const NOT_FOUND_MESSAGE = "No encontramos ese aviso.";
const EXPIRY_MESSAGE = "La fecha de vencimiento debe ser posterior a la de publicación.";

/* ------------------------------- Cursor -------------------------------- */

/**
 * Keyset position: the last row's `(pinned, publish_at, id)`. `at` is UTC ISO
 * with Postgres' microseconds (`2026-01-05T00:00:00.123456Z`), so pages never
 * skip or repeat rows that differ below the millisecond.
 */
interface AnnouncementCursor {
  pinned: boolean;
  at: string;
  id: string;
}

/**
 * True for a real calendar instant: V8 rolls `2026-02-30` over to March, so
 * compare the round-tripped date/time with the input instead of only parsing.
 */
function isRealInstant(value: string): boolean {
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19);
}

/** Validated before the value reaches SQL, so a crafted cursor is a 400, never a Postgres 22007/22008 (500). */
const cursorPayloadSchema = z.tuple([
  z.boolean(),
  z.iso.datetime({ precision: 6 }).refine(isRealInstant),
  z.uuid()
]);

function encodeCursor(cursor: AnnouncementCursor): string {
  return Buffer.from(JSON.stringify([cursor.pinned, cursor.at, cursor.id])).toString("base64url");
}

/**
 * @throws AppError `VALIDATION` for a malformed cursor (client input).
 */
function decodeCursor(value: string): AnnouncementCursor {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    raw = undefined;
  }
  const parsed = cursorPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError("VALIDATION", "Cursor inválido.", { details: [{ path: "cursor", message: "Cursor inválido." }] });
  }
  const [pinned, at, id] = parsed.data;
  return { pinned, at, id };
}

/* ------------------------------ Helpers -------------------------------- */

function assertExpiryAfterPublish(publishAt: Date, expiresAt: Date | null): void {
  if (expiresAt !== null && expiresAt.getTime() <= publishAt.getTime()) {
    throw new AppError("VALIDATION", EXPIRY_MESSAGE, { details: [{ path: "expiresAt", message: EXPIRY_MESSAGE }] });
  }
}

async function assertCuencadaExists(db: DbOrTx, cuencadaId: string | null): Promise<void> {
  if (cuencadaId === null) return;
  const [found] = await db.select({ id: cuencadas.id }).from(cuencadas).where(eq(cuencadas.id, cuencadaId)).limit(1);
  if (found === undefined) {
    const message = "No encontramos esa Cuencada.";
    throw new AppError("VALIDATION", message, { details: [{ path: "cuencadaId", message }] });
  }
}

async function requireAnnouncement(db: DbOrTx, id: string): Promise<Announcement> {
  const row = await findAnnouncement(db, id);
  if (row === undefined) throw new AppError("NOT_FOUND", NOT_FOUND_MESSAGE);
  return toAnnouncement(row);
}

/* ------------------------------- Routes -------------------------------- */

/** Announcements routes under `/api`. */
const announcementsModule: FastifyPluginAsyncZod = async (app) => {
  /** `GET /api/announcements`: live portal-wide announcements for members, pinned first. */
  app.get(
    "/announcements",
    {
      config: { auth: "user" },
      schema: { querystring: cursorQuerySchema, response: { 200: pageSchema(announcementSchema) } }
    },
    async (request): Promise<Page<Announcement>> => {
      const { cursor, limit } = request.query;
      const after = cursor === undefined ? undefined : decodeCursor(cursor);
      const keyset: SQL | undefined =
        after === undefined
          ? undefined
          : sql`(${announcements.pinned}, ${announcements.publishAt}, ${announcements.id}) < (${after.pinned}, ${after.at}::timestamptz, ${after.id}::uuid)`;
      const rows = await app.db
        .select({ ...announcementColumns, cursorAt: sql<string>`to_char(${announcements.publishAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` })
        .from(announcements)
        .leftJoin(users, eq(users.id, announcements.createdByUserId))
        .where(and(isNull(announcements.cuencadaId), isLive(app.clock.now()), keyset))
        .orderBy(...announcementOrder)
        .limit(limit + 1);
      const pageRows = rows.slice(0, limit);
      const last = pageRows[pageRows.length - 1];
      return {
        items: pageRows.map(toAnnouncement),
        nextCursor:
          rows.length > limit && last !== undefined
            ? encodeCursor({ pinned: last.pinned, at: last.cursorAt, id: last.id })
            : null
      };
    }
  );

  /** `GET /api/admin/announcements`: every announcement (scheduled and expired included), filtered by Cuencada or scope. */
  app.get(
    "/admin/announcements",
    {
      config: { auth: "admin" },
      schema: { querystring: adminAnnouncementQuerySchema, response: { 200: z.array(announcementSchema) } }
    },
    async (request): Promise<Announcement[]> => {
      const { cuencadaId, scope } = request.query;
      let filter: SQL | undefined;
      if (cuencadaId !== undefined) filter = eq(announcements.cuencadaId, cuencadaId);
      else if (scope === AnnouncementScope.Portal) filter = isNull(announcements.cuencadaId);
      else if (scope === AnnouncementScope.Cuencada) filter = isNotNull(announcements.cuencadaId);
      const rows = await app.db
        .select(announcementColumns)
        .from(announcements)
        .leftJoin(users, eq(users.id, announcements.createdByUserId))
        .where(filter)
        .orderBy(...announcementOrder, asc(announcements.createdAt));
      return rows.map(toAnnouncement);
    }
  );

  /** `POST /api/admin/announcements`: `publishedAt` defaults to now. */
  app.post(
    "/admin/announcements",
    {
      config: { auth: "admin" },
      schema: { body: createAnnouncementInputSchema, response: { 201: announcementSchema } }
    },
    async (request, reply) => {
      const admin = authUser(request);
      const { publishedAt, expiresAt, ...input } = request.body;
      const publishAt = publishedAt === undefined ? app.clock.now() : new Date(publishedAt);
      const expires = expiresAt === null ? null : new Date(expiresAt);
      assertExpiryAfterPublish(publishAt, expires);
      const created = await app.db.transaction(async (tx) => {
        await assertCuencadaExists(tx, input.cuencadaId);
        const [row] = await tx
          .insert(announcements)
          .values({ ...input, publishAt, expiresAt: expires, createdByUserId: admin.id })
          .returning({ id: announcements.id });
        if (row === undefined) throw new Error("create announcement: insert returned no row");
        await recordAudit(tx, {
          actorUserId: admin.id,
          action: AuditAction.AnnouncementCreated,
          entityType: AuditEntityType.Announcement,
          entityId: row.id,
          metadata: { cuencadaId: input.cuencadaId, visibility: input.visibility, pinned: input.pinned },
          ip: request.ip
        });
        return requireAnnouncement(tx, row.id);
      });
      return reply.code(201).send(created);
    }
  );

  /** `PATCH /api/admin/announcements/:id`: re-validates the merged publish/expiry window. */
  app.patch(
    "/admin/announcements/:id",
    {
      config: { auth: "admin" },
      schema: {
        params: idParamSchema,
        body: updateAnnouncementInputSchema,
        response: { 200: announcementSchema, 404: apiErrorSchema }
      }
    },
    async (request): Promise<Announcement> => {
      const admin = authUser(request);
      const { publishedAt, expiresAt, ...rest } = request.body;
      return app.db.transaction(async (tx) => {
        const [current] = await tx.select().from(announcements).where(eq(announcements.id, request.params.id)).for("update");
        if (current === undefined) throw new AppError("NOT_FOUND", NOT_FOUND_MESSAGE);
        const publishAt = publishedAt === undefined ? current.publishAt : new Date(publishedAt);
        const expires = expiresAt === undefined ? current.expiresAt : expiresAt === null ? null : new Date(expiresAt);
        assertExpiryAfterPublish(publishAt, expires);
        const values: Partial<typeof announcements.$inferInsert> = { publishAt, expiresAt: expires };
        for (const [key, value] of Object.entries(rest)) {
          if (value !== undefined) Object.assign(values, { [key]: value });
        }
        await tx.update(announcements).set(values).where(eq(announcements.id, current.id));
        await recordAudit(tx, {
          actorUserId: admin.id,
          action: AuditAction.AnnouncementUpdated,
          entityType: AuditEntityType.Announcement,
          entityId: current.id,
          metadata: { cuencadaId: current.cuencadaId, fields: Object.keys(request.body) },
          ip: request.ip
        });
        return requireAnnouncement(tx, current.id);
      });
    }
  );

  /** `DELETE /api/admin/announcements/:id`. */
  app.delete(
    "/admin/announcements/:id",
    {
      config: { auth: "admin" },
      schema: { params: idParamSchema, response: { 204: z.null(), 404: apiErrorSchema } }
    },
    async (request, reply) => {
      const admin = authUser(request);
      await app.db.transaction(async (tx) => {
        const [deleted] = await tx
          .delete(announcements)
          .where(eq(announcements.id, request.params.id))
          .returning({ id: announcements.id, cuencadaId: announcements.cuencadaId, title: announcements.title });
        if (deleted === undefined) throw new AppError("NOT_FOUND", NOT_FOUND_MESSAGE);
        await recordAudit(tx, {
          actorUserId: admin.id,
          action: AuditAction.AnnouncementDeleted,
          entityType: AuditEntityType.Announcement,
          entityId: deleted.id,
          metadata: { cuencadaId: deleted.cuencadaId, title: deleted.title },
          ip: request.ip
        });
      });
      return reply.code(204).send(null);
    }
  );
};

export default announcementsModule;
