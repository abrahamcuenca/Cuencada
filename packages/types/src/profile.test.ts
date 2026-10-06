import { describe, expect, it } from "vitest";
import { directoryEntrySchema, updateProfileInputSchema } from "./profile.js";
import { upsertRsvpInputSchema } from "./rsvp.js";

const userId = "1b2c3d4e-5f60-4b7c-9d8e-0f1a2b3c4d5e";

describe("directoryEntrySchema", () => {
  it("strips fields that are not part of the public-to-members shape", () => {
    const leaked = {
      userId,
      personId: null,
      displayName: "Ana",
      fullName: "Ana Cuenca",
      familyBranch: null,
      avatarUrl: null,
      bio: null,
      passwordHash: "argon2id$...",
      showPhone: false,
      role: "admin"
    };
    expect(directoryEntrySchema.parse(leaked)).toEqual({
      userId,
      personId: null,
      displayName: "Ana",
      fullName: "Ana Cuenca",
      familyBranch: null,
      avatarUrl: null,
      bio: null
    });
  });

  it("rejects null contact fields: they must be absent when hidden", () => {
    const base = { userId, personId: null, displayName: "Ana", fullName: "Ana", familyBranch: null, avatarUrl: null, bio: null };
    expect(directoryEntrySchema.safeParse({ ...base, phone: null }).success).toBe(false);
    expect(directoryEntrySchema.safeParse({ ...base, phone: "+52 999 123 4567" }).success).toBe(true);
  });
});

describe("updateProfileInputSchema", () => {
  it("turns blank optional text into null", () => {
    expect(updateProfileInputSchema.parse({ city: "   " })).toEqual({ city: null });
  });

  it("rejects an empty patch and an invalid phone", () => {
    expect(updateProfileInputSchema.safeParse({}).success).toBe(false);
    expect(updateProfileInputSchema.safeParse({ phone: "llámame" }).success).toBe(false);
  });
});

describe("upsertRsvpInputSchema", () => {
  it("accepts 0 and 20 guests and rejects 21", () => {
    expect(upsertRsvpInputSchema.safeParse({ status: "yes", guestCount: 0 }).success).toBe(true);
    expect(upsertRsvpInputSchema.safeParse({ status: "yes", guestCount: 20 }).success).toBe(true);
    expect(upsertRsvpInputSchema.safeParse({ status: "yes", guestCount: 21 }).success).toBe(false);
  });

  it("rejects departure before arrival and notes over 500 chars", () => {
    expect(upsertRsvpInputSchema.safeParse({ status: "yes", arrivalDate: "2028-07-03", departureDate: "2028-07-01" }).success).toBe(false);
    expect(upsertRsvpInputSchema.safeParse({ status: "maybe", notes: "a".repeat(501) }).success).toBe(false);
  });
});
