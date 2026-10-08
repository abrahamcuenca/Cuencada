/** WP-4.5 contracts: merge defaults, merged values, input and snapshot schemas. */
import { describe, expect, it } from "vitest";
import {
  type PersonMergeValues,
  defaultMergeChoices,
  familyDuplicatesQuerySchema,
  mergedPersonValues,
  personDatesIssue,
  personMergeInputSchema,
  personMergePreviewQuerySchema,
  personRevisionSchema,
  personRevisionSnapshotSchema
} from "./family.js";

const keepId = "1b2c3d4e-5f60-4b7c-9d8e-0f1a2b3c4d5e";
const duplicateId = "2c3d4e5f-6071-4c8d-8e9f-1a2b3c4d5e6f";

const blank: PersonMergeValues = {
  fullName: "Lucía Ejemplo",
  nickname: null,
  familyBranch: null,
  birthYear: null,
  birthDate: null,
  deathYear: null,
  deathDate: null,
  deceased: false,
  birthplace: null,
  bio: null
};

describe("defaultMergeChoices", () => {
  it("keeps the kept person's values and fills its blanks from the duplicate", () => {
    const keep = { ...blank, familyBranch: "Rama Norte", birthYear: 1990 };
    const duplicate = { ...blank, fullName: "Lucía Ejemplo Pérez", familyBranch: "Rama Sur", nickname: "Lu", birthYear: 1991, bio: "Maestra." };
    expect(defaultMergeChoices(keep, duplicate)).toEqual({
      fullName: "keep",
      nickname: "duplicate",
      familyBranch: "keep",
      birthYear: "keep",
      birthDate: "keep",
      deathYear: "keep",
      deathDate: "keep",
      deceased: "keep",
      birthplace: "keep",
      bio: "duplicate"
    });
  });

  it("takes a date only when it falls in the resulting year, so the defaults pass the date rules", () => {
    const keep = { ...blank, birthYear: 1990 };
    expect(defaultMergeChoices(keep, { ...blank, birthYear: 1990, birthDate: "1990-05-02" }).birthDate).toBe("duplicate");
    expect(defaultMergeChoices(keep, { ...blank, birthYear: 1991, birthDate: "1991-05-02" }).birthDate).toBe("keep");
    const both = mergedPersonValues({ ...blank }, { ...blank, birthYear: 1991, birthDate: "1991-05-02" });
    expect(both).toMatchObject({ birthYear: 1991, birthDate: "1991-05-02" });
    expect(personDatesIssue(both)).toBeNull();
  });

  it("takes the death from the duplicate only when it says the person died", () => {
    const dead = { ...blank, deceased: true, deathYear: 2010, deathDate: "2010-01-02" };
    const merged = mergedPersonValues(blank, dead);
    expect(merged).toMatchObject({ deceased: true, deathYear: 2010, deathDate: "2010-01-02" });
    expect(personDatesIssue(merged)).toBeNull();
    expect(defaultMergeChoices({ ...blank, deceased: true }, blank).deceased).toBe("keep");
  });
});

describe("mergedPersonValues", () => {
  it("honors explicit choices, including a kept blank", () => {
    const keep = { ...blank, birthYear: 1950 };
    const duplicate = { ...blank, fullName: "Ana", nickname: "Anita", birthYear: 1951, birthDate: "1951-02-03" };
    expect(mergedPersonValues(keep, duplicate, { nickname: "keep", fullName: "duplicate" })).toMatchObject({ fullName: "Ana", nickname: null, birthYear: 1950 });
    // A mixed choice can break a date rule: the server answers 400.
    expect(personDatesIssue(mergedPersonValues(keep, duplicate, { birthDate: "duplicate" }))).not.toBeNull();
  });
});

describe("merge inputs", () => {
  it("accepts a duplicate id with optional per-field choices and rejects anything else", () => {
    expect(personMergeInputSchema.parse({ duplicateId, fields: { bio: "duplicate" } })).toEqual({ duplicateId, fields: { bio: "duplicate" } });
    expect(personMergeInputSchema.safeParse({ duplicateId }).success).toBe(true);
    expect(personMergeInputSchema.safeParse({ duplicateId, userId: keepId }).success).toBe(false);
    expect(personMergeInputSchema.safeParse({ duplicateId, fields: { userId: "duplicate" } }).success).toBe(false);
    expect(personMergeInputSchema.safeParse({ duplicateId, fields: { bio: "both" } }).success).toBe(false);
    expect(personMergeInputSchema.safeParse({ duplicateId: "no" }).success).toBe(false);
    expect(personMergePreviewQuerySchema.safeParse({}).success).toBe(false);
    expect(familyDuplicatesQuerySchema.parse({})).toEqual({ limit: 20 });
  });
});

describe("person.merge revision", () => {
  it("parses a merge snapshot (ids and snapshots only) in a revision", () => {
    const person = (id: string) => ({ type: "person" as const, personId: id, id, userId: null, ...blank });
    const before = {
      type: "merge",
      personId: keepId,
      id: keepId,
      duplicatePersonId: duplicateId,
      keep: person(keepId),
      duplicate: person(duplicateId),
      duplicateCreatedByUserId: null,
      keepRelationshipIds: [],
      relationships: [
        { id: "3d4e5f60-7182-4d9e-9fa0-2b3c4d5e6f70", kind: "partner_of", fromPersonId: duplicateId, toPersonId: keepId, createdByMember: false, createdByUserId: null, outcome: "self" }
      ],
      photo: { keep: false, duplicate: true, moved: true, duplicateUpdatedAt: "2026-01-02T03:04:05.000Z" },
      invites: { moved: [], revoked: [] },
      attendance: { moved: [], droppedCuencadaIds: [] }
    };
    expect(personRevisionSnapshotSchema.parse(before)).toEqual(before);
    expect(
      personRevisionSchema.safeParse({
        id: "4e5f6071-8293-4eaf-a0b1-3c4d5e6f7081",
        personId: keepId,
        relationshipId: null,
        action: "person.merge",
        actor: null,
        before,
        after: person(keepId),
        revertedByRevisionId: null,
        revertible: true,
        createdAt: "2026-10-07T10:00:00.000Z"
      }).success
    ).toBe(true);
    expect(personRevisionSnapshotSchema.safeParse({ ...before, duplicatePersonId: undefined }).success).toBe(false);
  });
});
