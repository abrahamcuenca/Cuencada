import type { CuencadaHome, CuencadaSummary } from "@cuencada/types";
import { describe, expect, it } from "vitest";
import { makePublicCuencada, makeSummary } from "../testing/fixtures";
import { programaYear } from "./programa";

const past = makeSummary({ year: 2026 });

/** A home answer with any mode string, including ones this build doesn't know (WP-3.1a `announced`). */
function home(mode: string, featuredYear: number | null, latestPast: CuencadaSummary | null = past): Pick<CuencadaHome, "mode" | "featured" | "latestPast"> {
  return {
    mode: mode as CuencadaHome["mode"], // the point of the test: a mode outside the current union
    featured: featuredYear === null ? null : makePublicCuencada({ year: featuredYear }),
    latestPast
  };
}

describe("programaYear", () => {
  it.each(["upcoming", "active"])("uses the featured edition in %s mode", (mode) => {
    expect(programaYear(home(mode, 2027))).toBe(2027);
  });

  it("uses the latest past edition in memories mode", () => {
    expect(programaYear(home("memories", null))).toBe(2026);
  });

  it.each(["announced", "algo-nuevo"])("treats the %s mode as undated and falls back to the latest past edition", (mode) => {
    expect(programaYear(home(mode, 2027))).toBe(2026);
  });

  it("returns null when an undated featured edition has no past edition to fall back to", () => {
    expect(programaYear(home("announced", 2027, null))).toBeNull();
  });

  it("falls back to the latest past edition when a dated mode has no featured edition", () => {
    expect(programaYear(home("upcoming", null))).toBe(2026);
  });

  it("returns null while the home query has not answered", () => {
    expect(programaYear(undefined)).toBeNull();
  });
});
