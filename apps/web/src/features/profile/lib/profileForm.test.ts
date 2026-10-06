import { describe, expect, it } from "vitest";
import { makeProfile } from "../testUtils";
import { buildProfilePatch, detectSupport, dirtyFields, type ProfileWithListing, toFormValues } from "./profileForm";

const profile = makeProfile();
const baseline = toFormValues(profile);
const contractOnly = detectSupport(profile);
const listed: ProfileWithListing = { ...profile, visibility: { ...profile.visibility, listedInDirectory: true } };

describe("dirtyFields", () => {
  it("ignores surrounding spaces and treats blank as empty", () => {
    expect(dirtyFields(baseline, { ...baseline, city: "  Mérida ", phone: "   " }, contractOnly)).toEqual([]);
  });

  it("ignores listedInDirectory while the server does not send it", () => {
    expect(dirtyFields(baseline, { ...baseline, listedInDirectory: false }, contractOnly)).toEqual([]);
  });
});

describe("buildProfilePatch", () => {
  it("returns a null patch when nothing changed", () => {
    expect(buildProfilePatch(baseline, baseline, contractOnly)).toEqual({ ok: true, patch: null });
  });

  it("trims text and sends null for a cleared optional field", () => {
    const result = buildProfilePatch(baseline, { ...baseline, fullName: "  Rosa Cuenca ", city: "" }, contractOnly);
    expect(result).toEqual({ ok: true, patch: { fullName: "Rosa Cuenca", city: null } });
  });

  it("rejects a blank required field and a too-long bio with Spanish messages", () => {
    const result = buildProfilePatch(baseline, { ...baseline, displayName: " ", bio: "a".repeat(501) }, contractOnly);
    expect(result).toEqual({ ok: false, errors: { displayName: "Este campo es obligatorio.", bio: "Máximo 500 caracteres." } });
  });

  it("rejects an invalid phone", () => {
    expect(buildProfilePatch(baseline, { ...baseline, phone: "llámame" }, contractOnly)).toEqual({ ok: false, errors: { phone: "Teléfono inválido." } });
  });

  it("sends only listedInDirectory when only it changed", () => {
    const base = toFormValues(listed);
    expect(buildProfilePatch(base, { ...base, listedInDirectory: false }, detectSupport(listed))).toEqual({ ok: true, patch: { listedInDirectory: false } });
  });
});
