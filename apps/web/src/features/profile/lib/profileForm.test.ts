import { describe, expect, it } from "vitest";
import { makeProfile } from "../testUtils";
import { buildProfilePatch, dirtyFields, toFormValues } from "./profileForm";

const profile = makeProfile();
const baseline = toFormValues(profile);

describe("dirtyFields", () => {
  it("ignores surrounding spaces and treats blank as empty", () => {
    expect(dirtyFields(baseline, { ...baseline, city: "  Mérida ", bio: "   " })).toEqual([]);
  });

  it("reports a toggled switch", () => {
    expect(dirtyFields(baseline, { ...baseline, listedInDirectory: false })).toEqual(["listedInDirectory"]);
  });
});

describe("buildProfilePatch", () => {
  it("returns a null patch when nothing changed", () => {
    expect(buildProfilePatch(baseline, baseline)).toEqual({ ok: true, patch: null });
  });

  it("trims text and sends null for a cleared optional field", () => {
    const result = buildProfilePatch(baseline, { ...baseline, fullName: "  Rosa Ejemplo ", city: "" });
    expect(result).toEqual({ ok: true, patch: { fullName: "Rosa Ejemplo", city: null } });
  });

  it("rejects a blank required field and a too-long bio with Spanish messages", () => {
    const result = buildProfilePatch(baseline, { ...baseline, displayName: " ", bio: "a".repeat(501) });
    expect(result).toEqual({ ok: false, errors: { displayName: "Este campo es obligatorio.", bio: "Máximo 500 caracteres." } });
  });

  it("sends only listedInDirectory when only it changed", () => {
    expect(buildProfilePatch(baseline, { ...baseline, listedInDirectory: false })).toEqual({ ok: true, patch: { listedInDirectory: false } });
  });
});
