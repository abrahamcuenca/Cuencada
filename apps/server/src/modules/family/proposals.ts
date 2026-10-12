/**
 * Tree-link proposals (WP-6.4) [SEC]: "Es la misma persona" (`same_person`)
 * and "Conectar con…" (`relate` + `parent_of` | `partner_of`). Members
 * propose; admins approve or reject. Rules: ADR 0001 §8 (binding).
 *
 * - **Create:** any verified member, about any two existing people, under
 *   the tree lock (so a concurrent person delete cannot leave a pending
 *   proposal pointing at nobody) and a per-user advisory lock that makes the
 *   20-per-rolling-day count exact (admins exempt). One pending proposal per
 *   proposer and unordered pair (DB partial unique index): 409
 *   `PROPOSAL_DUPLICATE` only for the caller's own duplicate.
 * - **Read:** only the proposer and admins (404 for anyone else). People are
 *   read from the **current** rows (`null` once deleted: "una persona
 *   eliminada"); the resolution note is shown to the proposer and admins only.
 * - **Resolve** (admin): lock tree → the proposal row (and, with
 *   `applyToPair`, the pair's other pending proposals of the same kind and
 *   relation) → set them `approved`/`rejected` → run the merge
 *   (`mergePeopleTx`, keep = `keepPersonId ?? to`) or the edge
 *   (`createRelationshipTx`, admin provenance) in the **same** transaction.
 *   A merge or edge 409 rolls everything back, so the proposal stays pending.
 *   Each proposer gets a `tree_proposal_resolved` notification (never the
 *   note); pushes go out after the commit.
 * - Notes and resolution notes never reach audit metadata, notifications or logs.
 */
import {
  AuditAction,
  AuditEntityType,
  NotificationKind,
  type PersonMergeChoices,
  type PersonSummary,
  RelationshipKind,
  TREE_LINK_PROPOSALS_PER_DAY,
  type TreeLinkDecision,
  TreeLinkIssueCode,
  type TreeLinkProposal,
  type TreeLinkProposalGroup,
  TreeLinkProposalKind,
  TreeLinkProposalStatus,
  type CreateTreeLinkProposalInput,
  type ResolveTreeLinkProposalInput
} from "@cuencada/types";
import { and, desc, eq, inArray, ne, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { people, treeLinkProposals, users } from "../../db/schema/index.js";
import { type DbOrTx, recordAudit, type Transaction } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { recordNotification } from "../notifications/notify.js";
import type { AvatarUrlDeps } from "../profile/avatar.js";
import { AvatarSize } from "../profile/constants.js";
import { PgErrorCode, pgErrorInfo } from "./db-errors.js";
import { mergePeopleTx } from "./merge.js";
import { auditProposalWithdrawn, ProposalWithdrawReason } from "./proposalCleanup.js";
import { lockFamilyTree } from "./relationships.js";
import { type PersonViewRow, presignPersonAvatars, selectPersonViews, toPersonSummary, type Viewer } from "./repository.js";
import { PERSON_NOT_FOUND, type WriteActor, createRelationshipTx } from "./writes.js";

/** Spanish messages. */
export const ProposalMessage = {
  NotFound: "No encontramos esa propuesta.",
  Duplicate: "Ya propusiste algo sobre estas dos personas. Espera a que un administrador lo revise.",
  NotPending: "Esta propuesta ya no está pendiente.",
  DailyLimit: "Ya enviaste muchas propuestas hoy. Intenta de nuevo mañana.",
  KeepNotInPair: "Elige a una de las dos personas de la propuesta."
} as const;

/** The rolling window of {@link TREE_LINK_PROPOSALS_PER_DAY}. */
export const PROPOSAL_WINDOW_MS = 24 * 60 * 60 * 1000;

const PENDING_PAIR_INDEX = "tree_link_proposals_pending_pair_unique";

/** Columns every proposal read selects. */
const proposalColumns = {
  id: treeLinkProposals.id,
  kind: treeLinkProposals.kind,
  fromPersonId: treeLinkProposals.fromPersonId,
  toPersonId: treeLinkProposals.toPersonId,
  relation: treeLinkProposals.relation,
  note: treeLinkProposals.note,
  status: treeLinkProposals.status,
  proposedByUserId: treeLinkProposals.proposedByUserId,
  resolvedByUserId: treeLinkProposals.resolvedByUserId,
  resolvedAt: treeLinkProposals.resolvedAt,
  resolutionNote: treeLinkProposals.resolutionNote,
  createdAt: treeLinkProposals.createdAt
};

/** A proposal row as read with {@link proposalColumns}. */
export type ProposalRow = {
  [K in keyof typeof proposalColumns]: (typeof treeLinkProposals.$inferSelect)[K];
};

/** A 409 with its stable proposal detail code. */
function proposalConflict(code: TreeLinkIssueCode, message: string): AppError {
  return new AppError("CONFLICT", message, { details: [{ path: "proposal", message, code }] });
}

const notFound = (): AppError => new AppError("NOT_FOUND", ProposalMessage.NotFound);

/** The unordered pair key of a proposal (`{smaller}:{larger}`; a deleted person is replaced by the proposal id). */
export function pairKeyOf(row: Pick<ProposalRow, "id" | "fromPersonId" | "toPersonId">): string {
  const a = row.fromPersonId ?? row.id;
  const b = row.toPersonId ?? row.id;
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/* -------------------------------------------------------------------------- */
/* Read model                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Map rows to the contract with **current** people (`null` when deleted)
 * and account display names, in a fixed number of statements.
 *
 * @param deps - Client, storage and logger.
 * @param rows - Proposals the caller may read (proposer or admin; the caller checks).
 * @param viewer - The caller (photo and link rules; `isMine`).
 */
export async function toProposals(deps: AvatarUrlDeps & { db: DbOrTx }, rows: readonly ProposalRow[], viewer: Viewer): Promise<TreeLinkProposal[]> {
  const personIds = [...new Set(rows.flatMap((row) => [row.fromPersonId, row.toPersonId]).filter((id): id is string => id !== null))];
  const userIds = [...new Set(rows.flatMap((row) => [row.proposedByUserId, row.resolvedByUserId]).filter((id): id is string => id !== null))];
  const personRows = personIds.length === 0 ? [] : await selectPersonViews(deps.db, inArray(people.id, personIds));
  const byId = new Map<string, PersonViewRow>(personRows.map((row) => [row.id, row]));
  const names =
    userIds.length === 0
      ? new Map<string, string>()
      : new Map(
          (await deps.db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, userIds))).map((row) => [
            row.id,
            row.name.slice(0, 80)
          ])
        );
  const avatars = await presignPersonAvatars(deps, personRows, viewer, AvatarSize.Small);
  const person = (id: string | null): PersonSummary | null => {
    const row = id === null ? undefined : byId.get(id);
    return row === undefined ? null : toPersonSummary(row, viewer, avatars);
  };
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    from: person(row.fromPersonId),
    to: person(row.toPersonId),
    relation: row.relation,
    note: row.note,
    status: row.status,
    proposedByName: row.proposedByUserId === null ? null : (names.get(row.proposedByUserId) ?? null),
    isMine: row.proposedByUserId === viewer.id,
    resolvedByName: row.resolvedByUserId === null ? null : (names.get(row.resolvedByUserId) ?? null),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolutionNote: row.resolutionNote,
    createdAt: row.createdAt.toISOString()
  }));
}

/** One proposal by id (no access check: the caller decides). */
export async function findProposal(db: DbOrTx, id: string): Promise<ProposalRow | undefined> {
  const [row] = await db.select(proposalColumns).from(treeLinkProposals).where(eq(treeLinkProposals.id, id)).limit(1);
  return row;
}

/* -------------------------------------------------------------------------- */
/* Create and withdraw                                                         */
/* -------------------------------------------------------------------------- */

/** Who proposes. */
export interface ProposalActor extends WriteActor {
  role: "member" | "admin";
}

/**
 * `POST /api/family/proposals`.
 *
 * @param tx - Open transaction.
 * @param input - Validated input.
 * @param actor - The caller.
 * @param now - Current time (the rolling day).
 * @returns The new proposal row.
 * @throws AppError 404 (a person does not exist), 409 `PROPOSAL_DUPLICATE`, 429 over the daily limit.
 */
export async function createProposalTx(tx: Transaction, input: CreateTreeLinkProposalInput, actor: ProposalActor, now: Date): Promise<ProposalRow> {
  const fromPersonId = input.fromPersonId.toLowerCase();
  const toPersonId = input.toPersonId.toLowerCase();
  // Lock order: tree → (per-user proposal lock). Person deletes take the tree lock too.
  await lockFamilyTree(tx);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`tree-proposal:${actor.id}`}))`);
  const found = await tx.select({ id: people.id }).from(people).where(inArray(people.id, [fromPersonId, toPersonId]));
  if (found.length !== 2) throw new AppError("NOT_FOUND", PERSON_NOT_FOUND);

  if (actor.role !== "admin") {
    const since = new Date(now.getTime() - PROPOSAL_WINDOW_MS);
    const [usage] = await tx
      .select({ recent: sql<number>`count(*)::int`.mapWith(Number) })
      .from(treeLinkProposals)
      .where(and(eq(treeLinkProposals.proposedByUserId, actor.id), sql`${treeLinkProposals.createdAt} > ${since.toISOString()}::timestamptz`));
    if ((usage?.recent ?? 0) >= TREE_LINK_PROPOSALS_PER_DAY) throw new AppError("RATE_LIMITED", ProposalMessage.DailyLimit);
  }

  const [low, high] = fromPersonId < toPersonId ? [fromPersonId, toPersonId] : [toPersonId, fromPersonId];
  const [mine] = await tx
    .select({ id: treeLinkProposals.id })
    .from(treeLinkProposals)
    .where(
      and(
        eq(treeLinkProposals.status, TreeLinkProposalStatus.Pending),
        eq(treeLinkProposals.proposedByUserId, actor.id),
        sql`least(${treeLinkProposals.fromPersonId}, ${treeLinkProposals.toPersonId}) = ${low}::uuid`,
        sql`greatest(${treeLinkProposals.fromPersonId}, ${treeLinkProposals.toPersonId}) = ${high}::uuid`
      )
    )
    .limit(1);
  if (mine !== undefined) throw proposalConflict(TreeLinkIssueCode.Duplicate, ProposalMessage.Duplicate);

  let row: ProposalRow | undefined;
  try {
    [row] = await tx
      .insert(treeLinkProposals)
      .values({
        kind: input.kind,
        fromPersonId,
        toPersonId,
        relation: input.kind === TreeLinkProposalKind.Relate ? (input.relation ?? null) : null,
        note: input.note,
        proposedByUserId: actor.id
      })
      .returning(proposalColumns);
  } catch (error) {
    const info = pgErrorInfo(error);
    // Backstop for the check above (it runs under the per-user lock, so this should not happen).
    if (info?.code === PgErrorCode.UniqueViolation && info.constraint === PENDING_PAIR_INDEX) {
      throw proposalConflict(TreeLinkIssueCode.Duplicate, ProposalMessage.Duplicate);
    }
    throw error;
  }
  if (row === undefined) throw new Error("proposal insert returned no row");
  await recordAudit(tx, {
    actorUserId: actor.id,
    action: AuditAction.TreeProposalCreated,
    entityType: AuditEntityType.TreeProposal,
    entityId: row.id,
    metadata: { kind: row.kind, relation: row.relation, fromPersonId, toPersonId },
    ip: actor.ip
  });
  return row;
}

/**
 * `DELETE /api/family/proposals/:id`: the proposer withdraws a pending one.
 *
 * @throws AppError 404 (not the caller's, or missing), 409 `PROPOSAL_NOT_PENDING`.
 */
export async function withdrawProposalTx(tx: Transaction, id: string, actor: WriteActor): Promise<void> {
  const [withdrawn] = await tx
    .update(treeLinkProposals)
    .set({ status: TreeLinkProposalStatus.Withdrawn, resolvedAt: sql`now()` })
    .where(
      and(
        eq(treeLinkProposals.id, id),
        eq(treeLinkProposals.proposedByUserId, actor.id),
        eq(treeLinkProposals.status, TreeLinkProposalStatus.Pending)
      )
    )
    .returning({ id: treeLinkProposals.id });
  if (withdrawn === undefined) {
    const [own] = await tx
      .select({ id: treeLinkProposals.id })
      .from(treeLinkProposals)
      .where(and(eq(treeLinkProposals.id, id), eq(treeLinkProposals.proposedByUserId, actor.id)))
      .limit(1);
    if (own === undefined) throw notFound();
    throw proposalConflict(TreeLinkIssueCode.NotPending, ProposalMessage.NotPending);
  }
  await auditProposalWithdrawn(tx, id, ProposalWithdrawReason.Proposer, actor);
}

/* -------------------------------------------------------------------------- */
/* Lists                                                                       */
/* -------------------------------------------------------------------------- */

const keysetSchema = z.tuple([z.iso.datetime({ offset: true }), z.uuid()]);
const offsetSchema = z.tuple([z.number().int().min(0).max(1_000_000)]);

function invalidCursor(): AppError {
  return new AppError("VALIDATION", "Cursor inválido.", { details: [{ path: "cursor", message: "Cursor inválido." }] });
}

function decodeJsonCursor<T>(value: string, schema: z.ZodType<T>): T {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    raw = undefined;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw invalidCursor();
  return parsed.data;
}

const encodeCursor = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * The caller's own proposals, newest first (keyset on `created_at`, `id`).
 *
 * @returns The page rows and the next cursor.
 */
export async function listOwnProposals(
  db: DbOrTx,
  userId: string,
  query: { cursor?: string; limit: number; status?: TreeLinkProposalStatus }
): Promise<{ rows: ProposalRow[]; nextCursor: string | null }> {
  const after = query.cursor === undefined ? undefined : decodeJsonCursor(query.cursor, keysetSchema);
  const conditions: SQL[] = [eq(treeLinkProposals.proposedByUserId, userId)];
  if (query.status !== undefined) conditions.push(eq(treeLinkProposals.status, query.status));
  if (after !== undefined) {
    conditions.push(sql`(${treeLinkProposals.createdAt}, ${treeLinkProposals.id}) < (${after[0]}::timestamptz, ${after[1]}::uuid)`);
  }
  const rows = await db
    .select(proposalColumns)
    .from(treeLinkProposals)
    .where(and(...conditions))
    .orderBy(desc(treeLinkProposals.createdAt), desc(treeLinkProposals.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    rows: page,
    nextCursor: rows.length > query.limit && last !== undefined ? encodeCursor([last.createdAt.toISOString(), last.id]) : null
  };
}

/** Most proposals returned per group (contract cap). */
const GROUP_PROPOSALS_MAX = 100;

const pairKeySql = sql<string>`least(coalesce(${treeLinkProposals.fromPersonId}, ${treeLinkProposals.id}), coalesce(${treeLinkProposals.toPersonId}, ${treeLinkProposals.id}))::text || ':' || greatest(coalesce(${treeLinkProposals.fromPersonId}, ${treeLinkProposals.id}), coalesce(${treeLinkProposals.toPersonId}, ${treeLinkProposals.id}))::text`;

/**
 * Admin queue: proposals grouped by unordered pair (offset cursor over
 * groups). Groups with a pending proposal come first, oldest pending first;
 * then the rest, newest first. Each group holds its proposals matching
 * `status` (all when omitted), newest first.
 */
export async function listProposalGroups(
  db: DbOrTx,
  query: { cursor?: string; limit: number; status?: TreeLinkProposalStatus }
): Promise<{ groups: Array<{ pairKey: string; rows: ProposalRow[] }>; nextCursor: string | null }> {
  const offset = query.cursor === undefined ? 0 : decodeJsonCursor(query.cursor, offsetSchema)[0];
  const filter = query.status === undefined ? undefined : eq(treeLinkProposals.status, query.status);
  const keys = await db
    .select({
      pairKey: pairKeySql.as("pair_key"),
      hasPending: sql<boolean>`bool_or(${treeLinkProposals.status} = 'pending')`.as("has_pending"),
      oldestPending: sql<string | null>`min(${treeLinkProposals.createdAt}) filter (where ${treeLinkProposals.status} = 'pending')`.as("oldest_pending"),
      newest: sql<string>`max(${treeLinkProposals.createdAt})`.as("newest")
    })
    .from(treeLinkProposals)
    .where(filter)
    .groupBy(sql`1`)
    .orderBy(sql`2 desc`, sql`3 asc nulls last`, sql`4 desc`, sql`1 asc`)
    .limit(query.limit + 1)
    .offset(offset);
  const page = keys.slice(0, query.limit).map((row) => row.pairKey);
  if (page.length === 0) return { groups: [], nextCursor: null };
  const rows = await db
    .select({ ...proposalColumns, pairKey: pairKeySql })
    .from(treeLinkProposals)
    .where(and(filter, inArray(pairKeySql, page)))
    .orderBy(desc(treeLinkProposals.createdAt), desc(treeLinkProposals.id));
  const byKey = new Map<string, ProposalRow[]>(page.map((key) => [key, []]));
  for (const { pairKey, ...row } of rows) {
    const list = byKey.get(pairKey);
    if (list !== undefined && list.length < GROUP_PROPOSALS_MAX) list.push(row);
  }
  return {
    groups: page.map((pairKey) => ({ pairKey, rows: byKey.get(pairKey) ?? [] })).filter((group) => group.rows.length > 0),
    nextCursor: keys.length > query.limit ? encodeCursor([offset + query.limit]) : null
  };
}

/** Map groups to the contract (one read-model pass for every proposal on the page). */
export async function toProposalGroups(
  deps: AvatarUrlDeps & { db: DbOrTx },
  groups: ReadonlyArray<{ pairKey: string; rows: ProposalRow[] }>,
  viewer: Viewer
): Promise<TreeLinkProposalGroup[]> {
  const mapped = await toProposals(deps, groups.flatMap((group) => group.rows), viewer);
  const byId = new Map(mapped.map((proposal) => [proposal.id, proposal]));
  return groups.map((group) => ({ pairKey: group.pairKey, proposals: group.rows.flatMap((row) => byId.get(row.id) ?? []) }));
}

/* -------------------------------------------------------------------------- */
/* Resolve                                                                     */
/* -------------------------------------------------------------------------- */

/** What a resolve did (for the route's after-commit work). */
export interface ResolveOutcome {
  proposalId: string;
  /** Notifications to push after the commit. */
  notificationIds: string[];
  /** The merged duplicate's losing tree-photo objects (delete after the commit). */
  photoKeys: string[];
}

/** The pair's other pending proposals with the same kind and relation, locked. */
async function lockSamePairPending(tx: Transaction, proposal: ProposalRow): Promise<ProposalRow[]> {
  const from = proposal.fromPersonId;
  const to = proposal.toPersonId;
  if (from === null || to === null) return [];
  return tx
    .select(proposalColumns)
    .from(treeLinkProposals)
    .where(
      and(
        ne(treeLinkProposals.id, proposal.id),
        eq(treeLinkProposals.status, TreeLinkProposalStatus.Pending),
        eq(treeLinkProposals.kind, proposal.kind),
        proposal.relation === null ? sql`${treeLinkProposals.relation} is null` : eq(treeLinkProposals.relation, proposal.relation),
        or(
          and(eq(treeLinkProposals.fromPersonId, from), eq(treeLinkProposals.toPersonId, to)),
          and(eq(treeLinkProposals.fromPersonId, to), eq(treeLinkProposals.toPersonId, from))
        )
      )
    )
    .orderBy(treeLinkProposals.id)
    .for("update");
}

/** The merge's keep and duplicate for an approved `same_person` proposal. */
function mergeSides(proposal: ProposalRow, keepPersonId: string | undefined): { keepId: string; duplicateId: string } {
  const from = proposal.fromPersonId;
  const to = proposal.toPersonId;
  if (from === null || to === null) throw new Error("pending proposal without both people");
  const keepId = (keepPersonId ?? to).toLowerCase();
  if (keepId !== from && keepId !== to) {
    throw new AppError("VALIDATION", ProposalMessage.KeepNotInPair, { details: [{ path: "keepPersonId", message: ProposalMessage.KeepNotInPair }] });
  }
  return { keepId, duplicateId: keepId === from ? to : from };
}

/**
 * `POST /api/admin/family/proposals/:id/resolve` (see the module comment).
 *
 * @param tx - Open transaction.
 * @param id - The proposal.
 * @param input - Decision, note, `applyToPair` and the merge choices.
 * @param actor - The admin.
 * @param now - Current time (the merge's invite check).
 * @throws AppError 404, 409 `PROPOSAL_NOT_PENDING`, 400/409 from the merge or the edge.
 */
export async function resolveProposalTx(
  tx: Transaction,
  id: string,
  input: ResolveTreeLinkProposalInput,
  actor: WriteActor,
  now: Date
): Promise<ResolveOutcome> {
  // Lock order: tree → proposal rows → (merge: keep → duplicate → invites).
  await lockFamilyTree(tx);
  const [proposal] = await tx.select(proposalColumns).from(treeLinkProposals).where(eq(treeLinkProposals.id, id)).limit(1).for("update");
  if (proposal === undefined) throw notFound();
  if (proposal.status !== TreeLinkProposalStatus.Pending) throw proposalConflict(TreeLinkIssueCode.NotPending, ProposalMessage.NotPending);
  const others = input.applyToPair ? await lockSamePairPending(tx, proposal) : [];
  const resolved = [proposal, ...others];
  const decision: TreeLinkDecision = input.decision;
  const status = decision === "approve" ? TreeLinkProposalStatus.Approved : TreeLinkProposalStatus.Rejected;

  // Set first: the merge re-points the duplicate's *pending* proposals, and these are no longer pending.
  await tx
    .update(treeLinkProposals)
    .set({ status, resolvedByUserId: actor.id, resolvedAt: sql`now()`, resolutionNote: input.note })
    .where(inArray(treeLinkProposals.id, resolved.map((row) => row.id)));

  let photoKeys: string[] = [];
  let result: Record<string, unknown> = {};
  if (decision === "approve") {
    if (proposal.kind === TreeLinkProposalKind.SamePerson) {
      const { keepId, duplicateId } = mergeSides(proposal, input.keepPersonId);
      const choices: PersonMergeChoices = input.fields ?? {};
      const merged = await mergePeopleTx(tx, keepId, duplicateId, choices, actor, { dryRun: false, now });
      if (merged.result === null) throw new Error("merge returned no result");
      photoKeys = merged.result.photoKeys;
      result = { keepPersonId: keepId, duplicatePersonId: duplicateId, revisionId: merged.result.revisionId };
    } else {
      const from = proposal.fromPersonId;
      const to = proposal.toPersonId;
      if (from === null || to === null || proposal.relation === null) throw new Error("pending relate proposal without people or relation");
      const kind = proposal.relation === RelationshipKind.ParentOf ? RelationshipKind.ParentOf : RelationshipKind.PartnerOf;
      const edge = await createRelationshipTx(tx, { kind, fromPersonId: from, toPersonId: to }, actor);
      result = { relationshipId: edge.id };
    }
  }

  const notificationIds: string[] = [];
  for (const row of resolved) {
    await recordAudit(tx, {
      actorUserId: actor.id,
      action: decision === "approve" ? AuditAction.TreeProposalApproved : AuditAction.TreeProposalRejected,
      entityType: AuditEntityType.TreeProposal,
      entityId: row.id,
      metadata: { kind: row.kind, ...(row.id === proposal.id ? result : { appliedFrom: proposal.id }) },
      ip: actor.ip
    });
    if (row.proposedByUserId !== null && row.proposedByUserId !== actor.id) {
      const notificationId = await recordNotification(tx, {
        recipientUserId: row.proposedByUserId,
        actorUserId: actor.id,
        kind: NotificationKind.TreeProposalResolved,
        target: { proposalId: row.id }
      });
      if (notificationId !== null) notificationIds.push(notificationId);
    }
  }
  return { proposalId: proposal.id, notificationIds, photoKeys };
}
