/**
 * Pending tree-link proposals at the three person-delete sites (WP-6.4,
 * ADR 0001 §8). A pending proposal must name two people (DB CHECK
 * `tree_link_proposals_pending_people_check`), and the person FKs are
 * ON DELETE SET NULL, so a delete that forgets this step **fails closed**.
 *
 * - `deletePersonTx` (`writes.ts`) and the revert of a `person.create`
 *   (`revert.ts`) call {@link withdrawPendingProposalsTx} (`person_deleted`).
 * - `mergePeopleTx` (`merge.ts`) calls {@link repointPendingProposalsTx}
 *   before deleting the duplicate: duplicate → keep, withdrawing a proposal
 *   that collapses to keep↔keep or collides with the same proposer's pending
 *   proposal for the new pair (`person_merged`).
 *
 * A system withdrawal records no resolver (`resolved_by_user_id` stays
 * `null`): the proposer is not told who deleted or merged the person. Merge
 * undo does not restore re-pointed or withdrawn proposals (WP-6.0 decision 16).
 * This module only imports the schema and the audit writer, so `writes.ts`
 * can use it without an import cycle.
 */
import { AuditAction, AuditEntityType, TreeLinkProposalStatus } from "@cuencada/types";
import { and, asc, eq, ne, or, sql } from "drizzle-orm";
import { treeLinkProposals } from "../../db/schema/index.js";
import { recordAudit, type Transaction } from "../../lib/audit.js";

/** Why a proposal was withdrawn (`tree_proposal.withdrawn` metadata `reason`). */
export const ProposalWithdrawReason = {
  Proposer: "proposer",
  PersonDeleted: "person_deleted",
  PersonMerged: "person_merged"
} as const;
export type ProposalWithdrawReason = (typeof ProposalWithdrawReason)[keyof typeof ProposalWithdrawReason];

/** Who acts (ids for the audit row). */
interface CleanupActor {
  id: string;
  ip: string;
}

/** Audit one withdrawal (ids and enums only, never the note). */
export async function auditProposalWithdrawn(
  tx: Transaction,
  proposalId: string,
  reason: ProposalWithdrawReason,
  actor: CleanupActor,
  personId?: string
): Promise<void> {
  await recordAudit(tx, {
    actorUserId: actor.id,
    action: AuditAction.TreeProposalWithdrawn,
    entityType: AuditEntityType.TreeProposal,
    entityId: proposalId,
    metadata: { reason, ...(personId === undefined ? {} : { personId }) },
    ip: actor.ip
  });
}

const namesPerson = (personId: string) =>
  or(eq(treeLinkProposals.fromPersonId, personId), eq(treeLinkProposals.toPersonId, personId));

/**
 * Withdraw every pending proposal naming `personId` (before deleting it).
 *
 * @param tx - Open transaction holding the tree lock and the person row lock.
 * @returns How many were withdrawn.
 */
export async function withdrawPendingProposalsTx(tx: Transaction, personId: string, actor: CleanupActor): Promise<number> {
  const rows = await tx
    .update(treeLinkProposals)
    .set({ status: TreeLinkProposalStatus.Withdrawn, resolvedAt: sql`now()` })
    .where(and(eq(treeLinkProposals.status, TreeLinkProposalStatus.Pending), namesPerson(personId)))
    .returning({ id: treeLinkProposals.id });
  for (const row of rows) await auditProposalWithdrawn(tx, row.id, ProposalWithdrawReason.PersonDeleted, actor, personId);
  return rows.length;
}

/** What {@link repointPendingProposalsTx} did. */
export interface RepointResult {
  repointed: number;
  withdrawn: number;
}

/**
 * Re-point the duplicate's pending proposals to `keepId` (inside a merge,
 * before the duplicate is deleted). Rows are locked and handled oldest
 * first; a proposal that would name keep twice, or that collides with the
 * same proposer's pending proposal for the new pair (the partial unique
 * index), is withdrawn instead.
 *
 * @param tx - Open transaction (the merge's: tree → keep → duplicate locks held).
 * @param duplicateId - The person being merged away.
 * @param keepId - The person that stays.
 * @param actor - The admin.
 */
export async function repointPendingProposalsTx(
  tx: Transaction,
  duplicateId: string,
  keepId: string,
  actor: CleanupActor
): Promise<RepointResult> {
  const rows = await tx
    .select({
      id: treeLinkProposals.id,
      fromPersonId: treeLinkProposals.fromPersonId,
      toPersonId: treeLinkProposals.toPersonId,
      proposedByUserId: treeLinkProposals.proposedByUserId
    })
    .from(treeLinkProposals)
    .where(and(eq(treeLinkProposals.status, TreeLinkProposalStatus.Pending), namesPerson(duplicateId)))
    .orderBy(asc(treeLinkProposals.createdAt), asc(treeLinkProposals.id))
    .for("update");
  const result: RepointResult = { repointed: 0, withdrawn: 0 };
  for (const row of rows) {
    const from = row.fromPersonId === duplicateId ? keepId : row.fromPersonId;
    const to = row.toPersonId === duplicateId ? keepId : row.toPersonId;
    let collides = from === null || to === null || from === to;
    if (!collides && from !== null && to !== null && row.proposedByUserId !== null) {
      const [low, high] = from < to ? [from, to] : [to, from];
      const [existing] = await tx
        .select({ id: treeLinkProposals.id })
        .from(treeLinkProposals)
        .where(
          and(
            eq(treeLinkProposals.status, TreeLinkProposalStatus.Pending),
            eq(treeLinkProposals.proposedByUserId, row.proposedByUserId),
            ne(treeLinkProposals.id, row.id),
            sql`least(${treeLinkProposals.fromPersonId}, ${treeLinkProposals.toPersonId}) = ${low}::uuid`,
            sql`greatest(${treeLinkProposals.fromPersonId}, ${treeLinkProposals.toPersonId}) = ${high}::uuid`
          )
        )
        .limit(1);
      collides = existing !== undefined;
    }
    if (collides) {
      await tx
        .update(treeLinkProposals)
        .set({ status: TreeLinkProposalStatus.Withdrawn, resolvedAt: sql`now()` })
        .where(eq(treeLinkProposals.id, row.id));
      await auditProposalWithdrawn(tx, row.id, ProposalWithdrawReason.PersonMerged, actor, duplicateId);
      result.withdrawn += 1;
    } else {
      await tx.update(treeLinkProposals).set({ fromPersonId: from, toPersonId: to }).where(eq(treeLinkProposals.id, row.id));
      result.repointed += 1;
    }
  }
  return result;
}
