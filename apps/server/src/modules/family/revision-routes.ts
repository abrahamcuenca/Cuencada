/**
 * Admin-only revision routes (WP-4.1): the per-person "Historial", the global
 * "Actividad del árbol" feed, "Deshacer" and the history purge.
 *
 * [SEC] Revisions hold PII (snapshots with names, dates, birthplace, bio):
 * every route here is `auth: "admin"`. Cursors carry only a revision id.
 * Audit rows carry ids and counts only.
 */
import {
  apiErrorSchema,
  AuditEntityType,
  type FamilyActivityItem,
  familyActivityItemSchema,
  familyActivityQuerySchema,
  idParamSchema,
  type Page,
  type PersonRevision,
  pageSchema,
  personRevisionSchema,
  personRevisionsQuerySchema,
  purgePersonRevisionsInputSchema,
  type PurgePersonRevisionsResponse,
  purgePersonRevisionsResponseSchema,
  revertPersonRevisionInputSchema
} from "@cuencada/types";
import { and, eq, type SQL } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { personRevisions } from "../../db/schema/index.js";
import { recordAudit } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { authUser } from "../../plugins/auth.js";
import { deletePersonPhotoObjects } from "./personPhotoObjects.js";
import { revertRevisionTx } from "./revert.js";
import {
  activityNames,
  purgePersonRevisions,
  revisionsAboutPerson,
  revisionViewColumns,
  selectRevisionPage,
  toPersonRevision
} from "./revisions.js";
import { users } from "../../db/schema/index.js";
import { FamilyAuditAction } from "./writes.js";

const cursorPayloadSchema = z.tuple([z.uuid()]);

function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify([id])).toString("base64url");
}

/**
 * @throws AppError `VALIDATION` for a malformed cursor (client input).
 */
function decodeCursor(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
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
  return parsed.data[0];
}

/** Admin revision routes (mounted under `/api`). */
const revisionRoutes: FastifyPluginAsyncZod = async (app) => {
  /** `GET /api/admin/people/:id/revisions`: the person's history, newest first (also after the person is deleted). */
  app.get(
    "/admin/people/:id/revisions",
    {
      config: { auth: "admin" },
      schema: {
        params: idParamSchema,
        querystring: personRevisionsQuerySchema,
        response: { 200: pageSchema(personRevisionSchema), 400: apiErrorSchema }
      }
    },
    async (request): Promise<Page<PersonRevision>> => {
      const { cursor, limit } = request.query;
      const rows = await selectRevisionPage(
        app.db,
        revisionsAboutPerson(request.params.id.toLowerCase()),
        decodeCursor(cursor),
        limit
      );
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(toPersonRevision),
        nextCursor: rows.length > limit && last !== undefined ? encodeCursor(last.id) : null
      };
    }
  );

  /** `GET /api/admin/family/activity`: every family change, newest first, filterable by actor and action. */
  app.get(
    "/admin/family/activity",
    {
      config: { auth: "admin" },
      schema: {
        querystring: familyActivityQuerySchema,
        response: { 200: pageSchema(familyActivityItemSchema), 400: apiErrorSchema }
      }
    },
    async (request): Promise<Page<FamilyActivityItem>> => {
      const { cursor, limit, actorUserId, action } = request.query;
      const filters: Array<SQL | undefined> = [
        actorUserId === undefined ? undefined : eq(personRevisions.actorUserId, actorUserId),
        action === undefined ? undefined : eq(personRevisions.action, action)
      ];
      const rows = await selectRevisionPage(app.db, and(...filters), decodeCursor(cursor), limit);
      const page = rows.slice(0, limit);
      const names = await activityNames(app.db, page);
      const last = page.at(-1);
      return {
        items: page.map((row) => ({ ...toPersonRevision(row), personName: names.get(row.id) ?? null })),
        nextCursor: rows.length > limit && last !== undefined ? encodeCursor(last.id) : null
      };
    }
  );

  /** `POST /api/admin/revisions/:revisionId/revert` ("Deshacer"): 409 when already reverted, not revertible or stale. */
  app.post(
    "/admin/revisions/:revisionId/revert",
    {
      config: { auth: "admin" },
      schema: {
        params: revertPersonRevisionInputSchema,
        response: { 200: personRevisionSchema, 400: apiErrorSchema, 404: apiErrorSchema, 409: apiErrorSchema }
      }
    },
    async (request): Promise<PersonRevision> => {
      const admin = authUser(request);
      const { revision, result } = await app.db.transaction(async (tx) => {
        const outcome = await revertRevisionTx(tx, request.params.revisionId, { id: admin.id, ip: request.ip });
        const [row] = await tx
          .select(revisionViewColumns)
          .from(personRevisions)
          .leftJoin(users, eq(users.id, personRevisions.actorUserId))
          .where(eq(personRevisions.id, outcome.revertId))
          .limit(1);
        if (row === undefined) throw new Error("revert revision vanished inside its transaction");
        return { revision: toPersonRevision(row), result: outcome };
      });
      // An undone addition goes like any deleted person: its photo objects after the commit.
      if (result.deletedPersonId !== null) await deletePersonPhotoObjects(app, result.deletedPersonId, result.photoKeys);
      return revision;
    }
  );

  /**
   * `POST /api/admin/people/:id/revisions/purge` (`{ confirm: true }`): erase
   * every revision about the person (Security L2), also after it was deleted.
   */
  app.post(
    "/admin/people/:id/revisions/purge",
    {
      config: { auth: "admin" },
      schema: {
        params: idParamSchema,
        body: purgePersonRevisionsInputSchema,
        response: { 200: purgePersonRevisionsResponseSchema, 400: apiErrorSchema }
      }
    },
    async (request): Promise<PurgePersonRevisionsResponse> => {
      const admin = authUser(request);
      const personId = request.params.id.toLowerCase();
      return app.db.transaction(async (tx) => {
        const deleted = await purgePersonRevisions(tx, personId);
        await recordAudit(tx, {
          actorUserId: admin.id,
          action: FamilyAuditAction.RevisionsPurged,
          entityType: AuditEntityType.Person,
          entityId: personId,
          metadata: { deleted },
          ip: request.ip
        });
        return { deleted };
      });
    }
  );
};

export default revisionRoutes;
