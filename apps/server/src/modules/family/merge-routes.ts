/**
 * Admin "Fusionar personas" routes (WP-4.5) [SEC], mounted under `/api`:
 *
 * - `GET /api/admin/people/:id/merge-preview?duplicateId=` (`:id` = the person
 *   that stays): the side-by-side preview. It runs the merge in a transaction
 *   that is **always rolled back**, so it shows exactly what the merge would
 *   do (conflicts included) and never changes anything.
 * - `POST /api/admin/people/:id/merge` (`{ duplicateId, fields? }`): merge and
 *   remove the duplicate (see `merge.ts`); "Deshacer" is the usual
 *   `POST /api/admin/revisions/:revisionId/revert` on the `person.merge` row.
 * - `GET /api/admin/family/duplicates`: "Posibles duplicados" (`duplicates.ts`).
 *
 * Admin-only (`auth: "admin"`): the preview and the pairs carry PII. The
 * merge is rate limited per IP. Audit rows carry ids and counts only.
 */
import {
  apiErrorSchema,
  familyDuplicatesQuerySchema,
  idParamSchema,
  MergeEdgeRole,
  MergeEdgeOutcome,
  type Page,
  type PersonMergeEdge,
  type PersonMergeEdgeRecord,
  type PersonMergePreview,
  type PersonMergeResponse,
  type PersonMergeSide,
  type PossibleDuplicate,
  RelationshipKind,
  defaultMergeChoices,
  pageSchema,
  personMergeInputSchema,
  personMergePreviewQuerySchema,
  personMergePreviewSchema,
  personMergeResponseSchema,
  possibleDuplicateSchema,
  FamilyIssueCode
} from "@cuencada/types";
import { eq, inArray, or } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { people, personRelationships, users } from "../../db/schema/index.js";
import type { DbOrTx } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { rateLimitByIp } from "../../lib/rateLimit.js";
import { authUser } from "../../plugins/auth.js";
import type { AvatarUrlDeps } from "../profile/avatar.js";
import { findPossibleDuplicates } from "./duplicates.js";
import { type MergePlan, mergePeopleTx, mergeValuesOf } from "./merge.js";
import { deleteLosingPhotoObjects } from "./mergePhoto.js";
import { findPerson, type PersonViewRow, toPersonWithAvatar, type Viewer } from "./repository.js";

/** Thrown to roll the preview's transaction back. */
class PreviewRollback extends Error {
  constructor() {
    super("merge preview rollback");
    this.name = "PreviewRollback";
  }
}

const offsetCursorSchema = z.tuple([z.number().int().min(0).max(1_000_000)]);

function encodeOffset(offset: number): string {
  return Buffer.from(JSON.stringify([offset])).toString("base64url");
}

/** @throws AppError `VALIDATION` for a malformed cursor. */
function decodeOffset(value: string | undefined): number {
  if (value === undefined) return 0;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    raw = undefined;
  }
  const parsed = offsetCursorSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError("VALIDATION", "Cursor inválido.", { details: [{ path: "cursor", message: "Cursor inválido." }] });
  }
  return parsed.data[0];
}

/** Role of the relative at the other end of `edge`, seen from `personId`. */
function roleOf(edge: Pick<PersonMergeEdgeRecord, "kind" | "fromPersonId">, personId: string): MergeEdgeRole {
  if (edge.kind === RelationshipKind.PartnerOf) return MergeEdgeRole.Partner;
  return edge.fromPersonId === personId ? MergeEdgeRole.Child : MergeEdgeRole.Parent;
}

/** Names of `ids` (people that exist). */
async function namesOf(db: DbOrTx, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: people.id, fullName: people.fullName }).from(people).where(inArray(people.id, [...ids]));
  return new Map(rows.map((row) => [row.id, row.fullName]));
}

/** Everything the preview needs that the plan does not hold, read inside the rolled-back transaction. */
interface PreviewReads {
  keepView: PersonViewRow;
  duplicateView: PersonViewRow;
  accountNames: Map<string, string>;
  relationshipCounts: { keep: number; duplicate: number };
  names: Map<string, string>;
  hasTreePhoto: { keep: boolean; duplicate: boolean };
}

async function relationshipCount(db: DbOrTx, personId: string): Promise<number> {
  const rows = await db
    .select({ id: personRelationships.id })
    .from(personRelationships)
    .where(or(eq(personRelationships.fromPersonId, personId), eq(personRelationships.toPersonId, personId)));
  return rows.length;
}

/** Map a plan (and the reads) to the preview contract. */
async function toPreview(app: AvatarUrlDeps, plan: MergePlan, reads: PreviewReads, viewer: Viewer): Promise<PersonMergePreview> {
  const duplicateId = plan.duplicate.id;
  const edgeView = (edge: PersonMergeEdgeRecord): PersonMergeEdge => {
    const other = edge.fromPersonId === duplicateId ? edge.toPersonId : edge.fromPersonId;
    const self = edge.outcome === MergeEdgeOutcome.Self;
    return {
      id: edge.id,
      kind: edge.kind,
      otherPersonId: self ? null : other,
      otherPersonName: self ? plan.keep.fullName : (reads.names.get(other) ?? null),
      role: roleOf(edge, duplicateId),
      outcome: edge.outcome
    };
  };
  const conflictIds = new Set(plan.conflicts.map((conflict) => conflict.edge.id));
  const side = async (view: PersonViewRow, count: number, hasTreePhoto: boolean): Promise<PersonMergeSide> => ({
    person: await toPersonWithAvatar(app, view, viewer),
    values: mergeValuesOf(view),
    accountName: view.userId === null ? null : (reads.accountNames.get(view.userId) ?? null),
    hasTreePhoto,
    relationshipCount: count
  });
  const blockers: FamilyIssueCode[] = [];
  if (plan.bothLinked) blockers.push(FamilyIssueCode.MergeBothLinked);
  if (plan.conflicts.length > 0) blockers.push(FamilyIssueCode.MergeConflict);
  return {
    keep: await side(reads.keepView, reads.relationshipCounts.keep, reads.hasTreePhoto.keep),
    duplicate: await side(reads.duplicateView, reads.relationshipCounts.duplicate, reads.hasTreePhoto.duplicate),
    defaults: defaultMergeChoices(mergeValuesOf(plan.keep), mergeValuesOf(plan.duplicate)),
    relationships: {
      moved: plan.edges.filter((edge) => edge.outcome === MergeEdgeOutcome.Moved && !conflictIds.has(edge.id)).map(edgeView),
      dropped: plan.edges.filter((edge) => edge.outcome !== MergeEdgeOutcome.Moved).map(edgeView),
      conflicts: plan.conflicts.map((conflict) => ({ ...edgeView(conflict.edge), reason: conflict.reason }))
    },
    photo: {
      result: plan.photo.keep ? "keep" : plan.photo.duplicate ? "duplicate" : "none",
      deletesDuplicatePhoto: plan.photo.keep && plan.photo.duplicate
    },
    account: {
      result: plan.linkMoves ? "moved" : plan.keep.userId !== null ? "keep" : "none",
      bothLinked: plan.bothLinked
    },
    invites: { move: plan.invites.move.length, revoke: plan.invites.revoke.length },
    attendance: { move: plan.attendance.move.length, drop: plan.attendance.droppedCuencadaIds.length },
    blockers
  };
}

/** Admin merge routes (mounted under `/api`). */
const mergeRoutes: FastifyPluginAsyncZod = async (app) => {
  /** `GET /api/admin/people/:id/merge-preview?duplicateId=`: what merging `duplicateId` into `:id` would do. */
  app.get(
    "/admin/people/:id/merge-preview",
    {
      config: { auth: "admin", rateLimit: rateLimitByIp({ max: 120, timeWindow: "1 minute" }) },
      schema: {
        params: idParamSchema,
        querystring: personMergePreviewQuerySchema,
        response: { 200: personMergePreviewSchema, 400: apiErrorSchema, 404: apiErrorSchema }
      }
    },
    async (request): Promise<PersonMergePreview> => {
      const admin = authUser(request);
      const keepId = request.params.id.toLowerCase();
      const duplicateId = request.query.duplicateId.toLowerCase();
      let captured: { plan: MergePlan; reads: PreviewReads } | undefined;
      try {
        await app.db.transaction(async (tx) => {
          // Read the "before" state first (the dry run moves edges inside this transaction).
          const keepView = await findPerson(tx, keepId);
          const duplicateView = await findPerson(tx, duplicateId);
          const counts = {
            keep: keepView === undefined ? 0 : await relationshipCount(tx, keepId),
            duplicate: duplicateView === undefined ? 0 : await relationshipCount(tx, duplicateId)
          };
          const { plan } = await mergePeopleTx(tx, keepId, duplicateId, {}, { id: admin.id, ip: request.ip }, { dryRun: true, now: app.clock.now() });
          if (keepView === undefined || duplicateView === undefined) throw new Error("merge preview: person vanished under lock");
          const accountIds = [keepView.userId, duplicateView.userId].filter((id): id is string => id !== null);
          const accounts =
            accountIds.length === 0 ? [] : await tx.select({ id: users.id, displayName: users.displayName }).from(users).where(inArray(users.id, accountIds));
          const otherIds = plan.edges.map((edge) => (edge.fromPersonId === duplicateId ? edge.toPersonId : edge.fromPersonId));
          captured = {
            plan,
            reads: {
              keepView,
              duplicateView,
              accountNames: new Map(accounts.map((row) => [row.id, row.displayName])),
              relationshipCounts: counts,
              names: await namesOf(tx, otherIds),
              hasTreePhoto: { keep: keepView.photoKey !== null, duplicate: duplicateView.photoKey !== null }
            }
          };
          throw new PreviewRollback();
        });
      } catch (error) {
        if (!(error instanceof PreviewRollback)) throw error;
      }
      if (captured === undefined) throw new Error("merge preview: no plan captured");
      return toPreview(app, captured.plan, captured.reads, admin);
    }
  );

  /** `POST /api/admin/people/:id/merge`: merge `duplicateId` into `:id` and remove it (one transaction). */
  app.post(
    "/admin/people/:id/merge",
    {
      config: { auth: "admin", rateLimit: rateLimitByIp({ max: 30, timeWindow: "1 hour" }) },
      schema: {
        params: idParamSchema,
        body: personMergeInputSchema,
        response: { 200: personMergeResponseSchema, 400: apiErrorSchema, 404: apiErrorSchema, 409: apiErrorSchema }
      }
    },
    async (request): Promise<PersonMergeResponse> => {
      const admin = authUser(request);
      const keepId = request.params.id.toLowerCase();
      const { duplicateId, fields } = request.body;
      const outcome = await app.db.transaction(async (tx) => {
        const { result } = await mergePeopleTx(tx, keepId, duplicateId.toLowerCase(), fields ?? {}, { id: admin.id, ip: request.ip }, {
          dryRun: false,
          now: app.clock.now()
        });
        if (result === null) throw new Error("merge returned no result");
        const view = await findPerson(tx, result.keepId);
        if (view === undefined) throw new Error("kept person vanished inside the merge transaction");
        return { result, view };
      });
      // The duplicate's losing tree photo goes after the commit (best effort, like a person delete).
      await deleteLosingPhotoObjects(app, outcome.result.duplicateId, outcome.result.photoKeys);
      return {
        person: await toPersonWithAvatar(app, outcome.view, admin),
        revisionId: outcome.result.revisionId,
        revertible: true
      };
    }
  );

  /** `GET /api/admin/family/duplicates`: "Posibles duplicados", offset-paged. */
  app.get(
    "/admin/family/duplicates",
    {
      config: { auth: "admin", rateLimit: rateLimitByIp({ max: 120, timeWindow: "1 minute" }) },
      schema: {
        querystring: familyDuplicatesQuerySchema,
        response: { 200: pageSchema(possibleDuplicateSchema), 400: apiErrorSchema }
      }
    },
    async (request): Promise<Page<PossibleDuplicate>> => {
      const { cursor, limit } = request.query;
      const offset = decodeOffset(cursor);
      const all = await findPossibleDuplicates(app.db);
      const items = all.slice(offset, offset + limit);
      return { items, nextCursor: offset + limit < all.length ? encodeOffset(offset + limit) : null };
    }
  );
};

export default mergeRoutes;
