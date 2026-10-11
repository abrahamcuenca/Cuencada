import { describe, expect, it } from "vitest";
import { fixtureId, makeSummary } from "../cuencadas/testing/fixtures";
import { galleryYearsFrom } from "./api";

describe("galleryYearsFrom", () => {
  const now = Date.parse("2026-10-07T12:00:00Z");
  const announced2027 = makeSummary({ id: fixtureId(2027), year: 2027, status: "announced", startsAt: null, endsAt: null, city: null, state: null });

  it("never defaults to an announced edition without dates; it has not started", () => {
    const result = galleryYearsFrom([announced2027, makeSummary()], now);
    expect(result).toEqual({ years: [2027, 2026], defaultYear: 2026 });
  });

  it("still prefers an edition with media, and falls back to the newest year when none started", () => {
    expect(galleryYearsFrom([announced2027, makeSummary({ hasMedia: true })], now).defaultYear).toBe(2026);
    expect(galleryYearsFrom([announced2027], now)).toEqual({ years: [2027], defaultYear: 2027 });
  });

  it("lists every published year, with or without media, newest first, and defaults to an undated past one that has started", () => {
    const past2019 = makeSummary({ id: fixtureId(2019), year: 2019, status: "past", startsAt: null, endsAt: null, city: null, state: null, isHistorical: true });
    const future = makeSummary({ id: fixtureId(2027), year: 2027, status: "upcoming", startsAt: "2027-09-12T06:00:00Z", endsAt: "2027-09-18T06:00:00Z" });
    expect(galleryYearsFrom([past2019, announced2027], now)).toEqual({ years: [2027, 2019], defaultYear: 2019 });
    expect(galleryYearsFrom([future, past2019], now)).toEqual({ years: [2027, 2019], defaultYear: 2019 });
  });
});
