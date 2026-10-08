import { describe, expect, it } from "vitest";
import { buildView, fixtureId, IDS, makeFamilyDb, makePerson } from "../testing/fixtures";
import { issuesToFieldErrors, toNullableText, toNullableYear } from "./forms";
import { collectPersonNames, displayName, extendedGenerations, lifeYears, nextTrail, readTrail, resolveTrail, TRAIL_MAX } from "./tree";

const a = "a";
const b = "b";
const c = "c";

describe("readTrail", () => {
  it("returns an empty trail for missing or malformed history state", () => {
    expect(readTrail(undefined)).toEqual([]);
    expect(readTrail(null)).toEqual([]);
    expect(readTrail({ trail: "x" })).toEqual([]);
    expect(readTrail({ trail: [1, "", "x".repeat(65), a] })).toEqual([a]);
  });

  it("reads legacy { id, name } entries as ids only, dropping the names", () => {
    expect(readTrail({ trail: [{ id: "a", name: "Ana" }, { id: 1, name: "x" }] })).toEqual(["a"]);
  });

  it("keeps at most TRAIL_MAX entries", () => {
    const long = Array.from({ length: 9 }, (_, index) => String(index));
    expect(readTrail({ trail: long })).toHaveLength(TRAIL_MAX);
  });
});

describe("resolveTrail", () => {
  it("names ids from memory and skips the ones it no longer knows", () => {
    expect(resolveTrail(["a", "x", "b"], new Map([["a", "Ana"], ["b", "Beto"]]))).toEqual([
      { id: "a", name: "Ana" },
      { id: "b", name: "Beto" }
    ]);
  });
});

describe("collectPersonNames", () => {
  it("collects names from a tree view and from a people page", () => {
    const db = makeFamilyDb();
    const names = new Map<string, string>();
    collectPersonNames(buildView(db, IDS.jose, 2), names);
    collectPersonNames({ items: [{ id: "p1", fullName: "Persona Uno" }], nextCursor: null }, names);
    expect(names.get(IDS.jose)).toBe("José Herrera Navarro");
    expect(names.get(IDS.luis)).toBe("Luis Herrera Soto");
    expect(names.get("p1")).toBe("Persona Uno");
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
    const long = Array.from({ length: TRAIL_MAX }, (_, index) => String(index));
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
    expect(extendedGenerations(view)).toEqual({ grandparents: [], grandchildren: [], greatGrandparents: [], greatGreatGrandparents: [] });
  });

  it("derives great- and great-great-grandparents from a depth-4 view (WP-4.1)", () => {
    const db = makeFamilyDb();
    const great = makePerson(fixtureId(201), "Bisabuela Ríos");
    const greatGreat = makePerson(fixtureId(202), "Tatarabuelo Ríos");
    db.people.set(great.id, great);
    db.people.set(greatGreat.id, greatGreat);
    db.relationships.push(
      { id: fixtureId(301), kind: "parent_of", fromPersonId: great.id, toPersonId: IDS.ernesto },
      { id: fixtureId(302), kind: "parent_of", fromPersonId: greatGreat.id, toPersonId: great.id }
    );
    const view = buildView(db, IDS.jose, 4);
    if (view === null) throw new Error("missing fixture");
    const generations = extendedGenerations(view);
    expect(generations.greatGrandparents.map((person) => person.fullName)).toEqual(["Bisabuela Ríos"]);
    expect(generations.greatGreatGrandparents.map((person) => person.fullName)).toEqual(["Tatarabuelo Ríos"]);
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
