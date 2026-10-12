import { describe, expect, it } from "vitest";
import * as barrel from "./index.js";
import {
  TreeLinkIssueCode,
  createTreeLinkProposalInputSchema,
  disconnectedBranchSchema,
  extendedFamilySchema,
  familySettingsSchema,
  resolveTreeLinkProposalInputSchema,
  treeLinkProposalGroupSchema,
  treeLinkProposalSchema,
  treeOverviewQuerySchema,
  treeOverviewSchema,
  updateFamilySettingsInputSchema
} from "./treeLinks.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

const person = { id: A, userId: null, fullName: "Abuelo Vega", nickname: null, deceased: true, avatarUrl: null };

describe("createTreeLinkProposalInputSchema", () => {
  it("accepts same-person and relate proposals with a cleaned note", () => {
    expect(createTreeLinkProposalInputSchema.parse({ kind: "same_person", fromPersonId: A, toPersonId: B })).toEqual({
      kind: "same_person",
      fromPersonId: A,
      toPersonId: B,
      note: null
    });
    expect(
      createTreeLinkProposalInputSchema.parse({ kind: "relate", fromPersonId: A, toPersonId: B, relation: "parent_of", note: " Es su papá " })
    ).toMatchObject({ relation: "parent_of", note: "Es su papá" });
  });

  it("requires a relation exactly for relate, two distinct people and a short note", () => {
    expect(createTreeLinkProposalInputSchema.safeParse({ kind: "relate", fromPersonId: A, toPersonId: B }).success).toBe(false);
    expect(
      createTreeLinkProposalInputSchema.safeParse({ kind: "same_person", fromPersonId: A, toPersonId: B, relation: "partner_of" }).success
    ).toBe(false);
    expect(createTreeLinkProposalInputSchema.safeParse({ kind: "same_person", fromPersonId: A, toPersonId: A }).success).toBe(false);
    expect(
      createTreeLinkProposalInputSchema.safeParse({ kind: "same_person", fromPersonId: A, toPersonId: B, note: "n".repeat(501) }).success
    ).toBe(false);
    expect(
      createTreeLinkProposalInputSchema.safeParse({ kind: "same_person", fromPersonId: A, toPersonId: B, proposedByUserId: A }).success
    ).toBe(false);
  });
});

describe("resolveTreeLinkProposalInputSchema", () => {
  it("allows merge choices only when approving", () => {
    expect(resolveTreeLinkProposalInputSchema.parse({ decision: "approve", keepPersonId: A, fields: { birthYear: "duplicate" } })).toMatchObject({
      keepPersonId: A
    });
    expect(resolveTreeLinkProposalInputSchema.parse({ decision: "reject", note: "No es la misma persona" })).toEqual({
      decision: "reject",
      note: "No es la misma persona",
      applyToPair: true
    });
    expect(resolveTreeLinkProposalInputSchema.parse({ decision: "reject", applyToPair: false }).applyToPair).toBe(false);
    expect(resolveTreeLinkProposalInputSchema.safeParse({ decision: "reject", keepPersonId: A }).success).toBe(false);
    expect(resolveTreeLinkProposalInputSchema.safeParse({ decision: "maybe" }).success).toBe(false);
  });
});

describe("read models", () => {
  it("parses a proposal whose person was deleted and strips account ids of proposers", () => {
    const proposal = {
      id: A,
      kind: "same_person",
      from: person,
      to: null,
      relation: null,
      note: null,
      status: "approved",
      proposedByName: "Ana Morales Vega",
      isMine: true,
      resolvedByName: "Admin",
      resolvedAt: "2026-10-11T10:00:00.000Z",
      resolutionNote: null,
      createdAt: "2026-10-10T10:00:00.000Z"
    };
    expect(treeLinkProposalSchema.parse(proposal)).toEqual(proposal);
    expect(treeLinkProposalSchema.parse({ ...proposal, proposedByUserId: B })).not.toHaveProperty("proposedByUserId");
    // The admin queue groups same-pair proposals (PR #56 L2).
    const group = { pairKey: `${A}:${B}`, proposals: [proposal, { ...proposal, id: B, isMine: false }] };
    expect(treeLinkProposalGroupSchema.parse(group).proposals).toHaveLength(2);
    expect(treeLinkProposalGroupSchema.safeParse({ ...group, proposals: [] }).success).toBe(false);
  });

  it("parses settings, extended bands, the overview and a disconnected branch", () => {
    expect(familySettingsSchema.parse({ root: person, updatedAt: null })).toEqual({ root: person, updatedAt: null });
    expect(updateFamilySettingsInputSchema.parse({ rootPersonId: null })).toEqual({ rootPersonId: null });
    expect(extendedFamilySchema.parse({ focusId: A, tios: [person], primos: [], tiosAbuelos: [], truncated: false }).tios).toHaveLength(1);
    const node = {
      id: A,
      parentId: null,
      name: "Abuelo Vega",
      nickname: null,
      birthYear: 1901,
      deathYear: 1980,
      deceased: true,
      partners: [{ id: B, name: "Abuela Rosa" }],
      childrenCount: 5,
      hasMore: true
    };
    expect(treeOverviewSchema.parse({ rootId: A, nodes: [node], viewerConnected: false }).nodes[0]).toEqual(node);
    // Names only: an avatar never travels in the outline.
    expect(treeOverviewSchema.parse({ rootId: A, nodes: [{ ...node, avatarUrl: "x" }], viewerConnected: null }).nodes[0]).not.toHaveProperty(
      "avatarUrl"
    );
    expect(treeOverviewQuerySchema.parse({})).toEqual({ depth: 2 });
    expect(treeOverviewQuerySchema.safeParse({ depth: "4" }).success).toBe(false);
    const branch = {
      id: A,
      people: [person],
      size: 7,
      linkedAccounts: 2,
      suggestedMatches: [{ person, candidate: { ...person, id: B }, reasons: ["same_name", "same_partner"], score: 90 }]
    };
    expect(disconnectedBranchSchema.parse(branch)).toEqual(branch);
    expect(disconnectedBranchSchema.safeParse({ ...branch, people: [] }).success).toBe(false);
  });

  it("exports the codes and schemas from the barrel", () => {
    expect(Object.values(TreeLinkIssueCode)).toEqual(["PROPOSAL_DUPLICATE", "PROPOSAL_NOT_PENDING"]);
    expect(barrel.createTreeLinkProposalInputSchema).toBe(createTreeLinkProposalInputSchema);
  });
});
