/**
 * Admin RSVP and attendance routes under `/api/admin/cuencadas/:id`:
 * the RSVP table and its CSV export, and historical attendance (list,
 * add/remove, replace the whole set). Drafts are included.
 *
 * Audit metadata holds counts only, never names, emails or notes.
 */
import {
  type AdminRsvpRow,
  type AttendanceRecord,
  AuditAction,
  AuditEntityType,
  adminAttendanceBulkInputSchema,
  adminAttendanceReplaceInputSchema,
  adminRsvpRowSchema,
  apiErrorSchema,
  attendanceRecordSchema,
  idParamSchema
} from "@cuencada/types";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { type DbOrTx, recordAudit } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { rateLimitByIp } from "../../lib/rateLimit.js";
import { authUser } from "../../plugins/auth.js";
import { getCuencadaById } from "../cuencadas/repository.js";
import { toCsv } from "./csv.js";
import {
  type AdminRsvpRecord,
  addAttendance,
  existingPersonIds,
  listAdminRsvps,
  listAttendance,
  removeAttendance,
  removeAttendanceExcept
} from "./repository.js";

const UNKNOWN_PERSON = "No encontramos a esta persona.";

/** CSV columns: exactly the `AdminRsvpRow` keys, in contract order. */
const CSV_COLUMNS = [
  "userId",
  "personId",
  "displayName",
  "email",
  "status",
  "guestCount",
  "arrivalDate",
  "departureDate",
  "hotelName",
  "notes",
  "updatedAt"
] as const satisfies ReadonlyArray<keyof AdminRsvpRow>;

function toAdminRsvpRow(record: AdminRsvpRecord): AdminRsvpRow {
  return { ...record, updatedAt: record.updatedAt.toISOString() };
}

async function attendanceRecords(db: DbOrTx, cuencadaId: string): Promise<AttendanceRecord[]> {
  const rows = await listAttendance(db, cuencadaId);
  return rows.map((row) => ({
    personId: row.personId,
    displayName: row.fullName,
    createdAt: row.createdAt.toISOString()
  }));
}

/**
 * 400 `VALIDATION` listing every id in `ids` that is not a person.
 *
 * @param db - Transaction.
 * @param ids - Person ids from the body.
 * @param path - Body field for the error details (`add`, `personIds`).
 */
async function assertPeopleExist(db: DbOrTx, ids: readonly string[], path: string): Promise<void> {
  const found = await existingPersonIds(db, ids);
  const details = ids.flatMap((id, index) =>
    found.has(id) ? [] : [{ path: `${path}.${index}`, message: UNKNOWN_PERSON }]
  );
  if (details.length > 0) throw new AppError("VALIDATION", UNKNOWN_PERSON, { details });
}

/** Admin RSVP/attendance routes under `/api`. */
const rsvpAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  /** `GET /api/admin/cuencadas/:id/rsvps`: every RSVP with name, email, dates and hotel (PII, admin only). */
  app.get(
    "/admin/cuencadas/:id/rsvps",
    {
      config: { auth: "admin" },
      schema: {
        params: idParamSchema,
        response: { 200: z.array(adminRsvpRowSchema), 404: apiErrorSchema }
      }
    },
    async (request): Promise<AdminRsvpRow[]> => {
      const edition = await getCuencadaById(app.db, request.params.id);
      return (await listAdminRsvps(app.db, edition.id)).map(toAdminRsvpRow);
    }
  );

  /**
   * `GET /api/admin/cuencadas/:id/rsvps.csv`: the same table as a UTF-8 CSV
   * with BOM, formula-injection safe, downloaded as an attachment. Audited.
   */
  app.get(
    "/admin/cuencadas/:id/rsvps.csv",
    {
      config: {
        auth: "admin",
        rateLimit: rateLimitByIp({ max: 20, timeWindow: "1 minute" })
      },
      schema: {
        params: idParamSchema,
        response: { 200: z.string(), 404: apiErrorSchema }
      }
    },
    async (request, reply) => {
      const admin = authUser(request);
      const { csv, year } = await app.db.transaction(async (tx) => {
        const edition = await getCuencadaById(tx, request.params.id);
        const rows = (await listAdminRsvps(tx, edition.id)).map(toAdminRsvpRow);
        await recordAudit(tx, {
          actorUserId: admin.id,
          action: AuditAction.RsvpExported,
          entityType: AuditEntityType.Cuencada,
          entityId: edition.id,
          metadata: { rows: rows.length },
          ip: request.ip
        });
        return {
          year: edition.year,
          csv: toCsv(
            CSV_COLUMNS,
            rows.map((row) => CSV_COLUMNS.map((column) => row[column]))
          )
        };
      });
      // A string body with a non-JSON content type is sent as-is (no JSON serializer).
      return reply
        .header("content-disposition", `attachment; filename="cuencada-${year}-rsvps.csv"`)
        .header("cache-control", "no-store")
        .type("text/csv; charset=utf-8")
        .send(csv);
    }
  );

  /** `GET /api/admin/cuencadas/:id/attendance`: historical attendance, by name. */
  app.get(
    "/admin/cuencadas/:id/attendance",
    {
      config: { auth: "admin" },
      schema: {
        params: idParamSchema,
        response: { 200: z.array(attendanceRecordSchema), 404: apiErrorSchema }
      }
    },
    async (request): Promise<AttendanceRecord[]> => {
      const edition = await getCuencadaById(app.db, request.params.id);
      return attendanceRecords(app.db, edition.id);
    }
  );

  /** `POST /api/admin/cuencadas/:id/attendance`: add and remove people in one transaction (contract). */
  app.post(
    "/admin/cuencadas/:id/attendance",
    {
      config: { auth: "admin" },
      schema: {
        params: idParamSchema,
        body: adminAttendanceBulkInputSchema,
        response: {
          200: z.array(attendanceRecordSchema),
          400: apiErrorSchema,
          404: apiErrorSchema
        }
      }
    },
    async (request): Promise<AttendanceRecord[]> => {
      const admin = authUser(request);
      const { add, remove } = request.body;
      return app.db.transaction(async (tx) => {
        // Lock the edition so concurrent attendance writes serialize.
        const edition = await getCuencadaById(tx, request.params.id, true);
        const uniqueAdd = [...new Set(add)];
        await assertPeopleExist(tx, uniqueAdd, "add");
        const removed = await removeAttendance(tx, edition.id, [...new Set(remove)]);
        const added = await addAttendance(tx, edition.id, uniqueAdd, admin.id, app.clock.now());
        const records = await attendanceRecords(tx, edition.id);
        await recordAudit(tx, {
          actorUserId: admin.id,
          action: AuditAction.AttendanceUpdated,
          entityType: AuditEntityType.Cuencada,
          entityId: edition.id,
          metadata: { mode: "patch", added, removed, total: records.length },
          ip: request.ip
        });
        return records;
      });
    }
  );

  /**
   * `PUT /api/admin/cuencadas/:id/attendance`: replace the edition's whole
   * attendance with `personIds` (amendment). Unknown ids → 400, nothing written.
   */
  app.put(
    "/admin/cuencadas/:id/attendance",
    {
      config: { auth: "admin" },
      schema: {
        params: idParamSchema,
        body: adminAttendanceReplaceInputSchema,
        response: {
          200: z.array(attendanceRecordSchema),
          400: apiErrorSchema,
          404: apiErrorSchema
        }
      }
    },
    async (request): Promise<AttendanceRecord[]> => {
      const admin = authUser(request);
      const { personIds } = request.body;
      return app.db.transaction(async (tx) => {
        const edition = await getCuencadaById(tx, request.params.id, true);
        await assertPeopleExist(tx, personIds, "personIds");
        const removed = await removeAttendanceExcept(tx, edition.id, personIds);
        const added = await addAttendance(tx, edition.id, personIds, admin.id, app.clock.now());
        const records = await attendanceRecords(tx, edition.id);
        await recordAudit(tx, {
          actorUserId: admin.id,
          action: AuditAction.AttendanceUpdated,
          entityType: AuditEntityType.Cuencada,
          entityId: edition.id,
          metadata: { mode: "replace", added, removed, total: records.length },
          ip: request.ip
        });
        return records;
      });
    }
  );
};

export default rsvpAdminRoutes;
