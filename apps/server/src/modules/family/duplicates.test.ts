/** WP-4.5: name normalization and matching for "Posibles duplicados" (pure). */
import { describe, expect, it } from "vitest";
import { compatibleYears, nameMatch, nameTokens } from "./duplicates.js";

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

describe("compatibleYears", () => {
  it("allows unknown years and a difference of one", () => {
    expect(compatibleYears({ birthYear: 1990, deathYear: null }, { birthYear: null, deathYear: null })).toBe(true);
    expect(compatibleYears({ birthYear: 1990, deathYear: null }, { birthYear: 1991, deathYear: 2020 })).toBe(true);
    expect(compatibleYears({ birthYear: 1990, deathYear: null }, { birthYear: 1992, deathYear: null })).toBe(false);
    expect(compatibleYears({ birthYear: null, deathYear: 2000 }, { birthYear: null, deathYear: 2002 })).toBe(false);
  });
});
