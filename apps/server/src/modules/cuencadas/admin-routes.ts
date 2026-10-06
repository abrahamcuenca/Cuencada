/**
 * Admin CRUD for Cuencada editions under `/api/admin/cuencadas`.
 *
 * - Publishing is `PATCH { isPublished: true }`; it audits
 *   `cuencada.published` and creates the edition's chat room if missing.
 * - Only drafts that were never published and have no media can be deleted.
 * - Audit metadata lists changed field *names* only: some values (WhatsApp,
 *   album links) are credential-like and must not be copied into the log.
 */
import {
  type AdminCuencada,
  type AdminCuencadaDetail,
  AuditAction,
  AuditEntityType,
  adminCuencadaDetailSchema,
  adminCuencadaSchema,
  apiErrorSchema,
  createCuencadaInputSchema,
  idParamSchema,
  type UpdateCuencadaInput,
  updateCuencadaInputSchema
} from "@cuencada/types";
import { count, desc, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { cuencadas, dailyMessages } from "../../db/schema/index.js";
import { recordAudit } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { authUser } from "../../plugins/auth.js";
import { toAnnouncement } from "../announcements/repository.js";
import { isUniqueViolation } from "./db-errors.js";
import { toAdminCuencada, toItineraryItem, toLocationItem } from "./mappers.js";
import {
  ContentScope,
  draftDeleteBlocker,
  ensureCuencadaChatRoom,
  getCuencadaById,
  loadEditionContent
} from "./repository.js";

const DUPLICATE_YEAR = "Ya existe una Cuencada para ese año.";
const PUBLISHED_YEAR_LOCKED = "No se puede cambiar el año de una Cuencada publicada. Despublícala primero.";

function duplicateYear(cause: unknown): AppError {
  return new AppError("CONFLICT", DUPLICATE_YEAR, { details: [{ path: "year", message: DUPLICATE_YEAR }], cause });
}

function toDateOrNull(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

/** DB `set` object for a PATCH: only the keys that were sent. */
function updateValues(input: UpdateCuencadaInput): Partial<typeof cuencadas.$inferInsert> {
  const { startsAt, endsAt, rsvpDeadline, year, ...rest } = input;
  const values: Partial<typeof cuencadas.$inferInsert> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) Object.assign(values, { [key]: value });
  }
  if (year !== undefined) {
    values.year = year;
    values.slug = String(year);
  }
  if (startsAt !== undefined) values.startsAt = new Date(startsAt);
  if (endsAt !== undefined) values.endsAt = new Date(endsAt);
  if (rsvpDeadline !== undefined) values.rsvpDeadline = toDateOrNull(rsvpDeadline);
  return values;
}

/** Admin Cuencada routes under `/api`. */
const cuencadaAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  /** `GET /api/admin/cuencadas`: every edition, drafts included, newest year first. */
  app.get(
    "/admin/cuencadas",
    { config: { auth: "admin" }, schema: { response: { 200: z.array(adminCuencadaSchema) } } },
    async (): Promise<AdminCuencada[]> => {
      const now = app.clock.now();
      const rows = await app.db.select().from(cuencadas).orderBy(desc(cuencadas.year));
      return rows.map((row) => toAdminCuencada(row, now));
    }
  );

  /** `POST /api/admin/cuencadas`: create (slug = year); 409 on a duplicate year. */
  app.post(
    "/admin/cuencadas",
    {
      config: { auth: "admin" },
      schema: {
        body: createCuencadaInputSchema,
        response: { 201: adminCuencadaSchema, 409: apiErrorSchema }
      }
    },
    async (request, reply) => {
      const admin = authUser(request);
      const input = request.body;
      const row = await app.db
        .transaction(async (tx) => {
          const [created] = await tx
            .insert(cuencadas)
            .values({
              ...input,
              slug: String(input.year),
              startsAt: new Date(input.startsAt),
              endsAt: new Date(input.endsAt),
              rsvpDeadline: toDateOrNull(input.rsvpDeadline),
              firstPublishedAt: input.isPublished ? app.clock.now() : null
            })
            .returning();
          if (created === undefined) throw new Error("create cuencada: insert returned no row");
          await recordAudit(tx, {
            actorUserId: admin.id,
            action: AuditAction.CuencadaCreated,
            entityType: AuditEntityType.Cuencada,
            entityId: created.id,
            metadata: { year: created.year },
            ip: request.ip
          });
          if (created.isPublished) {
            const chatRoomCreated = await ensureCuencadaChatRoom(tx, created);
            await recordAudit(tx, {
              actorUserId: admin.id,
              action: AuditAction.CuencadaPublished,
              entityType: AuditEntityType.Cuencada,
              entityId: created.id,
              metadata: { year: created.year, chatRoomCreated },
              ip: request.ip
            });
          }
          return created;
        })
        .catch((error: unknown) => {
          if (isUniqueViolation(error)) throw duplicateYear(error);
          throw error;
        });
      return reply.code(201).send(toAdminCuencada(row, app.clock.now()));
    }
  );

  /** `GET /api/admin/cuencadas/:id`: the edit screen (all items, every announcement). */
  app.get(
    "/admin/cuencadas/:id",
    {
      config: { auth: "admin" },
      schema: { params: idParamSchema, response: { 200: adminCuencadaDetailSchema, 404: apiErrorSchema } }
    },
    async (request): Promise<AdminCuencadaDetail> => {
      const now = app.clock.now();
      const row = await getCuencadaById(app.db, request.params.id);
      const [contentById, [messages]] = await Promise.all([
        loadEditionContent(app.db, [row.id], ContentScope.Admin, now),
        app.db.select({ value: count() }).from(dailyMessages).where(eq(dailyMessages.cuencadaId, row.id))
      ]);
      const content = contentById.get(row.id);
      return {
        cuencada: toAdminCuencada(row, now),
        itinerary: (content?.itinerary ?? []).map(toItineraryItem),
        locations: (content?.locations ?? []).map(toLocationItem),
        announcements: (content?.announcements ?? []).map(toAnnouncement),
        dailyMessageCount: messages?.value ?? 0
      };
    }
  );

  /** `PATCH /api/admin/cuencadas/:id`: partial update, publish/unpublish. */
  app.patch(
    "/admin/cuencadas/:id",
    {
      config: { auth: "admin" },
      schema: {
        params: idParamSchema,
        body: updateCuencadaInputSchema,
        response: { 200: adminCuencadaSchema, 404: apiErrorSchema, 409: apiErrorSchema }
      }
    },
    async (request): Promise<AdminCuencada> => {
      const admin = authUser(request);
      const input = request.body;
      const row = await app.db
        .transaction(async (tx) => {
          const current = await getCuencadaById(tx, request.params.id, true);

          // The body refine only sees the fields that were sent; check the merged row.
          // A published edition's year is its public URL (/cuencada/:year), slug and chat room title.
          if (current.isPublished && input.year !== undefined && input.year !== current.year) {
            throw new AppError("CONFLICT", PUBLISHED_YEAR_LOCKED, {
              details: [{ path: "year", message: PUBLISHED_YEAR_LOCKED }]
            });
          }

          const startsAt = input.startsAt === undefined ? current.startsAt : new Date(input.startsAt);
          const endsAt = input.endsAt === undefined ? current.endsAt : new Date(input.endsAt);
          if (endsAt.getTime() <= startsAt.getTime()) {
            const message = "La fecha de fin debe ser posterior al inicio.";
            throw new AppError("VALIDATION", message, { details: [{ path: "endsAt", message }] });
          }

          // first_published_at is set on the first publish only; unpublish/republish keeps the original instant.
          const firstPublished =
            input.isPublished === true
              ? { firstPublishedAt: sql`coalesce(${cuencadas.firstPublishedAt}, ${app.clock.now().toISOString()}::timestamptz)` }
              : {};
          const [updated] = await tx
            .update(cuencadas)
            .set({ ...updateValues(input), ...firstPublished })
            .where(eq(cuencadas.id, current.id))
            .returning();
          if (updated === undefined) throw new AppError("NOT_FOUND");

          const fields = Object.keys(input)
            .filter((key) => key !== "isPublished")
            .sort();
          if (fields.length > 0) {
            await recordAudit(tx, {
              actorUserId: admin.id,
              action: AuditAction.CuencadaUpdated,
              entityType: AuditEntityType.Cuencada,
              entityId: updated.id,
              metadata: { year: updated.year, fields },
              ip: request.ip
            });
          }
          if (!current.isPublished && updated.isPublished) {
            const chatRoomCreated = await ensureCuencadaChatRoom(tx, updated);
            await recordAudit(tx, {
              actorUserId: admin.id,
              action: AuditAction.CuencadaPublished,
              entityType: AuditEntityType.Cuencada,
              entityId: updated.id,
              metadata: { year: updated.year, chatRoomCreated },
              ip: request.ip
            });
          } else if (current.isPublished && !updated.isPublished) {
            await recordAudit(tx, {
              actorUserId: admin.id,
              action: AuditAction.CuencadaUnpublished,
              entityType: AuditEntityType.Cuencada,
              entityId: updated.id,
              metadata: { year: updated.year },
              ip: request.ip
            });
          }
          return updated;
        })
        .catch((error: unknown) => {
          if (isUniqueViolation(error)) throw duplicateYear(error);
          throw error;
        });
      return toAdminCuencada(row, app.clock.now());
    }
  );

  /** `DELETE /api/admin/cuencadas/:id`: drafts that were never published and have no media; else 409. */
  app.delete(
    "/admin/cuencadas/:id",
    {
      config: { auth: "admin" },
      schema: {
        params: idParamSchema,
        response: { 204: z.null(), 404: apiErrorSchema, 409: apiErrorSchema }
      }
    },
    async (request, reply) => {
      const admin = authUser(request);
      await app.db.transaction(async (tx) => {
        const current = await getCuencadaById(tx, request.params.id, true);
        if (current.isPublished) {
          throw new AppError("CONFLICT", "Solo se pueden eliminar borradores. Despublica la Cuencada primero.");
        }
        const blocker = await draftDeleteBlocker(tx, current);
        if (blocker !== null) throw new AppError("CONFLICT", blocker);
        await tx.delete(cuencadas).where(eq(cuencadas.id, current.id));
        await recordAudit(tx, {
          actorUserId: admin.id,
          action: AuditAction.CuencadaDeleted,
          entityType: AuditEntityType.Cuencada,
          entityId: current.id,
          metadata: { year: current.year },
          ip: request.ip
        });
      });
      return reply.code(204).send(null);
    }
  );
};

export default cuencadaAdminRoutes;
