import { describe, expect, it } from "vitest";
import { InviteIssueCode } from "./auth.js";
import { API_ERROR_DETAIL_CODE_MAX } from "./common.js";
import {
  FamilyIssueCode,
  adminCreatePersonInputSchema,
  adminUpdatePersonInputSchema,
  memberCreatePersonInputSchema,
  memberUpdatePersonInputSchema,
  personDatesIssue,
  personDetailsSchema,
  personPhotoConfirmInputSchema,
  personRevisionSchema,
  personSchema,
  personRevisionSnapshotSchema,
  purgePersonRevisionsInputSchema,
  revertPersonRevisionInputSchema,
} from "./family.js";
import { clampCropRect, imageCropRectSchema } from "./profile.js";

const anchor = "1b2c3d4e-5f60-4b7c-9d8e-0f1a2b3c4d5e";
const other = "2c3d4e5f-6071-4c8d-8e9f-1a2b3c4d5e6f";

describe("adminCreatePersonInputSchema", () => {
  it("defaults everything optional and derives nothing from nothing", () => {
    expect(
      adminCreatePersonInputSchema.parse({ fullName: "Ana Morales Vega" }),
    ).toEqual({
      fullName: "Ana Morales Vega",
      nickname: null,
      familyBranch: null,
      birthYear: null,
      deathYear: null,
      birthDate: null,
      deathDate: null,
      birthplace: null,
      bio: null,
      deceased: false,
      userId: null,
      relateTo: null,
    });
  });

  it("derives the years from full dates and marks a death as deceased", () => {
    const parsed = adminCreatePersonInputSchema.parse({
      fullName: "Bisabuelo Vega",
      birthDate: "1901-02-03",
      deathDate: "1980-12-31",
      birthplace: "  Valladolid, Yucatán ",
      relateTo: { personId: anchor, kind: "parent_of" },
    });
    expect(parsed).toMatchObject({
      birthYear: 1901,
      deathYear: 1980,
      deceased: true,
      birthplace: "Valladolid, Yucatán",
      relateTo: { personId: anchor, kind: "parent_of" },
    });
  });

  it("accepts a matching year and rejects a mismatched one", () => {
    expect(
      adminCreatePersonInputSchema.safeParse({
        fullName: "X",
        birthYear: 1950,
        birthDate: "1950-06-01",
      }).success,
    ).toBe(true);
    const mismatch = adminCreatePersonInputSchema.safeParse({
      fullName: "X",
      birthYear: 1951,
      birthDate: "1950-06-01",
    });
    expect(mismatch.success).toBe(false);
    expect(mismatch.error?.issues[0]?.path).toEqual(["birthYear"]);
  });

  it("rejects death before birth, a death for a living person, and bad dates", () => {
    expect(
      adminCreatePersonInputSchema.safeParse({
        fullName: "X",
        birthDate: "1950-06-01",
        deathDate: "1950-05-31",
      }).success,
    ).toBe(false);
    expect(
      adminCreatePersonInputSchema.safeParse({
        fullName: "X",
        deathYear: 1990,
        deceased: false,
      }).success,
    ).toBe(false);
    expect(
      adminCreatePersonInputSchema.safeParse({
        fullName: "X",
        birthDate: "1950-02-30",
      }).success,
    ).toBe(false);
    expect(
      adminCreatePersonInputSchema.safeParse({
        fullName: "X",
        birthDate: "1799-12-31",
      }).success,
    ).toBe(false);
    expect(
      adminCreatePersonInputSchema.safeParse({
        fullName: "X",
        birthDate: "01/02/1950",
      }).success,
    ).toBe(false);
  });

  it("bounds birthplace and bio and rejects unsafe characters in the birthplace", () => {
    expect(
      adminCreatePersonInputSchema.safeParse({
        fullName: "X",
        birthplace: "é".repeat(120),
      }).success,
    ).toBe(true);
    expect(
      adminCreatePersonInputSchema.safeParse({
        fullName: "X",
        birthplace: "é".repeat(121),
      }).success,
    ).toBe(false);
    expect(
      adminCreatePersonInputSchema.safeParse({
        fullName: "X",
        birthplace: "Mérida‮",
      }).success,
    ).toBe(false);
    expect(
      adminCreatePersonInputSchema.safeParse({
        fullName: "X",
        bio: "a".repeat(1000),
      }).success,
    ).toBe(true);
    expect(
      adminCreatePersonInputSchema.safeParse({
        fullName: "X",
        bio: "a".repeat(1001),
      }).success,
    ).toBe(false);
  });

  it("is strict", () => {
    expect(
      adminCreatePersonInputSchema.safeParse({
        fullName: "X",
        photoKey: "people/x",
      }).success,
    ).toBe(false);
    expect(
      adminCreatePersonInputSchema.safeParse({
        fullName: "X",
        relateTo: { personId: anchor, kind: "sibling_of" },
      }).success,
    ).toBe(false);
  });
});

describe("memberCreatePersonInputSchema", () => {
  it("requires relateTo and refuses userId", () => {
    expect(
      memberCreatePersonInputSchema.safeParse({ fullName: "Hija" }).success,
    ).toBe(false);
    expect(
      memberCreatePersonInputSchema.safeParse({
        fullName: "Hija",
        relateTo: { personId: anchor, kind: "child_of" },
        userId: other,
      }).success,
    ).toBe(false);
    const parsed = memberCreatePersonInputSchema.parse({
      fullName: "Hija",
      relateTo: { personId: anchor, kind: "child_of" },
    });
    expect(parsed.relateTo).toEqual({ personId: anchor, kind: "child_of" });
    expect(parsed.deceased).toBe(false);
  });

  it("applies the same date rules as the admin create", () => {
    const relateTo = { personId: anchor, kind: "partner_of" };
    expect(
      memberCreatePersonInputSchema.parse({
        fullName: "Esposa",
        birthDate: "1992-04-05",
        relateTo,
      }).birthYear,
    ).toBe(1992);
    expect(
      memberCreatePersonInputSchema.safeParse({
        fullName: "Esposa",
        birthYear: 1990,
        birthDate: "1992-04-05",
        relateTo,
      }).success,
    ).toBe(false);
  });
});

describe("adminUpdatePersonInputSchema / memberUpdatePersonInputSchema", () => {
  it("never adds defaults to a patch", () => {
    expect(
      adminUpdatePersonInputSchema.parse({ bio: "Le gustaba cantar." }),
    ).toEqual({ bio: "Le gustaba cantar." });
    expect(memberUpdatePersonInputSchema.parse({ nickname: "Tita" })).toEqual({
      nickname: "Tita",
    });
  });

  it("fills the year from a date and marks a death as deceased", () => {
    expect(
      memberUpdatePersonInputSchema.parse({ birthDate: "1950-03-04" }),
    ).toEqual({ birthDate: "1950-03-04", birthYear: 1950 });
    expect(
      memberUpdatePersonInputSchema.parse({ deathDate: "2001-01-01" }),
    ).toEqual({
      deathDate: "2001-01-01",
      deathYear: 2001,
      deceased: true,
    });
    expect(memberUpdatePersonInputSchema.parse({ deathYear: 2001 })).toEqual({
      deathYear: 2001,
      deceased: true,
    });
    // Clearing a date does not touch the year.
    expect(memberUpdatePersonInputSchema.parse({ birthDate: null })).toEqual({
      birthDate: null,
    });
  });

  it("rejects contradictions inside the patch itself", () => {
    expect(
      memberUpdatePersonInputSchema.safeParse({
        birthDate: "1950-03-04",
        birthYear: 1951,
      }).success,
    ).toBe(false);
    expect(
      memberUpdatePersonInputSchema.safeParse({
        birthDate: "1950-03-04",
        birthYear: null,
      }).success,
    ).toBe(false);
    expect(
      memberUpdatePersonInputSchema.safeParse({
        deathYear: 1990,
        deceased: false,
      }).success,
    ).toBe(false);
    expect(
      memberUpdatePersonInputSchema.safeParse({
        birthYear: 1990,
        deathYear: 1980,
        deceased: true,
      }).success,
    ).toBe(false);
    expect(
      memberUpdatePersonInputSchema.safeParse({
        birthDate: "1950-03-04",
        deathDate: "1950-03-03",
        deceased: true,
      }).success,
    ).toBe(false);
    expect(
      memberUpdatePersonInputSchema.safeParse({ deceased: false }).success,
    ).toBe(true);
  });

  it("rejects empty patches and, for members, userId", () => {
    expect(adminUpdatePersonInputSchema.safeParse({}).success).toBe(false);
    expect(memberUpdatePersonInputSchema.safeParse({}).success).toBe(false);
    expect(
      adminUpdatePersonInputSchema.safeParse({ userId: other }).success,
    ).toBe(true);
    expect(
      memberUpdatePersonInputSchema.safeParse({ userId: other }).success,
    ).toBe(false);
  });
});

describe("personDatesIssue", () => {
  it("checks a merged row the way the database does", () => {
    expect(personDatesIssue({})).toBeNull();
    expect(
      personDatesIssue({ birthYear: 1950, birthDate: "1950-03-04" }),
    ).toBeNull();
    expect(
      personDatesIssue({ birthYear: 1949, birthDate: "1950-03-04" })?.path,
    ).toBe("birthYear");
    expect(personDatesIssue({ birthDate: "1950-03-04" })?.path).toBe(
      "birthYear",
    );
    expect(
      personDatesIssue({ deathYear: 1990, deathDate: "1990-01-01" })?.path,
    ).toBe("deceased");
    expect(
      personDatesIssue({
        deathYear: 1990,
        deathDate: "1991-01-01",
        deceased: true,
      })?.path,
    ).toBe("deathYear");
    expect(
      personDatesIssue({ birthYear: 1990, deathYear: 1989, deceased: true })
        ?.path,
    ).toBe("deathYear");
    expect(
      personDatesIssue({
        birthYear: 1990,
        birthDate: "1990-05-05",
        deathYear: 1990,
        deathDate: "1990-05-04",
        deceased: true,
      })?.path,
    ).toBe("deathDate");
    expect(
      personDatesIssue({
        birthYear: 1990,
        birthDate: "1990-05-05",
        deathYear: 1990,
        deathDate: "1990-05-05",
        deceased: true,
      }),
    ).toBeNull();
  });
});

describe("person read models", () => {
  const person = {
    id: anchor,
    userId: null,
    fullName: "Bisabuela Vega",
    nickname: null,
    familyBranch: "Rama Norte",
    birthYear: 1905,
    deathYear: 1990,
    deceased: true,
    avatarUrl: null,
  };

  it("parses a Person from an older server (no WP-4 fields)", () => {
    expect(personSchema.parse(person)).toEqual(person);
    expect(
      personSchema.parse({ ...person, birthDate: "1905-01-02", bio: null })
        .birthDate,
    ).toBe("1905-01-02");
  });

  it("requires every details field and validates nested contacts", () => {
    const details = {
      ...person,
      birthDate: null,
      deathDate: "1990-07-08",
      birthplace: "Mérida",
      bio: null,
      photoUrl: null,
      photoSource: null,
      isLinked: false,
      canEdit: true,
      canEditPhoto: true,
      contacts: [],
    };
    expect(personDetailsSchema.parse(details)).toEqual(details);
    const { canEdit: _canEdit, ...missing } = details;
    expect(personDetailsSchema.safeParse(missing).success).toBe(false);
    expect(
      personDetailsSchema.safeParse({
        ...details,
        contacts: [
          {
            kind: "website",
            label: "x",
            href: "javascript:alert(1)",
            display: "x",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      personDetailsSchema.safeParse({ ...details, photoSource: "gravatar" })
        .success,
    ).toBe(false);
  });

  it("parses revisions and rejects unknown snapshot types or actions", () => {
    const revision = {
      id: anchor,
      personId: null,
      relationshipId: other,
      action: "relationship.delete",
      actor: { userId: other, displayName: "Admin" },
      before: {
        type: "relationship",
        personId: other,
        id: other,
        kind: "parent_of",
        fromPersonId: anchor,
        toPersonId: other,
      },
      after: null,
      revertedByRevisionId: null,
      revertible: true,
      createdAt: "2026-10-07T12:00:00Z",
    };
    expect(personRevisionSchema.parse(revision)).toEqual(revision);
    expect(
      personRevisionSchema.safeParse({ ...revision, action: "person.bogus" })
        .success,
    ).toBe(false);
    expect(
      personRevisionSchema.safeParse({
        ...revision,
        before: { type: "secret", id: other },
      }).success,
    ).toBe(false);
    const photo = {
      ...revision,
      action: "person.photo",
      before: {
        type: "photo",
        personId: anchor,
        id: anchor,
        hasPhoto: true,
        photoUpdatedAt: null,
      },
      photoKey: "x",
    };
    expect(personRevisionSchema.parse(photo)).not.toHaveProperty("photoKey");
    expect(
      revertPersonRevisionInputSchema.safeParse({ revisionId: anchor }).success,
    ).toBe(true);
    expect(
      revertPersonRevisionInputSchema.safeParse({
        revisionId: anchor,
        force: true,
      }).success,
    ).toBe(false);
  });

  it("requires personId on every snapshot (Security L2)", () => {
    for (const snapshot of [
      { type: "relationship", id: other, kind: "parent_of", fromPersonId: anchor, toPersonId: other },
      { type: "photo", id: anchor, hasPhoto: false, photoUpdatedAt: null },
      {
        type: "person",
        id: anchor,
        userId: null,
        fullName: "X",
        nickname: null,
        familyBranch: null,
        birthYear: null,
        deathYear: null,
        birthDate: null,
        deathDate: null,
        birthplace: null,
        bio: null,
        deceased: false,
      },
    ]) {
      expect(personRevisionSnapshotSchema.safeParse(snapshot).success, snapshot.type).toBe(false);
      expect(personRevisionSnapshotSchema.safeParse({ ...snapshot, personId: anchor }).success, snapshot.type).toBe(true);
    }
  });

  it("purge body is strict and needs an explicit confirm (the person is the path :id)", () => {
    expect(purgePersonRevisionsInputSchema.parse({ confirm: true })).toEqual({ confirm: true });
    expect(purgePersonRevisionsInputSchema.safeParse({}).success).toBe(false);
    expect(purgePersonRevisionsInputSchema.safeParse({ confirm: "true" }).success).toBe(false);
    expect(purgePersonRevisionsInputSchema.safeParse({ confirm: false }).success).toBe(false);
    expect(purgePersonRevisionsInputSchema.safeParse({ confirm: true, personId: anchor }).success).toBe(false);
  });
});

describe("image crop", () => {
  it("accepts integer rects and rejects negatives, fractions and zero size", () => {
    expect(imageCropRectSchema.parse({ x: 0, y: 10, size: 512 })).toEqual({
      x: 0,
      y: 10,
      size: 512,
    });
    for (const rect of [
      { x: -1, y: 0, size: 10 },
      { x: 0.5, y: 0, size: 10 },
      { x: 0, y: 0, size: 0 },
      { x: 0, y: 0, size: 30_001 },
      { x: 0, y: 0 },
    ]) {
      expect(
        imageCropRectSchema.safeParse(rect).success,
        JSON.stringify(rect),
      ).toBe(false);
    }
    expect(
      imageCropRectSchema.safeParse({ x: 0, y: 0, size: 10, rotate: 90 })
        .success,
    ).toBe(false);
  });

  it("is optional on the person photo confirm", () => {
    expect(personPhotoConfirmInputSchema.parse({ uploadId: anchor })).toEqual({
      uploadId: anchor,
    });
    expect(
      personPhotoConfirmInputSchema.parse({
        uploadId: anchor,
        crop: { x: 1, y: 2, size: 3 },
      }).crop,
    ).toEqual({ x: 1, y: 2, size: 3 });
  });

  it("clampCropRect keeps the square's size and shifts its origin inside the image", () => {
    // Fully inside: unchanged.
    expect(clampCropRect({ x: 100, y: 50, size: 400 }, 1000, 800)).toEqual({ left: 100, top: 50, width: 400, height: 400 });
    // Overflowing right / bottom: shifted back, not shrunk.
    expect(clampCropRect({ x: 900, y: 0, size: 400 }, 1000, 800)).toEqual({ left: 600, top: 0, width: 400, height: 400 });
    expect(clampCropRect({ x: 0, y: 700, size: 400 }, 1000, 800)).toEqual({ left: 0, top: 400, width: 400, height: 400 });
    expect(clampCropRect({ x: 5000, y: 5000, size: 400 }, 1000, 800)).toEqual({ left: 600, top: 400, width: 400, height: 400 });
    // Larger than the shorter side: capped to it, then shifted.
    expect(clampCropRect({ x: 0, y: 0, size: 30_000 }, 1000, 800)).toEqual({ left: 0, top: 0, width: 800, height: 800 });
    expect(clampCropRect({ x: 500, y: 100, size: 900 }, 1000, 800)).toEqual({ left: 200, top: 0, width: 800, height: 800 });
    // Exact fit and a 1×1 image.
    expect(clampCropRect({ x: 0, y: 0, size: 800 }, 800, 800)).toEqual({ left: 0, top: 0, width: 800, height: 800 });
    expect(clampCropRect({ x: 3, y: 3, size: 3 }, 1, 1)).toEqual({ left: 0, top: 0, width: 1, height: 1 });
    // Fractions from direct callers are truncated; the result always fits.
    const odd = clampCropRect({ x: 10.9, y: 0.5, size: 99.9 }, 101, 100);
    expect(odd).toEqual({ left: 2, top: 0, width: 99, height: 99 });
    expect(() => clampCropRect({ x: 0, y: 0, size: 1 }, 0, 10)).toThrow(
      RangeError,
    );
    expect(() => clampCropRect({ x: 0, y: 0, size: 1 }, 10.5, 10)).toThrow(
      RangeError,
    );
    // Direct callers that skip the schema: non-finite values never reach extract().
    for (const rect of [
      { x: Number.NaN, y: 0, size: 10 },
      { x: 0, y: Number.POSITIVE_INFINITY, size: 10 },
      { x: 0, y: 0, size: Number.NaN },
      { x: 0, y: 0, size: Number.POSITIVE_INFINITY },
    ]) {
      expect(() => clampCropRect(rect, 100, 100), JSON.stringify(rect)).toThrow(RangeError);
    }
  });
});

describe("WP-4 issue codes", () => {
  it("fit the open detail-code channel", () => {
    const codes = [
      ...Object.values(FamilyIssueCode),
      ...Object.values(InviteIssueCode),
    ];
    expect(codes).toEqual([
      "FAMILY_NOT_IN_CIRCLE",
      "PERSON_LINKED_TO_OTHER",
      "PERSON_HAS_RELATIONSHIPS",
      "NOT_CREATOR",
      "ADMIN_ONLY_FIELD",
      "MERGE_BOTH_LINKED",
      "MERGE_CONFLICT",
      "MERGE_NOT_REVERTIBLE",
      "INVITE_PERSON_DECEASED",
      "INVITE_PERSON_REQUIRES_BOUND",
      "PERSON_HAS_PENDING_INVITE",
    ]);
    for (const code of codes)
      expect(code.length).toBeLessThanOrEqual(API_ERROR_DETAIL_CODE_MAX);
  });
});
