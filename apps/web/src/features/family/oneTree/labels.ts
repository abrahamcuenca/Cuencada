/**
 * Spanish copy for the one-tree screens (WP-6.4): proposal statuses, what a
 * proposal says, and why a branch person may be someone in the main tree.
 * Pure: unit-tested.
 */
import type { BranchMatchReason, PersonSummary, TreeLinkProposal, TreeLinkProposalStatus, TreeOverviewNode } from "@cuencada/types";
import type { BadgeTone } from "../../../shared/ui/Badge";

/** Shown where a proposal names a person who was removed from the tree (ADR 0001 §8). */
export const DELETED_PERSON = "una persona eliminada";

export const PROPOSAL_STATUS_LABELS: Record<TreeLinkProposalStatus, string> = {
  pending: "Pendiente",
  approved: "Aprobada",
  rejected: "Rechazada",
  withdrawn: "Retirada"
};

export const PROPOSAL_STATUS_TONES: Record<TreeLinkProposalStatus, BadgeTone> = {
  pending: "accent",
  approved: "success",
  rejected: "danger",
  withdrawn: "neutral"
};

export const BRANCH_REASON_LABELS: Record<BranchMatchReason, string> = {
  same_name: "Mismo nombre",
  similar_name: "Nombre parecido",
  nickname: "Apodo",
  same_partner: "Misma pareja",
  shared_children: "Hijos en común"
};

/** A person's name in a proposal, or {@link DELETED_PERSON}. */
export function proposalPersonName(person: Pick<PersonSummary, "fullName"> | null): string {
  return person === null ? DELETED_PERSON : person.fullName;
}

/**
 * One sentence for what a proposal says, e.g. «Ana es la misma persona que
 * Ana M.», «Luis es padre o madre de Inés», «Ana y Luis son pareja».
 */
export function describeProposal(proposal: Pick<TreeLinkProposal, "kind" | "relation" | "from" | "to">): string {
  const from = proposalPersonName(proposal.from);
  const to = proposalPersonName(proposal.to);
  if (proposal.kind === "same_person") return `${from} es la misma persona que ${to}`;
  if (proposal.relation === "partner_of") return `${from} y ${to} son pareja`;
  return `${from} es padre o madre de ${to}`;
}

/** The relation a member picks in "Conectar con…", seen from the person on screen. */
export type ConnectRole = "parent" | "child" | "partner";

export const CONNECT_ROLE_LABELS: Record<ConnectRole, string> = {
  parent: "Es su padre o madre",
  child: "Es su hijo o hija",
  partner: "Es su pareja"
};

/**
 * The proposal body for "`otherId` is the `role` of `focusId`".
 *
 * @returns `relate` with `from`/`to` ordered so that `from` is the parent for `parent_of`.
 */
export function connectProposal(focusId: string, otherId: string, role: ConnectRole): { relation: "parent_of" | "partner_of"; fromPersonId: string; toPersonId: string } {
  if (role === "parent") return { relation: "parent_of", fromPersonId: otherId, toPersonId: focusId };
  if (role === "child") return { relation: "parent_of", fromPersonId: focusId, toPersonId: otherId };
  return { relation: "partner_of", fromPersonId: focusId, toPersonId: otherId };
}

/** e.g. `1930 – 2001`, `n. 1952`, `† 2001`, or `null` (overview nodes carry privacy-filtered years). */
export function nodeYears(node: Pick<TreeOverviewNode, "birthYear" | "deathYear" | "deceased">): string | null {
  if (node.birthYear !== null && node.deathYear !== null) return `${node.birthYear} – ${node.deathYear}`;
  if (node.birthYear !== null) return node.deceased ? `${node.birthYear} – ?` : `n. ${node.birthYear}`;
  if (node.deathYear !== null) return `† ${node.deathYear}`;
  return null;
}

/** "y Ana Morales Vega", "y Ana y Rosa" for a node's partners (names only). */
export function partnersText(node: Pick<TreeOverviewNode, "partners">): string | null {
  if (node.partners.length === 0) return null;
  return `y ${node.partners.map((partner) => partner.name).join(" y ")}`;
}

/** "3 hijos", "1 hijo", or `null`. */
export function childrenText(count: number): string | null {
  if (count === 0) return null;
  return count === 1 ? "1 hijo" : `${count} hijos`;
}
