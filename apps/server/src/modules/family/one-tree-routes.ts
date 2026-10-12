/**
 * "One family tree" routes (WP-6.4) [SEC], mounted under `/api`. Rules:
 * ADR 0001 §6 and §8; contracts in `@cuencada/types` (`treeLinks.ts`).
 *
 * Members (verified email):
 * - `POST|GET /family/proposals`, `DELETE /family/proposals/:id`: propose,
 *   list and withdraw **their own** tree-link proposals (404 for others').
 * - `GET /family/settings`: the root ancestor.
 * - `GET /family/tree/extended`: tíos, primos, tíos abuelos.
 * - `GET /family/overview`, `GET /family/overview/path`: "Árbol completo".
 *
 * Admins:
 * - `GET /admin/family/proposals[/:id]`, `POST /admin/family/proposals/:id/resolve`.
 * - `GET|PUT /admin/family/settings`.
 * - `GET /admin/family/branches`: "Ramas sin conectar".
 */
import {
  apiErrorSchema,
  type DisconnectedBranchReport,
  disconnectedBranchesQuerySchema,
  disconnectedBranchReportSchema,
  type ExtendedFamily,
  extendedFamilyQuerySchema,
  extendedFamilySchema,
  type FamilySettings,
  familySettingsSchema,
  idParamSchema,
  type Page,
  createTreeLinkProposalInputSchema,
  resolveTreeLinkProposalInputSchema,
  type TreeLinkProposal,
  type TreeLinkProposalGroup,
  type TreeOverview,
  type TreeOverviewPath,
  treeLinkProposalGroupPageSchema,
  treeLinkProposalListQuerySchema,
  treeLinkProposalPageSchema,
  treeLinkProposalSchema,
  treeOverviewPathQuerySchema,
  treeOverviewPathSchema,
  treeOverviewQuerySchema,
  treeOverviewSchema,
  updateFamilySettingsInputSchema
} from "@cuencada/types";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { AppError } from "../../lib/errors.js";
import { rateLimitByUser } from "../media/shared.js";
import { pushNotifications } from "../notifications/notify.js";
import { authUser } from "../../plugins/auth.js";
import { loadFamilyCircle } from "./circle.js";
import { deleteLosingPhotoObjects } from "./mergePhoto.js";
import { loadDisconnectedBranches, loadExtendedFamily, loadOverviewPath, loadTreeOverview } from "./oneTree.js";
import {
  ProposalMessage,
  createProposalTx,
  findProposal,
  listOwnProposals,
  listProposalGroups,
  resolveProposalTx,
  toProposalGroups,
  toProposals,
  withdrawProposalTx
} from "./proposals.js";
import { findPersonByUserId, type Viewer } from "./repository.js";
import { loadFamilySettings, updateFamilySettingsTx } from "./settings.js";

const NOT_LINKED_MESSAGE = "Tu cuenta no está vinculada a ninguna persona del árbol familiar.";

/** Proposal creation per member per hour, on top of the 20-per-day database count (ADR 0001 §8). */
export const PROPOSAL_ROUTE_LIMIT = { max: 30, timeWindow: "1 hour" } as const;
/** Admin resolves and settings writes per admin per hour. */
const ADMIN_TREE_WRITE_LIMIT = { max: 120, timeWindow: "1 hour" } as const;
/** Tree reads per member per minute (each loads the whole graph). */
const TREE_READ_LIMIT = { max: 120, timeWindow: "1 minute" } as const;

const offsetCursorSchema = z.tuple([z.number().int().min(0).max(1_000_000)]);

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
  if (!parsed.success) throw new AppError("VALIDATION", "Cursor inválido.", { details: [{ path: "cursor", message: "Cursor inválido." }] });
  return parsed.data[0];
}

/** "One family tree" routes (mounted under `/api`). */
const oneTreeRoutes: FastifyPluginAsyncZod = async (app) => {
  const memberConfig = { auth: "user", requireVerifiedEmail: true } as const;
  const readLimit = rateLimitByUser("family-tree-read", TREE_READ_LIMIT);
  const adminWriteLimit = rateLimitByUser("admin-tree-write", ADMIN_TREE_WRITE_LIMIT);

  /* ------------------------------ Proposals ------------------------------ */

  /** `POST /api/family/proposals`: "Es la misma persona" / "Conectar con…". */
  app.post(
    "/family/proposals",
    {
      config: { ...memberConfig, rateLimit: rateLimitByUser("tree-proposal", PROPOSAL_ROUTE_LIMIT) },
      schema: {
        body: createTreeLinkProposalInputSchema,
        response: { 201: treeLinkProposalSchema, 400: apiErrorSchema, 404: apiErrorSchema, 409: apiErrorSchema, 429: apiErrorSchema }
      }
    },
    async (request, reply): Promise<TreeLinkProposal> => {
      const user = authUser(request);
      const viewer: Viewer = { id: user.id, role: user.role };
      const row = await app.db.transaction(async (tx) =>
        createProposalTx(tx, request.body, { id: user.id, ip: request.ip, role: user.role }, app.clock.now())
      );
      const [proposal] = await toProposals(app, [row], viewer);
      if (proposal === undefined) throw new Error("created proposal could not be mapped");
      return reply.code(201).send(proposal);
    }
  );

  /** `GET /api/family/proposals`: the caller's own proposals ("Mis propuestas"), newest first. */
  app.get(
    "/family/proposals",
    {
      config: { ...memberConfig, rateLimit: readLimit },
      schema: { querystring: treeLinkProposalListQuerySchema, response: { 200: treeLinkProposalPageSchema, 400: apiErrorSchema } }
    },
    async (request): Promise<Page<TreeLinkProposal>> => {
      const user = authUser(request);
      const { rows, nextCursor } = await listOwnProposals(app.db, user.id, request.query);
      return { items: await toProposals(app, rows, { id: user.id, role: user.role }), nextCursor };
    }
  );

  /** `DELETE /api/family/proposals/:id`: the proposer withdraws a pending proposal (404 for anyone else). */
  app.delete(
    "/family/proposals/:id",
    {
      config: { ...memberConfig, rateLimit: rateLimitByUser("tree-proposal-withdraw", PROPOSAL_ROUTE_LIMIT) },
      schema: { params: idParamSchema, response: { 204: z.null(), 404: apiErrorSchema, 409: apiErrorSchema } }
    },
    async (request, reply) => {
      const user = authUser(request);
      await app.db.transaction(async (tx) => withdrawProposalTx(tx, request.params.id.toLowerCase(), { id: user.id, ip: request.ip }));
      return reply.code(204).send(null);
    }
  );

  /** `GET /api/admin/family/proposals`: "Propuestas del árbol", grouped by pair (pending first). */
  app.get(
    "/admin/family/proposals",
    {
      config: { auth: "admin" },
      schema: { querystring: treeLinkProposalListQuerySchema, response: { 200: treeLinkProposalGroupPageSchema, 400: apiErrorSchema } }
    },
    async (request): Promise<Page<TreeLinkProposalGroup>> => {
      const admin = authUser(request);
      const { groups, nextCursor } = await listProposalGroups(app.db, request.query);
      return { items: await toProposalGroups(app, groups, { id: admin.id, role: admin.role }), nextCursor };
    }
  );

  /** `GET /api/admin/family/proposals/:id`: one proposal (side-by-side with the merge preview). */
  app.get(
    "/admin/family/proposals/:id",
    {
      config: { auth: "admin" },
      schema: { params: idParamSchema, response: { 200: treeLinkProposalSchema, 404: apiErrorSchema } }
    },
    async (request): Promise<TreeLinkProposal> => {
      const admin = authUser(request);
      const row = await findProposal(app.db, request.params.id.toLowerCase());
      if (row === undefined) throw new AppError("NOT_FOUND", ProposalMessage.NotFound);
      const [proposal] = await toProposals(app, [row], { id: admin.id, role: admin.role });
      if (proposal === undefined) throw new Error("proposal could not be mapped");
      return proposal;
    }
  );

  /** `POST /api/admin/family/proposals/:id/resolve`: approve (merge or edge, same transaction) or reject. */
  app.post(
    "/admin/family/proposals/:id/resolve",
    {
      config: { auth: "admin", rateLimit: adminWriteLimit },
      schema: {
        params: idParamSchema,
        body: resolveTreeLinkProposalInputSchema,
        response: { 200: treeLinkProposalSchema, 400: apiErrorSchema, 404: apiErrorSchema, 409: apiErrorSchema, 429: apiErrorSchema }
      }
    },
    async (request): Promise<TreeLinkProposal> => {
      const admin = authUser(request);
      const id = request.params.id.toLowerCase();
      const outcome = await app.db.transaction(async (tx) =>
        resolveProposalTx(tx, id, request.body, { id: admin.id, ip: request.ip }, app.clock.now())
      );
      // After the commit: the merged duplicate's losing photo objects, then the proposers' pushes (best effort).
      await deleteLosingPhotoObjects(app, outcome.photoKeys);
      await pushNotifications(app, outcome.notificationIds);
      const row = await findProposal(app.db, outcome.proposalId);
      if (row === undefined) throw new Error("resolved proposal vanished");
      const [proposal] = await toProposals(app, [row], { id: admin.id, role: admin.role });
      if (proposal === undefined) throw new Error("proposal could not be mapped");
      return proposal;
    }
  );

  /* ------------------------------- Settings ------------------------------ */

  /** `GET /api/family/settings`: the root ancestor (members). */
  app.get(
    "/family/settings",
    { config: memberConfig, schema: { response: { 200: familySettingsSchema } } },
    async (request): Promise<FamilySettings> => {
      const user = authUser(request);
      return loadFamilySettings(app, { id: user.id, role: user.role });
    }
  );

  /** `GET /api/admin/family/settings`. */
  app.get(
    "/admin/family/settings",
    { config: { auth: "admin" }, schema: { response: { 200: familySettingsSchema } } },
    async (request): Promise<FamilySettings> => {
      const admin = authUser(request);
      return loadFamilySettings(app, { id: admin.id, role: admin.role });
    }
  );

  /** `PUT /api/admin/family/settings`: set or clear "Raíz del árbol" (upsert; audited). */
  app.put(
    "/admin/family/settings",
    {
      config: { auth: "admin", rateLimit: adminWriteLimit },
      schema: { body: updateFamilySettingsInputSchema, response: { 200: familySettingsSchema, 400: apiErrorSchema, 429: apiErrorSchema } }
    },
    async (request): Promise<FamilySettings> => {
      const admin = authUser(request);
      const rootPersonId = request.body.rootPersonId === null ? null : request.body.rootPersonId.toLowerCase();
      await app.db.transaction(async (tx) => updateFamilySettingsTx(tx, rootPersonId, { id: admin.id, ip: request.ip }));
      return loadFamilySettings(app, { id: admin.id, role: admin.role });
    }
  );

  /* ------------------------------ Tree reads ----------------------------- */

  /** `GET /api/family/tree/extended?personId=`: tíos, primos, tíos abuelos (default: the caller's person). */
  app.get(
    "/family/tree/extended",
    {
      config: { ...memberConfig, rateLimit: readLimit },
      schema: { querystring: extendedFamilyQuerySchema, response: { 200: extendedFamilySchema, 404: apiErrorSchema } }
    },
    async (request): Promise<ExtendedFamily> => {
      const user = authUser(request);
      let focusId = request.query.personId?.toLowerCase();
      if (focusId === undefined) {
        const own = await findPersonByUserId(app.db, user.id);
        if (own === undefined) throw new AppError("NOT_FOUND", NOT_LINKED_MESSAGE);
        focusId = own.id;
      }
      return loadExtendedFamily(app, focusId, { id: user.id, role: user.role });
    }
  );

  /** `GET /api/family/overview?personId=&depth=`: "Árbol completo" (names only). */
  app.get(
    "/family/overview",
    {
      config: { ...memberConfig, rateLimit: readLimit },
      schema: { querystring: treeOverviewQuerySchema, response: { 200: treeOverviewSchema, 404: apiErrorSchema } }
    },
    async (request): Promise<TreeOverview> => {
      const user = authUser(request);
      const own = await findPersonByUserId(app.db, user.id);
      // Living people's birth years follow the qualifying circle (ADR 0001 §6).
      const circle = user.role === "admin" ? undefined : (await loadFamilyCircle(app.db, user.id)).ids;
      const { personId, depth } = request.query;
      return loadTreeOverview(
        app,
        personId === undefined ? { depth } : { personId: personId.toLowerCase(), depth },
        { id: user.id, role: user.role, circle },
        own?.id ?? null
      );
    }
  );

  /** `GET /api/family/overview/path?personId=`: the outline path from the root ("Ir a mí"). */
  app.get(
    "/family/overview/path",
    {
      config: { ...memberConfig, rateLimit: readLimit },
      schema: { querystring: treeOverviewPathQuerySchema, response: { 200: treeOverviewPathSchema } }
    },
    async (request): Promise<TreeOverviewPath> => loadOverviewPath(app.db, request.query.personId.toLowerCase())
  );

  /** `GET /api/admin/family/branches`: "Ramas sin conectar" (offset-paged, largest first). */
  app.get(
    "/admin/family/branches",
    {
      config: { auth: "admin" },
      schema: { querystring: disconnectedBranchesQuerySchema, response: { 200: disconnectedBranchReportSchema, 400: apiErrorSchema } }
    },
    async (request): Promise<DisconnectedBranchReport> => {
      const admin = authUser(request);
      const offset = decodeOffset(request.query.cursor);
      const { limit } = request.query;
      const report = await loadDisconnectedBranches(app, { offset, limit }, request.query.includeSingles === true, {
        id: admin.id,
        role: admin.role
      });
      const nextOffset = offset + limit;
      return {
        rootPersonId: report.rootPersonId,
        items: report.items,
        nextCursor: nextOffset < report.total ? Buffer.from(JSON.stringify([nextOffset])).toString("base64url") : null
      };
    }
  );
};

export default oneTreeRoutes;
