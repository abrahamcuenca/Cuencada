/**
 * Admin media moderation routes (T4): queue, reports and moderate
 * (approve / hide / delete). Mounted under `/api`; every route is admin-only.
 */
import {
  type AdminMediaItem,
  AuditAction,
  adminMediaItemSchema,
  adminMediaQuerySchema,
  idParamSchema,
  type MediaReport,
  mediaReportSchema,
  moderateMediaInputSchema,
  pageSchema
} from "@cuencada/types";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { mediaItems } from "../../db/schema/index.js";
import { recordAudit } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { authUser } from "../../plugins/auth.js";
import { allObjectKeys, findAdminRecord, listAdmin, listReports, type MediaRow, toAdminMediaItem } from "./service.js";
import { deleteObjectsQuietly, mediaErrorResponses, viewerOf } from "./shared.js";

const NOT_FOUND_MESSAGE = "No encontramos esa foto o video.";

const MODERATION_STATUS_BY_ACTION = {
  approve: "approved",
  hide: "hidden"
} as const satisfies Record<"approve" | "hide", MediaRow["moderationStatus"]>;

/** Admin moderation routes. */
const adminMediaRoutes: FastifyPluginAsyncZod = async (app) => {
  /** GET /api/admin/media — moderation queue (filters: moderationStatus, uploadStatus, cuencadaId, reported). */
  app.get(
    "/admin/media",
    {
      config: { auth: "admin" },
      schema: {
        querystring: adminMediaQuerySchema,
        response: { 200: pageSchema(adminMediaItemSchema), ...mediaErrorResponses }
      }
    },
    async (request) => {
      const viewer = viewerOf(authUser(request));
      const query = request.query;
      const page = await listAdmin(app.db, {
        limit: query.limit,
        cursor: query.cursor,
        moderationStatus: query.moderationStatus,
        uploadStatus: query.uploadStatus,
        cuencadaId: query.cuencadaId,
        reported: query.reported
      });
      const items = await Promise.all(page.records.map((record) => toAdminMediaItem(app.storage, record, viewer)));
      return { items, nextCursor: page.nextCursor };
    }
  );

  /** GET /api/admin/media/:id/reports — reports on one item (newest first). */
  app.get(
    "/admin/media/:id/reports",
    {
      config: { auth: "admin" },
      schema: { params: idParamSchema, response: { 200: z.array(mediaReportSchema), ...mediaErrorResponses } }
    },
    async (request): Promise<MediaReport[]> => {
      const record = await findAdminRecord(app.db, request.params.id);
      if (record === null) throw new AppError("NOT_FOUND", NOT_FOUND_MESSAGE);
      return listReports(app.db, record.item.id);
    }
  );

  /** POST /api/admin/media/:id/moderate — approve, hide or (soft) delete, with an optional note. */
  app.post(
    "/admin/media/:id/moderate",
    {
      config: { auth: "admin" },
      schema: {
        params: idParamSchema,
        body: moderateMediaInputSchema,
        response: { 200: adminMediaItemSchema, ...mediaErrorResponses }
      }
    },
    async (request): Promise<AdminMediaItem> => {
      const admin = authUser(request);
      const viewer = viewerOf(admin);
      const { action, note } = request.body;
      const record = await findAdminRecord(app.db, request.params.id);
      if (record === null) throw new AppError("NOT_FOUND", NOT_FOUND_MESSAGE);
      const now = app.clock.now();

      const updated = await app.db.transaction(async (tx) => {
        const moderation = { moderatedAt: now, moderatedByUserId: admin.id, moderationNote: note };
        const changes =
          action === "delete"
            ? { ...moderation, deletedAt: now, deletedByUserId: admin.id }
            : { ...moderation, moderationStatus: MODERATION_STATUS_BY_ACTION[action] };
        const [row] = await tx
          .update(mediaItems)
          .set(changes)
          .where(and(eq(mediaItems.id, record.item.id), isNull(mediaItems.deletedAt)))
          .returning();
        if (row === undefined) throw new AppError("NOT_FOUND", NOT_FOUND_MESSAGE);
        await recordAudit(tx, {
          actorUserId: admin.id,
          action: AuditAction.MediaModerated,
          entityType: "media",
          entityId: row.id,
          metadata: { action, previousStatus: record.item.moderationStatus, hasNote: note !== null },
          ip: request.ip
        });
        return row;
      });

      if (action === "delete") await deleteObjectsQuietly(app, updated.id, allObjectKeys(updated, record.year));
      return toAdminMediaItem(
        app.storage,
        { ...record, item: updated, moderatedByName: admin.displayName },
        viewer
      );
    }
  );
};

export default adminMediaRoutes;
