/**
 * Admin routes for an edition's daily messages: list, upsert/delete one
 * date, and an all-or-nothing bulk import of `YYYY-MM-DD|message` text
 * (parsed with the shared `parseDailyMessagesText`) and/or parsed entries.
 */
import {
  AuditAction,
  AuditEntityType,
  type ApiErrorDetail,
  apiErrorSchema,
  type DailyMessage,
  type DailyMessageEntry,
  type DailyMessagesImportResult,
  DailyMessagesImportMode,
  dailyMessageSchema,
  dailyMessagesImportInputSchema,
  dailyMessagesImportResultSchema,
  dailyMessageUpsertInputSchema,
  dateParamSchema,
  idParamSchema,
  parseDailyMessagesText
} from "@cuencada/types";
import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { dailyMessages } from "../../db/schema/index.js";
import { type DbOrTx, recordAudit } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { authUser } from "../../plugins/auth.js";
import { toDailyMessage } from "./mappers.js";
import { getCuencadaById } from "./repository.js";

/** Rows per INSERT; keeps the bind-parameter count far below Postgres' 65 535. */
const INSERT_CHUNK = 1000;

/** Parsed import, or every problem found (already capped by the parser). */
interface CombinedEntries {
  entries: DailyMessageEntry[];
  errors: ApiErrorDetail[];
}

/**
 * Merge the parsed text with the JSON entries. A date appearing twice (in
 * the text, in the entries or across both) is an error at `entries.N`.
 */
function combineEntries(text: string | undefined, jsonEntries: readonly DailyMessageEntry[] | undefined): CombinedEntries {
  const parsed = text === undefined ? { entries: [], errors: [] } : parseDailyMessagesText(text);
  const entries = [...parsed.entries];
  const errors = [...parsed.errors];
  const seen = new Set(entries.map((entry) => entry.date));
  (jsonEntries ?? []).forEach((entry, index) => {
    if (seen.has(entry.date)) {
      errors.push({ path: `entries.${index}`, message: `Fecha repetida (${entry.date}).` });
      return;
    }
    seen.add(entry.date);
    entries.push(entry);
  });
  return { entries, errors };
}

async function upsertEntries(db: DbOrTx, cuencadaId: string, entries: readonly DailyMessageEntry[]): Promise<void> {
  for (let start = 0; start < entries.length; start += INSERT_CHUNK) {
    const chunk = entries.slice(start, start + INSERT_CHUNK);
    await db
      .insert(dailyMessages)
      .values(chunk.map((entry) => ({ cuencadaId, date: entry.date, message: entry.message })))
      .onConflictDoUpdate({
        target: [dailyMessages.cuencadaId, dailyMessages.date],
        set: { message: sql`excluded.message`, updatedAt: sql`now()` }
      });
  }
}

/** Admin daily-message routes under `/api`. */
const dailyMessagesRoutes: FastifyPluginAsyncZod = async (app) => {
  /** `GET /api/admin/cuencadas/:id/daily-messages`: every message by date. */
  app.get(
    "/admin/cuencadas/:id/daily-messages",
    {
      config: { auth: "admin" },
      schema: { params: idParamSchema, response: { 200: z.array(dailyMessageSchema), 404: apiErrorSchema } }
    },
    async (request): Promise<DailyMessage[]> => {
      const cuencada = await getCuencadaById(app.db, request.params.id);
      const rows = await app.db
        .select()
        .from(dailyMessages)
        .where(eq(dailyMessages.cuencadaId, cuencada.id))
        .orderBy(asc(dailyMessages.date));
      return rows.map(toDailyMessage);
    }
  );

  /** `PUT /api/admin/cuencadas/:id/daily-messages/:date`: upsert one date. */
  app.put(
    "/admin/cuencadas/:id/daily-messages/:date",
    {
      config: { auth: "admin" },
      schema: {
        params: dateParamSchema,
        body: dailyMessageUpsertInputSchema,
        response: { 200: dailyMessageSchema, 404: apiErrorSchema }
      }
    },
    async (request): Promise<DailyMessage> => {
      const admin = authUser(request);
      const { id, date } = request.params;
      const row = await app.db.transaction(async (tx) => {
        const cuencada = await getCuencadaById(tx, id);
        const [saved] = await tx
          .insert(dailyMessages)
          .values({ cuencadaId: cuencada.id, date, message: request.body.message })
          .onConflictDoUpdate({
            target: [dailyMessages.cuencadaId, dailyMessages.date],
            set: { message: request.body.message, updatedAt: sql`now()` }
          })
          .returning();
        if (saved === undefined) throw new Error("upsert daily message: no row returned");
        await recordAudit(tx, {
          actorUserId: admin.id,
          action: "daily_message.saved",
          entityType: AuditEntityType.DailyMessage,
          entityId: saved.id,
          metadata: { cuencadaId: cuencada.id, date },
          ip: request.ip
        });
        return saved;
      });
      return toDailyMessage(row);
    }
  );

  /** `DELETE /api/admin/cuencadas/:id/daily-messages/:date`: 404 if there is no message that day. */
  app.delete(
    "/admin/cuencadas/:id/daily-messages/:date",
    {
      config: { auth: "admin" },
      schema: { params: dateParamSchema, response: { 204: z.null(), 404: apiErrorSchema } }
    },
    async (request, reply) => {
      const admin = authUser(request);
      const { id, date } = request.params;
      await app.db.transaction(async (tx) => {
        const [deleted] = await tx
          .delete(dailyMessages)
          .where(and(eq(dailyMessages.cuencadaId, id), eq(dailyMessages.date, date)))
          .returning({ id: dailyMessages.id });
        if (deleted === undefined) throw new AppError("NOT_FOUND", "No hay mensaje para ese día.");
        await recordAudit(tx, {
          actorUserId: admin.id,
          action: "daily_message.deleted",
          entityType: AuditEntityType.DailyMessage,
          entityId: deleted.id,
          metadata: { cuencadaId: id, date },
          ip: request.ip
        });
      });
      return reply.code(204).send(null);
    }
  );

  /**
   * `POST /api/admin/cuencadas/:id/daily-messages/import`: all-or-nothing.
   * Any bad line → 400 `VALIDATION` with `details[].path = "lines.N"` (capped
   * at 100 with a summary) and nothing is written.
   */
  app.post(
    "/admin/cuencadas/:id/daily-messages/import",
    {
      config: { auth: "admin" },
      schema: {
        params: idParamSchema,
        body: dailyMessagesImportInputSchema,
        response: { 200: dailyMessagesImportResultSchema, 400: apiErrorSchema, 404: apiErrorSchema }
      }
    },
    async (request): Promise<DailyMessagesImportResult> => {
      const admin = authUser(request);
      const { text, entries: jsonEntries, mode } = request.body;
      const { entries, errors } = combineEntries(text, jsonEntries);
      if (errors.length > 0) {
        throw new AppError("VALIDATION", "El archivo tiene errores; no se guardó ningún mensaje.", { details: errors });
      }
      if (entries.length === 0) {
        const message = "El archivo no tiene mensajes.";
        throw new AppError("VALIDATION", message, { details: [{ path: "text", message }] });
      }

      return app.db.transaction(async (tx) => {
        // Lock the edition so two imports cannot interleave.
        const cuencada = await getCuencadaById(tx, request.params.id, true);
        const dates = entries.map((entry) => entry.date);
        const existing = await tx
          .select({ date: dailyMessages.date })
          .from(dailyMessages)
          .where(and(eq(dailyMessages.cuencadaId, cuencada.id), inArray(dailyMessages.date, dates)));
        let deleted = 0;
        if (mode === DailyMessagesImportMode.Replace) {
          const removed = await tx
            .delete(dailyMessages)
            .where(and(eq(dailyMessages.cuencadaId, cuencada.id), notInArray(dailyMessages.date, dates)))
            .returning({ id: dailyMessages.id });
          deleted = removed.length;
        }
        await upsertEntries(tx, cuencada.id, entries);
        const result = { created: entries.length - existing.length, updated: existing.length, deleted };
        await recordAudit(tx, {
          actorUserId: admin.id,
          action: AuditAction.DailyMessagesImported,
          entityType: AuditEntityType.Cuencada,
          entityId: cuencada.id,
          metadata: { mode, ...result },
          ip: request.ip
        });
        return result;
      });
    }
  );
};

export default dailyMessagesRoutes;
