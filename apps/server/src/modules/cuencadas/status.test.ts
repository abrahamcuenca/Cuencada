import { describe, expect, it } from "vitest";
import { computeCuencadaStatus, localDateInZone, localYearInZone, selectHome, type StatusInput } from "./status.js";

const edition: StatusInput = {
  isPublished: true,
  // Mérida is UTC-6 all year (no DST since 2015).
  startsAt: new Date("2026-09-13T19:30:00-06:00"),
  endsAt: new Date("2026-09-18T12:00:00-06:00"),
  timezone: "America/Merida"
};

const at = (iso: string): Date => new Date(iso);

describe("localDateInZone", () => {
  it("returns the local calendar day, not the UTC one", () => {
    expect(localDateInZone(at("2026-09-13T05:30:00Z"), "America/Merida")).toBe("2026-09-12");
    expect(localDateInZone(at("2026-09-13T05:30:00Z"), "UTC")).toBe("2026-09-13");
  });

  it("handles zones ahead of UTC", () => {
    expect(localDateInZone(at("2026-09-12T23:30:00Z"), "Asia/Tokyo")).toBe("2026-09-13");
  });

  it("follows DST transitions", () => {
    // 2026-03-08 02:00 local: New York springs forward to UTC-4.
    expect(localDateInZone(at("2026-03-09T03:59:00Z"), "America/New_York")).toBe("2026-03-08");
    expect(localDateInZone(at("2026-03-09T04:00:00Z"), "America/New_York")).toBe("2026-03-09");
  });
});

describe("computeCuencadaStatus", () => {
  it("returns draft when unpublished, whatever the date", () => {
    expect(computeCuencadaStatus({ ...edition, isPublished: false }, at("2026-09-15T12:00:00Z"))).toBe("draft");
    expect(computeCuencadaStatus({ ...edition, isPublished: false }, at("2030-01-01T00:00:00Z"))).toBe("draft");
  });

  it("returns upcoming until the last minute of the day before the start day (local)", () => {
    expect(computeCuencadaStatus(edition, at("2026-01-01T00:00:00Z"))).toBe("upcoming");
    // 2026-09-12 23:59:59 in Mérida = 2026-09-13T05:59:59Z (already the 13th in UTC).
    expect(computeCuencadaStatus(edition, at("2026-09-13T05:59:59Z"))).toBe("upcoming");
  });

  it("returns active from local midnight of the start day, even before startsAt's hour", () => {
    expect(computeCuencadaStatus(edition, at("2026-09-13T06:00:00Z"))).toBe("active");
    expect(computeCuencadaStatus(edition, at("2026-09-13T12:00:00-06:00"))).toBe("active");
  });

  it("stays active through the whole local end day, even after endsAt's hour", () => {
    expect(computeCuencadaStatus(edition, at("2026-09-18T23:59:59-06:00"))).toBe("active");
  });

  it("returns past from local midnight after the end day", () => {
    // 2026-09-19 00:00 in Mérida = 06:00Z; at 05:59Z the UTC date is already the 19th but it is still the 18th locally.
    expect(computeCuencadaStatus(edition, at("2026-09-19T05:59:59Z"))).toBe("active");
    expect(computeCuencadaStatus(edition, at("2026-09-19T06:00:00Z"))).toBe("past");
    expect(computeCuencadaStatus(edition, at("2027-01-01T00:00:00Z"))).toBe("past");
  });

  it("treats a one-day edition as active only on that local day", () => {
    const oneDay: StatusInput = {
      isPublished: true,
      startsAt: new Date("2026-05-10T10:00:00+09:00"),
      endsAt: new Date("2026-05-10T18:00:00+09:00"),
      timezone: "Asia/Tokyo"
    };
    expect(computeCuencadaStatus(oneDay, at("2026-05-09T14:59:59Z"))).toBe("upcoming");
    expect(computeCuencadaStatus(oneDay, at("2026-05-09T15:00:00Z"))).toBe("active");
    expect(computeCuencadaStatus(oneDay, at("2026-05-10T14:59:59Z"))).toBe("active");
    expect(computeCuencadaStatus(oneDay, at("2026-05-10T15:00:00Z"))).toBe("past");
  });
});

describe("computeCuencadaStatus without dates", () => {
  const undated: StatusInput = { isPublished: true, startsAt: null, endsAt: null, timezone: "America/Merida" };

  it("returns announced for a published edition without dates, at any instant", () => {
    expect(computeCuencadaStatus(undated, at("2026-10-07T12:00:00Z"))).toBe("announced");
    expect(computeCuencadaStatus(undated, at("2030-01-01T00:00:00Z"))).toBe("announced");
  });

  it("returns draft for an unpublished edition without dates", () => {
    expect(computeCuencadaStatus({ ...undated, isPublished: false }, at("2026-10-07T12:00:00Z"))).toBe("draft");
  });

  it("treats a single missing date as announced instead of throwing (the DB forbids it)", () => {
    expect(computeCuencadaStatus({ ...edition, endsAt: null }, at("2026-10-07T12:00:00Z"))).toBe("announced");
  });
});

describe("localYearInZone", () => {
  it("uses the year in the zone, not in UTC, around New Year", () => {
    // 2027-01-01T03:00Z is still 31 Dec 2026, 21:00 in Mérida (UTC-6).
    expect(localYearInZone(at("2027-01-01T03:00:00Z"), "America/Merida")).toBe(2026);
    expect(localYearInZone(at("2027-01-01T06:00:00Z"), "America/Merida")).toBe(2027);
    // Tokyo is already in 2027 at 2026-12-31T15:00Z.
    expect(localYearInZone(at("2026-12-31T15:00:00Z"), "Asia/Tokyo")).toBe(2027);
  });
});

describe("selectHome", () => {
  type Status = "upcoming" | "active" | "past" | "draft" | "announced";
  interface Candidate {
    name: string;
    status: Status;
    year: number;
    timezone: string;
    startsAt: Date | null;
    endsAt: Date | null;
  }
  const edition = (name: string, status: Status, startsAt: string, endsAt: string): Candidate => ({
    name,
    status,
    year: Number(name),
    timezone: "America/Merida",
    startsAt: new Date(startsAt),
    endsAt: new Date(endsAt)
  });
  const announcedEdition = (year: number, timezone = "America/Merida"): Candidate => ({
    name: `${year} anunciada`,
    status: "announced",
    year,
    timezone,
    startsAt: null,
    endsAt: null
  });

  const now = at("2026-10-07T12:00:00Z");
  const past2024 = edition("2024", "past", "2024-09-10T00:00:00Z", "2024-09-15T00:00:00Z");
  const past2025 = edition("2025", "past", "2025-09-10T00:00:00Z", "2025-09-15T00:00:00Z");
  const past2026 = edition("2026", "past", "2026-09-13T00:00:00Z", "2026-09-18T00:00:00Z");
  const upcoming2026 = edition("2026", "upcoming", "2026-09-13T00:00:00Z", "2026-09-18T00:00:00Z");
  const upcoming2027 = edition("2027", "upcoming", "2027-09-13T00:00:00Z", "2027-09-18T00:00:00Z");
  const active2026 = edition("2026", "active", "2026-09-13T00:00:00Z", "2026-09-18T00:00:00Z");

  it("features the active edition over upcoming and announced ones", () => {
    const result = selectHome([upcoming2027, active2026, past2025, announcedEdition(2028)], now);
    expect(result.mode).toBe("active");
    expect(result.featured?.name).toBe("2026");
    expect(result.latestPast?.name).toBe("2025");
  });

  it("features the soonest upcoming edition when none is active, even with an announced one", () => {
    const result = selectHome([announcedEdition(2026), upcoming2027, upcoming2026, past2024, past2025], now);
    expect(result.mode).toBe("upcoming");
    expect(result.featured?.name).toBe("2026");
    expect(result.latestPast?.name).toBe("2025");
  });

  it("features the announced edition when nothing is active or dated upcoming, keeping the previous memories", () => {
    const announced2027 = announcedEdition(2027);
    const result = selectHome([past2025, announced2027, past2026], now);
    expect(result).toEqual({ mode: "announced", featured: announced2027, latestPast: past2026 });
  });

  it("picks the lowest announced year that is this year or later", () => {
    const result = selectHome([announcedEdition(2029), announcedEdition(2027), announcedEdition(2028)], now);
    expect(result.featured?.year).toBe(2027);
  });

  it("ignores an announced edition whose year is already over", () => {
    const result = selectHome([announcedEdition(2025), past2026], now);
    expect(result).toEqual({ mode: "memories", featured: null, latestPast: past2026 });
    // A stale 2025 announcement never wins over a valid 2027 one, despite the lower year.
    expect(selectHome([announcedEdition(2025), announcedEdition(2027)], now).featured?.year).toBe(2027);
  });

  it("keeps an announced edition of the current year through 31 December in its own timezone", () => {
    const announced2026 = announcedEdition(2026);
    // 2027-01-01T05:59Z is still 31 Dec 2026 in Mérida (UTC-6).
    expect(selectHome([announced2026], at("2027-01-01T05:59:59Z")).mode).toBe("announced");
    // From local midnight it is 2027 in Mérida and the 2026 announcement is stale.
    expect(selectHome([announced2026], at("2027-01-01T06:00:00Z")).mode).toBe("memories");
  });

  it("uses each announced edition's own timezone for the year rollover", () => {
    // At 2026-12-31T15:00Z it is already 2027 in Tokyo, but still 2026 in Mérida.
    const instant = at("2026-12-31T15:00:00Z");
    expect(selectHome([announcedEdition(2026, "Asia/Tokyo")], instant).mode).toBe("memories");
    expect(selectHome([announcedEdition(2026, "America/Merida")], instant).mode).toBe("announced");
  });

  it("falls back to memories mode with the most recently ended past edition", () => {
    const result = selectHome([past2024, past2025], now);
    expect(result).toEqual({ mode: "memories", featured: null, latestPast: past2025 });
  });

  it("ignores drafts and handles an empty list", () => {
    const draft = edition("2028", "draft", "2028-09-13T00:00:00Z", "2028-09-18T00:00:00Z");
    expect(selectHome([draft], now)).toEqual({ mode: "memories", featured: null, latestPast: null });
    expect(selectHome([], now)).toEqual({ mode: "memories", featured: null, latestPast: null });
  });
});
