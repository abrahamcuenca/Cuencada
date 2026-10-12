/** WP-4.5: name normalization and matching for "Posibles duplicados" (pure). */
import { describe, expect, it } from "vitest";
import { compatibleYears, type MatchProfile, nameMatch, nameTokens, normalizedName, scoreMatch } from "./duplicates.js";

describe("nameTokens", () => {
  it("ignores case, accents, extra spaces and punctuation", () => {
    expect(nameTokens("  LUCÍA   ejemplo-Pérez ")).toEqual(["lucia", "ejemplo", "perez"]);
    expect(nameTokens("Ñoño O'Ficticio")).toEqual(["nono", "o", "ficticio"]);
    expect(nameTokens("   ")).toEqual([]);
  });
});

describe("nameMatch", () => {
  it("matches equal names, or one extra trailing word (a second surname) when the shorter has two words", () => {
    expect(nameMatch(nameTokens("Lucía Ejemplo"), nameTokens("lucia ejemplo"))).toBe("same_name");
    expect(nameMatch(nameTokens("Lucía Ejemplo"), nameTokens("Lucía Ejemplo Pérez"))).toBe("similar_name");
    expect(nameMatch(nameTokens("Lucía Ejemplo Pérez"), nameTokens("Lucía Ejemplo"))).toBe("similar_name");
    expect(nameMatch(nameTokens("Lucía"), nameTokens("Lucía Ejemplo"))).toBeNull();
    expect(nameMatch(nameTokens("Lucía Ejemplo"), nameTokens("Lucía Ejemplo Pérez Ríos"))).toBeNull();
    expect(nameMatch(nameTokens("Lucía Ejemplo"), nameTokens("Lucía Muestra"))).toBeNull();
    expect(nameMatch([], [])).toBeNull();
  });
});

describe("scoreMatch (WP-6.4)", () => {
  const profile = (overrides: Partial<MatchProfile> & { name: string }): MatchProfile => ({
    id: overrides.id ?? overrides.name,
    tokens: nameTokens(overrides.name),
    nickname: overrides.nickname ?? null,
    birthYear: overrides.birthYear ?? null,
    deathYear: overrides.deathYear ?? null,
    partnerNames: overrides.partnerNames ?? [],
    childNames: overrides.childNames ?? []
  });

  it("scores a same name, adding structural signals", () => {
    const a = profile({ id: "a", name: "Ramiro Ejemplo", partnerNames: ["rosa muestra"], childNames: ["jorge ejemplo", "ines ejemplo"] });
    const b = profile({ id: "b", name: "Ramiro Ejemplo", partnerNames: ["rosa muestra vega"], childNames: ["jorge ejemplo", "ines ejemplo"] });
    expect(scoreMatch(a, b)).toEqual({ reasons: ["same_name", "same_partner", "shared_children"], score: 100 });
    expect(scoreMatch(profile({ id: "a", name: "Ramiro Ejemplo" }), profile({ id: "b", name: "ramiro EJEMPLO" }))).toEqual({
      reasons: ["same_name"],
      score: 60
    });
    expect(scoreMatch(profile({ id: "a", name: "Ramiro Ejemplo" }), profile({ id: "b", name: "Ramiro Ejemplo Vega" }))?.reasons).toEqual(["similar_name"]);
  });

  it("matches a nickname against a first name, but only with another signal", () => {
    const pepe = profile({ id: "a", name: "José Ejemplo", nickname: "pepe", partnerNames: ["rosa muestra"] });
    const other = profile({ id: "b", name: "Pepe Ejemplo", partnerNames: ["rosa muestra"] });
    expect(scoreMatch(pepe, other)).toEqual({ reasons: ["nickname", "same_partner"], score: 55 });
    expect(scoreMatch(profile({ id: "a", name: "José Ejemplo", nickname: "pepe" }), profile({ id: "b", name: "Pepe Muestra" }))).toBeNull();
  });

  it("never matches on structure alone, the same id, or incompatible years", () => {
    const a = profile({ id: "a", name: "Ana Morales", partnerNames: ["luis vega"], childNames: ["sara vega"] });
    const b = profile({ id: "b", name: "Beatriz Ficticia", partnerNames: ["luis vega"], childNames: ["sara vega"] });
    expect(scoreMatch(a, b)).toBeNull();
    expect(scoreMatch(a, { ...a })).toBeNull();
    expect(scoreMatch(profile({ id: "a", name: "Ana Morales", birthYear: 1950 }), profile({ id: "b", name: "Ana Morales", birthYear: 1960 }))).toBeNull();
  });

  it("normalizes names and nicknames, empty as null", () => {
    expect(normalizedName("  Rosa  MUESTRA ")).toBe("rosa muestra");
    expect(normalizedName("  ")).toBeNull();
    expect(normalizedName(null)).toBeNull();
  });
});

describe("compatibleYears", () => {
  it("allows unknown years and a difference of one", () => {
    expect(compatibleYears({ birthYear: 1990, deathYear: null }, { birthYear: null, deathYear: null })).toBe(true);
    expect(compatibleYears({ birthYear: 1990, deathYear: null }, { birthYear: 1991, deathYear: 2020 })).toBe(true);
    expect(compatibleYears({ birthYear: 1990, deathYear: null }, { birthYear: 1992, deathYear: null })).toBe(false);
    expect(compatibleYears({ birthYear: null, deathYear: 2000 }, { birthYear: null, deathYear: 2002 })).toBe(false);
  });
});
