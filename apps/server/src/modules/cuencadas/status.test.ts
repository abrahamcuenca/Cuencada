import { describe, expect, it } from "vitest";
import { computeCuencadaStatus, localDateInZone, selectHome, type StatusInput } from "./status.js";

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

describe("selectHome", () => {
  const edition = (
    name: string,
    status: "upcoming" | "active" | "past" | "draft",
    startsAt: string,
    endsAt: string
  ): { name: string; status: typeof status; startsAt: Date; endsAt: Date } => ({
    name,
    status,
    startsAt: new Date(startsAt),
    endsAt: new Date(endsAt)
  });

  const past2024 = edition("2024", "past", "2024-09-10T00:00:00Z", "2024-09-15T00:00:00Z");
  const past2025 = edition("2025", "past", "2025-09-10T00:00:00Z", "2025-09-15T00:00:00Z");
  const upcoming2026 = edition("2026", "upcoming", "2026-09-13T00:00:00Z", "2026-09-18T00:00:00Z");
  const upcoming2027 = edition("2027", "upcoming", "2027-09-13T00:00:00Z", "2027-09-18T00:00:00Z");
  const active2026 = edition("2026", "active", "2026-09-13T00:00:00Z", "2026-09-18T00:00:00Z");

  it("features the active edition over upcoming ones", () => {
    const result = selectHome([upcoming2027, active2026, past2025]);
    expect(result.mode).toBe("active");
    expect(result.featured?.name).toBe("2026");
    expect(result.latestPast?.name).toBe("2025");
  });

  it("features the soonest upcoming edition when none is active", () => {
    const result = selectHome([upcoming2027, upcoming2026, past2024, past2025]);
    expect(result.mode).toBe("upcoming");
    expect(result.featured?.name).toBe("2026");
    expect(result.latestPast?.name).toBe("2025");
  });

  it("falls back to memories mode with the most recently ended past edition", () => {
    const result = selectHome([past2024, past2025]);
    expect(result).toEqual({ mode: "memories", featured: null, latestPast: past2025 });
  });

  it("ignores drafts and handles an empty list", () => {
    const draft = edition("2028", "draft", "2028-09-13T00:00:00Z", "2028-09-18T00:00:00Z");
    expect(selectHome([draft])).toEqual({ mode: "memories", featured: null, latestPast: null });
    expect(selectHome([])).toEqual({ mode: "memories", featured: null, latestPast: null });
  });
});
