import { describe, expect, it } from "vitest";
import { emptyContacts, makeProfile } from "../testUtils";
import { needsProfileCompletion } from "./completeness";

const base = makeProfile();

describe("needsProfileCompletion", () => {
  it("is true with no photo, no phone and no contacts (pre-WP-4.4 server without `contacts`)", () => {
    expect(needsProfileCompletion(base)).toBe(true);
  });

  it("is true with every contact empty or blank", () => {
    expect(needsProfileCompletion({ ...base, phone: "  ", contacts: { ...emptyContacts(base), website: "" } })).toBe(true);
  });

  it("is false with a photo", () => {
    expect(needsProfileCompletion({ ...base, avatarUrl: "https://fake-storage.test/a.webp" })).toBe(false);
  });

  it("is false with a phone", () => {
    expect(needsProfileCompletion({ ...base, phone: "+525550100101" })).toBe(false);
  });

  it.each(["whatsapp", "instagram", "facebook", "tiktok", "linkedin", "github", "website"] as const)("is false with %s", (key) => {
    expect(needsProfileCompletion({ ...base, contacts: { ...emptyContacts(base), [key]: "prima-ejemplo" } })).toBe(false);
  });
});
