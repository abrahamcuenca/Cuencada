import { describe, expect, it } from "vitest";
import { buildView, IDS, makeFamilyDb } from "../testing/fixtures";
import { issuesToFieldErrors, toNullableText, toNullableYear } from "./forms";
import { displayName, extendedGenerations, lifeYears, nextTrail, readTrail, TRAIL_MAX } from "./tree";

const a = { id: "a", name: "Ana" };
const b = { id: "b", name: "Beto" };
const c = { id: "c", name: "Ceci" };

describe("readTrail", () => {
  it("returns an empty trail for missing or malformed history state", () => {
    expect(readTrail(undefined)).toEqual([]);
    expect(readTrail(null)).toEqual([]);
    expect(readTrail({ trail: "x" })).toEqual([]);
    expect(readTrail({ trail: [{ id: 1, name: "x" }, a] })).toEqual([a]);
  });

  it("keeps at most TRAIL_MAX entries", () => {
    const long = Array.from({ length: 9 }, (_, index) => ({ id: String(index), name: `P${index}` }));
    expect(readTrail({ trail: long })).toHaveLength(TRAIL_MAX);
  });
});

describe("nextTrail", () => {
  it("appends the person being left", () => {
    expect(nextTrail([a], b, "c")).toEqual([a, b]);
  });

  it("cuts the trail back when returning to someone already in it", () => {
    expect(nextTrail([a, b], c, "a")).toEqual([]);
    expect(nextTrail([a, b], c, "b")).toEqual([a]);
  });

  it("works without a current focus and caps the length", () => {
    expect(nextTrail([a], null, "z")).toEqual([a]);
    const long = Array.from({ length: TRAIL_MAX }, (_, index) => ({ id: String(index), name: `P${index}` }));
    expect(nextTrail(long, c, "z")).toHaveLength(TRAIL_MAX);
  });
});

describe("lifeYears", () => {
  it("formats every combination of known years", () => {
    expect(lifeYears({ birthYear: 1930, deathYear: 2015, deceased: true })).toBe("1930 – 2015");
    expect(lifeYears({ birthYear: 1952, deathYear: null, deceased: false })).toBe("n. 1952");
    expect(lifeYears({ birthYear: 1900, deathYear: null, deceased: true })).toBe("1900 – ?");
    expect(lifeYears({ birthYear: null, deathYear: 1999, deceased: true })).toBe("† 1999");
    expect(lifeYears({ birthYear: null, deathYear: null, deceased: false })).toBeNull();
  });
});

describe("displayName", () => {
  it("adds the nickname in quotes only when present", () => {
    expect(displayName({ fullName: "José", nickname: "Pepe" })).toBe("José «Pepe»");
    expect(displayName({ fullName: "José", nickname: null })).toBe("José");
  });
});

describe("extendedGenerations", () => {
  it("derives grandparents and grandchildren from parent_of edges", () => {
    const view = buildView(makeFamilyDb(), IDS.jose, 2);
    if (view === null) throw new Error("missing fixture");
    const { grandparents, grandchildren } = extendedGenerations(view);
    expect(grandparents.map((person) => person.id).sort()).toEqual([IDS.ernesto, IDS.lucia].sort());
    expect(grandchildren.map((person) => person.id).sort()).toEqual([IDS.valeria, IDS.hugo].sort());
  });

  it("returns empty rings at depth 1", () => {
    const view = buildView(makeFamilyDb(), IDS.jose, 1);
    if (view === null) throw new Error("missing fixture");
    expect(extendedGenerations(view)).toEqual({ grandparents: [], grandchildren: [] });
  });
});

describe("form helpers", () => {
  it("turns blanks into null and keeps malformed years for the schema", () => {
    expect(toNullableText("  ")).toBeNull();
    expect(toNullableText(" Pepe ")).toBe("Pepe");
    expect(toNullableYear("")).toBeNull();
    expect(toNullableYear("1952")).toBe(1952);
    expect(toNullableYear("19a2")).toBeNaN();
  });

  it("maps zod issues to the first message per field, in Spanish for years", () => {
    expect(
      issuesToFieldErrors([
        { code: "too_small", path: ["birthYear"], message: "Too small" },
        { code: "custom", path: ["deathYear"], message: "El año de fallecimiento no puede ser anterior al de nacimiento." },
        { code: "custom", path: [], message: "No hay cambios que guardar." }
      ])
    ).toEqual({
      birthYear: "Escribe un año entre 1800 y 2200.",
      deathYear: "El año de fallecimiento no puede ser anterior al de nacimiento.",
      _form: "No hay cambios que guardar."
    });
  });
});
