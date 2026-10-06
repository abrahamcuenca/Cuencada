/**
 * Audit log viewer [SEC]: read-only, newest first (`created_at desc, id desc`),
 * keyset-paginated. There is deliberately no update or delete endpoint.
 * Metadata is returned as stored: `recordAudit` scrubs it at write time.
 */
import {
  type AuditLogEntry,
  apiErrorSchema,
  auditLogEntrySchema,
  auditLogQuerySchema,
  type Page,
  pageSchema
} from "@cuencada/types";
import { and, desc, eq, gte, lte, type SQL, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { auditLogs, users } from "../../db/schema/index.js";
import { decodeCursor, encodeCursor } from "../media/cursor.js";

const cursorMicrosSql = sql<string>`(extract(epoch from ${auditLogs.createdAt}) * 1000000)::bigint::text`;

/** Audit log routes, mounted under `/api`. */
const adminAuditRoutes: FastifyPluginAsyncZod = async (app) => {
  /** `GET /api/admin/audit-logs`: filter by actor, action, entity and time range. */
  app.get(
    "/admin/audit-logs",
    {
      config: { auth: "admin" },
      schema: {
        querystring: auditLogQuerySchema,
        response: {
          200: pageSchema(auditLogEntrySchema),
          400: apiErrorSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
          429: apiErrorSchema
        }
      }
    },
    async (request): Promise<Page<AuditLogEntry>> => {
      const query = request.query;
      const conditions: Array<SQL | undefined> = [];
      if (query.actorUserId !== undefined) conditions.push(eq(auditLogs.actorUserId, query.actorUserId));
      if (query.action !== undefined) conditions.push(eq(auditLogs.action, query.action));
      if (query.entityType !== undefined) conditions.push(eq(auditLogs.entityType, query.entityType));
      if (query.entityId !== undefined) conditions.push(eq(auditLogs.entityId, query.entityId));
      if (query.from !== undefined) conditions.push(gte(auditLogs.createdAt, new Date(query.from)));
      if (query.to !== undefined) conditions.push(lte(auditLogs.createdAt, new Date(query.to)));
      if (query.cursor !== undefined) {
        const cursor = decodeCursor(query.cursor);
        conditions.push(
          sql`(${auditLogs.createdAt}, ${auditLogs.id}) < (to_timestamp(0) + ${cursor.micros}::bigint * interval '1 microsecond', ${cursor.id}::uuid)`
        );
      }

      const rows = await app.db
        .select({
          id: auditLogs.id,
          actorUserId: auditLogs.actorUserId,
          actorName: users.displayName,
          action: auditLogs.action,
          entityType: auditLogs.entityType,
          entityId: auditLogs.entityId,
          metadata: auditLogs.metadata,
          ip: auditLogs.ip,
          createdAt: auditLogs.createdAt,
          cursorMicros: cursorMicrosSql
        })
        .from(auditLogs)
        .leftJoin(users, eq(users.id, auditLogs.actorUserId))
        .where(and(...conditions))
        .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
        .limit(query.limit + 1);

      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        items: page.map((row) => ({
          id: row.id,
          actorUserId: row.actorUserId,
          actorName: row.actorName,
          action: row.action,
          entityType: row.entityType,
          entityId: row.entityId,
          metadata: row.metadata,
          ip: row.ip,
          createdAt: row.createdAt.toISOString()
        })),
        nextCursor:
          rows.length > query.limit && last !== undefined ? encodeCursor({ micros: last.cursorMicros, id: last.id }) : null
      };
    }
  );
};

export default adminAuditRoutes;
