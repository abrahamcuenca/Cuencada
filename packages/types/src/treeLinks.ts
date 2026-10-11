/**
 * One family tree (WP-6.0 contracts; WP-6.4 implements): member proposals to
 * connect branches ("Es la misma persona", "Conectar con…") that admins
 * approve, the root ancestor setting, the "Ramas sin conectar" report and the
 * extended tree reads (tíos, primos, tíos abuelos, "Árbol completo").
 * Authorization: ADR 0001 §6 (privacy of living people) and §8 (binding).
 *
 * Re-exported by `admin.ts` (the barrel is frozen; `family.ts` cannot
 * re-export it because this module imports `family.ts`).
 */
import { z } from "zod";
import { cursorQuerySchema, dateTimeSchema, idSchema, pageSchema, queryBooleanSchema } from "./common.js";
import { cleanNullableTextSchema } from "./events.js";
import {
  type PersonSummary,
  type RelationshipKind,
  personMergeFieldsSchema,
  personSummarySchema,
  relationshipKindSchema
} from "./family.js";

/* -------------------------------------------------------------------------- */
/* Proposals                                                                   */
/* -------------------------------------------------------------------------- */

/** Longest proposal note and resolution note (DB CHECKs). */
export const TREE_LINK_NOTE_MAX_LENGTH = 500;
/** Proposals a member may create per rolling day (admins exempt). */
export const TREE_LINK_PROPOSALS_PER_DAY = 20;

/**
 * `same_person`: `from` and `to` are the same human (approving merges them).
 * `relate`: connect them with `relation` (approving creates the edge).
 */
export const TreeLinkProposalKind = {
  SamePerson: "same_person",
  Relate: "relate"
} as const;
export type TreeLinkProposalKind = (typeof TreeLinkProposalKind)[keyof typeof TreeLinkProposalKind];
export const treeLinkProposalKindSchema = z.enum(TreeLinkProposalKind);

export const TreeLinkProposalStatus = {
  Pending: "pending",
  Approved: "approved",
  Rejected: "rejected",
  /** The proposer withdrew it, or it became moot (a person in it was deleted or merged away). */
  Withdrawn: "withdrawn"
} as const;
export type TreeLinkProposalStatus = (typeof TreeLinkProposalStatus)[keyof typeof TreeLinkProposalStatus];
export const treeLinkProposalStatusSchema = z.enum(TreeLinkProposalStatus);

/**
 * Stable reasons on proposal errors (`error.details[0].code`, the open
 * detail-code channel of ADR 0001 §4), sent with `path: "proposal"`.
 */
export const TreeLinkIssueCode = {
  /** 409 `CONFLICT`: a pending proposal for the same two people (either order, any kind) exists. */
  Duplicate: "PROPOSAL_DUPLICATE",
  /** 409 `CONFLICT`: resolving or withdrawing a proposal that is no longer pending. */
  NotPending: "PROPOSAL_NOT_PENDING"
} as const;
export type TreeLinkIssueCode = (typeof TreeLinkIssueCode)[keyof typeof TreeLinkIssueCode];

const noteSchema = cleanNullableTextSchema(TREE_LINK_NOTE_MAX_LENGTH, true);

/**
 * A proposal, as its proposer and admins see it (nobody else can read one).
 * `from`/`to` are `null` once that person was deleted (resolved proposals
 * keep their history; pending ones are withdrawn first).
 */
export interface TreeLinkProposal {
  id: string;
  kind: TreeLinkProposalKind;
  from: PersonSummary | null;
  to: PersonSummary | null;
  /** For `relate`: `parent_of` (from is a parent of to) or `partner_of`; `null` for `same_person`. */
  relation: RelationshipKind | null;
  note: string | null;
  status: TreeLinkProposalStatus;
  /** `null` once the proposer's account is removed. */
  proposedByName: string | null;
  /** The caller proposed it (may withdraw while pending). */
  isMine: boolean;
  resolvedByName: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  createdAt: string;
}

export const treeLinkProposalSchema = z.object({
  id: idSchema,
  kind: treeLinkProposalKindSchema,
  from: personSummarySchema.nullable(),
  to: personSummarySchema.nullable(),
  relation: relationshipKindSchema.nullable(),
  note: z.string().max(TREE_LINK_NOTE_MAX_LENGTH).nullable(),
  status: treeLinkProposalStatusSchema,
  proposedByName: z.string().max(80).nullable(),
  isMine: z.boolean(),
  resolvedByName: z.string().max(80).nullable(),
  resolvedAt: dateTimeSchema.nullable(),
  resolutionNote: z.string().max(TREE_LINK_NOTE_MAX_LENGTH).nullable(),
  createdAt: dateTimeSchema
}) satisfies z.ZodType<TreeLinkProposal>;

export const treeLinkProposalPageSchema = pageSchema(treeLinkProposalSchema);

/**
 * `POST /api/family/proposals` (any verified member; 20 per day). Any two
 * existing people may be named (the tree is readable by every verified
 * member); nothing changes in the tree until an admin approves.
 */
export const createTreeLinkProposalInputSchema = z
  .strictObject({
    kind: treeLinkProposalKindSchema,
    fromPersonId: idSchema,
    toPersonId: idSchema,
    relation: relationshipKindSchema.exactOptional(),
    note: noteSchema.default(null)
  })
  .superRefine((value, ctx) => {
    if (value.fromPersonId === value.toPersonId) {
      ctx.addIssue({ code: "custom", path: ["toPersonId"], message: "Elige a dos personas distintas." });
    }
    if (value.kind === TreeLinkProposalKind.Relate && value.relation === undefined) {
      ctx.addIssue({ code: "custom", path: ["relation"], message: "Indica el parentesco." });
    }
    if (value.kind === TreeLinkProposalKind.SamePerson && value.relation !== undefined) {
      ctx.addIssue({ code: "custom", path: ["relation"], message: "No aplica a la misma persona." });
    }
  });
export type CreateTreeLinkProposalInput = z.infer<typeof createTreeLinkProposalInputSchema>;
export type CreateTreeLinkProposalRequest = z.input<typeof createTreeLinkProposalInputSchema>;

export const TreeLinkDecision = {
  Approve: "approve",
  Reject: "reject"
} as const;
export type TreeLinkDecision = (typeof TreeLinkDecision)[keyof typeof TreeLinkDecision];

/**
 * `POST /api/admin/family/proposals/:id/resolve` (admin). Approving a
 * `same_person` proposal runs the WP-4.5 merge (`keepPersonId`: which of the
 * two stays, default `to`; `fields`: the merge's per-field choices), and a
 * `relate` one creates the edge (`createRelationshipTx`); a merge or edge
 * conflict answers its usual 409 and leaves the proposal pending.
 */
export const resolveTreeLinkProposalInputSchema = z
  .strictObject({
    decision: z.enum(TreeLinkDecision),
    note: noteSchema.default(null),
    keepPersonId: idSchema.exactOptional(),
    fields: personMergeFieldsSchema.exactOptional()
  })
  .refine((value) => value.decision === TreeLinkDecision.Approve || (value.keepPersonId === undefined && value.fields === undefined), {
    error: "Solo al aprobar se elige a quién conservar.",
    path: ["keepPersonId"]
  });
export type ResolveTreeLinkProposalInput = z.infer<typeof resolveTreeLinkProposalInputSchema>;
export type ResolveTreeLinkProposalRequest = z.input<typeof resolveTreeLinkProposalInputSchema>;

/** `GET /api/family/proposals` (the caller's own) and `GET /api/admin/family/proposals` (all) query. */
export const treeLinkProposalListQuerySchema = cursorQuerySchema.extend({
  status: treeLinkProposalStatusSchema.exactOptional()
});
export type TreeLinkProposalListQuery = z.infer<typeof treeLinkProposalListQuerySchema>;
export type TreeLinkProposalListQueryRequest = z.input<typeof treeLinkProposalListQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Family settings (root ancestor)                                             */
/* -------------------------------------------------------------------------- */

/** `GET /api/family/settings` (members) and `GET|PUT /api/admin/family/settings`. */
export interface FamilySettings {
  /** "Raíz del árbol", e.g. the great-grandfather; `null` until an admin sets it. */
  root: PersonSummary | null;
  updatedAt: string | null;
}

export const familySettingsSchema = z.object({
  root: personSummarySchema.nullable(),
  updatedAt: dateTimeSchema.nullable()
}) satisfies z.ZodType<FamilySettings>;

/** `PUT /api/admin/family/settings` (admin). */
export const updateFamilySettingsInputSchema = z.strictObject({
  rootPersonId: idSchema.nullable()
});
export type UpdateFamilySettingsInput = z.infer<typeof updateFamilySettingsInputSchema>;
export type UpdateFamilySettingsRequest = z.input<typeof updateFamilySettingsInputSchema>;

/* -------------------------------------------------------------------------- */
/* Extended family bands                                                       */
/* -------------------------------------------------------------------------- */

/** Most people per band (the band says `truncated` beyond it). */
export const EXTENDED_FAMILY_BAND_MAX = 200;

/**
 * `GET /api/family/tree/extended?personId=` (default: the caller's person):
 * bands computed server-side over `parent_of` within `FAMILY_TREE_MAX_DEPTH`.
 * `tios`: siblings (full or half) of the focus's parents, plus their
 * partners; `primos`: children of those siblings; `tiosAbuelos`: siblings of
 * the focus's grandparents. People appear as `PersonSummary` under the
 * usual rules (living people's years and photos per ADR 0001 §6).
 */
export interface ExtendedFamily {
  focusId: string;
  tios: PersonSummary[];
  primos: PersonSummary[];
  tiosAbuelos: PersonSummary[];
  /** A band hit {@link EXTENDED_FAMILY_BAND_MAX}. */
  truncated: boolean;
}

export const extendedFamilySchema = z.object({
  focusId: idSchema,
  tios: z.array(personSummarySchema).max(EXTENDED_FAMILY_BAND_MAX),
  primos: z.array(personSummarySchema).max(EXTENDED_FAMILY_BAND_MAX),
  tiosAbuelos: z.array(personSummarySchema).max(EXTENDED_FAMILY_BAND_MAX),
  truncated: z.boolean()
}) satisfies z.ZodType<ExtendedFamily>;

export const extendedFamilyQuerySchema = z.object({ personId: idSchema.exactOptional() });
export type ExtendedFamilyQuery = z.infer<typeof extendedFamilyQuerySchema>;
export type ExtendedFamilyQueryRequest = z.input<typeof extendedFamilyQuerySchema>;

/* -------------------------------------------------------------------------- */
/* "Árbol completo" (descendants outline from the root)                        */
/* -------------------------------------------------------------------------- */

/** Generations one overview request returns below its starting node. */
export const TREE_OVERVIEW_MAX_DEPTH = 3;
/** Most nodes in one overview response (deeper levels report `hasMore`). */
export const TREE_OVERVIEW_MAX_NODES = 500;

/** A partner shown beside a node ("Abuelo X y Abuela Y"): names only. */
export interface TreeOverviewPartner {
  id: string;
  name: string;
}

/**
 * One person in the descendants outline. Names only (no photo, no account
 * id); `birthYear` is `null` for living people the viewer may not see dates
 * of (ADR 0001 §6: self, admins and the qualifying circle), `deathYear` only
 * for deceased people.
 */
export interface TreeOverviewNode {
  id: string;
  /** The outline parent (`null` for the starting node). */
  parentId: string | null;
  name: string;
  nickname: string | null;
  birthYear: number | null;
  deathYear: number | null;
  deceased: boolean;
  partners: TreeOverviewPartner[];
  /** All children of this person (and their partner) in the tree. */
  childrenCount: number;
  /** Some children are not in this response: load them with `personId` = this node. */
  hasMore: boolean;
}

export const treeOverviewNodeSchema = z.object({
  id: idSchema,
  parentId: idSchema.nullable(),
  name: z.string().max(200),
  nickname: z.string().max(80).nullable(),
  birthYear: z.number().int().nullable(),
  deathYear: z.number().int().nullable(),
  deceased: z.boolean(),
  partners: z
    .array(z.object({ id: idSchema, name: z.string().max(200) }) satisfies z.ZodType<TreeOverviewPartner>)
    .max(10),
  childrenCount: z.number().int().min(0),
  hasMore: z.boolean()
}) satisfies z.ZodType<TreeOverviewNode>;

/**
 * `GET /api/family/overview?personId=&depth=`: the outline from `personId`
 * (default: the root) down `depth` generations, parents before children.
 */
export interface TreeOverview {
  rootId: string | null;
  nodes: TreeOverviewNode[];
  /**
   * The caller's own person is connected (by any relationship) to the root;
   * `null` when no root is set or the caller has no person. `false` drives
   * "¿No ves a tu familia? Propón una conexión".
   */
  viewerConnected: boolean | null;
}

export const treeOverviewSchema = z.object({
  rootId: idSchema.nullable(),
  nodes: z.array(treeOverviewNodeSchema).max(TREE_OVERVIEW_MAX_NODES),
  viewerConnected: z.boolean().nullable()
}) satisfies z.ZodType<TreeOverview>;

export const treeOverviewQuerySchema = z.object({
  personId: idSchema.exactOptional(),
  depth: z.coerce.number<number | string>().int().min(1).max(TREE_OVERVIEW_MAX_DEPTH).default(2)
});
export type TreeOverviewQuery = z.infer<typeof treeOverviewQuerySchema>;
export type TreeOverviewQueryRequest = z.input<typeof treeOverviewQuerySchema>;

/**
 * `GET /api/family/overview/path?personId=` ("ir a mí", search results):
 * the ids from the root down to the person along `parent_of`, so the web can
 * expand the outline; empty when the person is not a descendant of the root.
 */
export interface TreeOverviewPath {
  ids: string[];
}

export const treeOverviewPathSchema = z.object({
  ids: z.array(idSchema).max(64)
}) satisfies z.ZodType<TreeOverviewPath>;

export const treeOverviewPathQuerySchema = z.object({ personId: idSchema });
export type TreeOverviewPathQuery = z.infer<typeof treeOverviewPathQuerySchema>;

/* -------------------------------------------------------------------------- */
/* "Ramas sin conectar" (admin)                                                */
/* -------------------------------------------------------------------------- */

/** Why a person of a disconnected branch may be someone in the root's component. */
export const BranchMatchReason = {
  /** Same normalized name (WP-4.5 rule). */
  SameName: "same_name",
  /** One extra trailing word (a second surname). */
  SimilarName: "similar_name",
  /** A nickname equals the other's first name or nickname. */
  Nickname: "nickname",
  /** Both have a partner with the same normalized name. */
  SamePartner: "same_partner",
  /** Their children's normalized names overlap. */
  SharedChildren: "shared_children"
} as const;
export type BranchMatchReason = (typeof BranchMatchReason)[keyof typeof BranchMatchReason];
export const branchMatchReasonSchema = z.enum(BranchMatchReason);

/** A suggested "same person" pair: one side in the branch, the other connected to the root. */
export interface BranchMatch {
  person: PersonSummary;
  candidate: PersonSummary;
  reasons: BranchMatchReason[];
  /** 0–100, higher is more likely; birth/death years must be compatible (±1) when both are known. */
  score: number;
}

export const branchMatchSchema = z.object({
  person: personSummarySchema,
  candidate: personSummarySchema,
  reasons: z.array(branchMatchReasonSchema).min(1).max(5),
  score: z.number().int().min(0).max(100)
}) satisfies z.ZodType<BranchMatch>;

/** A connected component of the tree that is not reachable from the root. */
export interface DisconnectedBranch {
  /** Stable id of the component: its smallest person id. */
  id: string;
  /** Up to five representatives: the oldest generation first, then the most connected. */
  people: PersonSummary[];
  /** People in the component. */
  size: number;
  /** People in it linked to accounts (a count; no account ids). */
  linkedAccounts: number;
  /** Best matches first, at most 10. */
  suggestedMatches: BranchMatch[];
}

export const disconnectedBranchSchema = z.object({
  id: idSchema,
  people: z.array(personSummarySchema).min(1).max(5),
  size: z.number().int().min(1),
  linkedAccounts: z.number().int().min(0),
  suggestedMatches: z.array(branchMatchSchema).max(10)
}) satisfies z.ZodType<DisconnectedBranch>;

/**
 * `GET /api/admin/family/branches` (admin, offset cursor, largest branches
 * first). Without a root, every component except the largest is listed and
 * `rootPersonId` is `null`.
 */
export interface DisconnectedBranchReport {
  rootPersonId: string | null;
  items: DisconnectedBranch[];
  nextCursor: string | null;
}

export const disconnectedBranchReportSchema = z.object({
  rootPersonId: idSchema.nullable(),
  items: z.array(disconnectedBranchSchema),
  nextCursor: z.string().nullable()
}) satisfies z.ZodType<DisconnectedBranchReport>;

export const disconnectedBranchesQuerySchema = cursorQuerySchema.extend({
  /** `"true"`: include single-person components (people with no relationships). */
  includeSingles: queryBooleanSchema.exactOptional()
});
export type DisconnectedBranchesQuery = z.infer<typeof disconnectedBranchesQuerySchema>;
export type DisconnectedBranchesQueryRequest = z.input<typeof disconnectedBranchesQuerySchema>;
