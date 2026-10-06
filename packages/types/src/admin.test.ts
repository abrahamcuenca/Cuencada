import { describe, expect, it } from "vitest";
import { AuditAction, auditActionSchema, auditLogQuerySchema, adminUserPatchInputSchema } from "./admin.js";
import { createRelationshipInputSchema, createPersonInputSchema, familyTreeQuerySchema, updatePersonInputSchema } from "./family.js";
import { adminAttendanceBulkInputSchema } from "./rsvp.js";

const a = "6f1b2a3c-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const b = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

describe("auditLogQuerySchema", () => {
  it("accepts a valid range, compared as instants across offsets", () => {
    expect(auditLogQuerySchema.safeParse({ from: "2026-09-13T10:00:00-06:00", to: "2026-09-13T16:30:00Z" }).success).toBe(true);
  });

  it("rejects from after to", () => {
    const result = auditLogQuerySchema.safeParse({ from: "2026-09-14T00:00:00Z", to: "2026-09-13T00:00:00Z" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["to"]);
  });

  it("accepts known audit actions", () => {
    expect(auditActionSchema.safeParse(AuditAction.CuencadaPublished).success).toBe(true);
    expect(auditActionSchema.safeParse("Publish").success).toBe(false);
  });

  it("accepts every well-known audit action", () => {
    for (const action of Object.values(AuditAction)) {
      expect(auditActionSchema.safeParse(action).success, action).toBe(true);
    }
  });
});

describe("adminUserPatchInputSchema", () => {
  it("accepts role and status changes", () => {
    expect(adminUserPatchInputSchema.parse({ role: "admin", status: "disabled" })).toEqual({ role: "admin", status: "disabled" });
  });

  it("rejects an empty patch, unknown roles and clearing mustChangePassword", () => {
    expect(adminUserPatchInputSchema.safeParse({}).success).toBe(false);
    expect(adminUserPatchInputSchema.safeParse({ role: "owner" }).success).toBe(false);
    expect(adminUserPatchInputSchema.safeParse({ mustChangePassword: false }).success).toBe(false);
  });

  it("strips fields admins cannot set through this endpoint", () => {
    expect(adminUserPatchInputSchema.parse({ status: "active", email: "x@y.mx", passwordHash: "h" })).toEqual({ status: "active" });
  });
});

describe("adminAttendanceBulkInputSchema", () => {
  it("accepts add-only and remove-only changes", () => {
    expect(adminAttendanceBulkInputSchema.parse({ add: [a] })).toEqual({ add: [a], remove: [] });
    expect(adminAttendanceBulkInputSchema.parse({ remove: [b] })).toEqual({ add: [], remove: [b] });
  });

  it("rejects empty changes and overlapping add/remove", () => {
    expect(adminAttendanceBulkInputSchema.safeParse({}).success).toBe(false);
    expect(adminAttendanceBulkInputSchema.safeParse({ add: [a], remove: [a] }).success).toBe(false);
  });
});

describe("createRelationshipInputSchema", () => {
  it("rejects a person related to themselves", () => {
    expect(createRelationshipInputSchema.safeParse({ kind: "parent_of", fromPersonId: a, toPersonId: a }).success).toBe(false);
    expect(createRelationshipInputSchema.safeParse({ kind: "partner_of", fromPersonId: a, toPersonId: b }).success).toBe(true);
  });
});

describe("person years", () => {
  it("rejects a death year before the birth year", () => {
    expect(createPersonInputSchema.safeParse({ fullName: "Abuelo", birthYear: 1930, deathYear: 1920 }).success).toBe(false);
    expect(createPersonInputSchema.safeParse({ fullName: "Abuelo", birthYear: 1930, deathYear: 1930 }).success).toBe(true);
    expect(updatePersonInputSchema.safeParse({ birthYear: 1950, deathYear: 1949 }).success).toBe(false);
  });

  it("rejects years outside 1800–2200 and spoofed names", () => {
    expect(createPersonInputSchema.safeParse({ fullName: "X", birthYear: 1799 }).success).toBe(false);
    expect(createPersonInputSchema.safeParse({ fullName: "\u202Eabc" }).success).toBe(false);
  });
});

describe("familyTreeQuerySchema", () => {
  it("coerces depth and clamps it to 3 (T6 amendment)", () => {
    expect(familyTreeQuerySchema.parse({ depth: "2" })).toEqual({ depth: 2 });
    expect(familyTreeQuerySchema.parse({ depth: "4" })).toEqual({ depth: 3 });
    expect(familyTreeQuerySchema.parse({})).toEqual({ depth: 1 });
    expect(familyTreeQuerySchema.safeParse({ depth: "0" }).success).toBe(false);
    expect(familyTreeQuerySchema.safeParse({ depth: "1.5" }).success).toBe(false);
  });
});
