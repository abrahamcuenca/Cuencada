import { describe, expect, it } from "vitest";
import { makeItinerary } from "../testing/fixtures";
import {
  formatDateRange,
  formatKicker,
  formatTimeRange,
  groupItineraryByDay,
  messageForToday,
  safeAssetUrl,
  safeHttpsUrl,
  todayInTimezone
} from "./format";

const MERIDA = "America/Merida";

function plain(value: string | null): string | null {
  return value === null ? null : value.replace(/[\u00a0\u202f]/g, " ");
}

describe("formatDateRange", () => {
  it("formats a range inside one month in the Cuencada's timezone", () => {
    // The end instant is already Sep 19 in UTC.
    expect(formatDateRange("2026-09-13T06:00:00Z", "2026-09-19T05:59:59Z", MERIDA)).toBe("13—18 de septiembre de 2026");
  });

  it("names both months when the range crosses a month", () => {
    expect(formatDateRange("2027-08-30T18:00:00Z", "2027-09-02T18:00:00Z", MERIDA)).toBe("30 de agosto — 2 de septiembre de 2027");
  });

  it("names both years when the range crosses a year", () => {
    expect(formatDateRange("2027-12-30T18:00:00Z", "2028-01-02T18:00:00Z", MERIDA)).toBe("30 de diciembre de 2027 — 2 de enero de 2028");
  });

  it("shows a single day once", () => {
    expect(formatDateRange("2027-07-10T15:00:00Z", "2027-07-10T23:00:00Z", MERIDA)).toBe("10 de julio de 2027");
  });
});

describe("formatKicker", () => {
  it("joins city, state and dates", () => {
    expect(formatKicker({ city: "Mérida", state: "Yucatán", startsAt: "2026-09-13T06:00:00Z", endsAt: "2026-09-19T05:59:59Z", timezone: MERIDA })).toBe(
      "Mérida · Yucatán · 13—18 de septiembre de 2026"
    );
  });
});

describe("todayInTimezone / messageForToday", () => {
  const now = new Date("2026-09-14T04:00:00Z"); // still Sep 13 in Mérida

  it("uses the Cuencada's calendar day, not UTC's", () => {
    expect(todayInTimezone(now, MERIDA)).toBe("2026-09-13");
    expect(todayInTimezone(now, "UTC")).toBe("2026-09-14");
  });

  it("returns the message only on its day", () => {
    const message = { id: "m", date: "2026-09-13", message: "Hola" };
    expect(messageForToday(message, now, MERIDA)).toBe(message);
    expect(messageForToday(message, now, "UTC")).toBeNull();
    expect(messageForToday(null, now, MERIDA)).toBeNull();
  });
});

describe("formatTimeRange", () => {
  it("formats start and end wall-clock times", () => {
    expect(plain(formatTimeRange({ startTime: "07:40", endTime: "18:00" }, MERIDA))).toBe("7:40 a.m. – 6:00 p.m.");
  });

  it("formats a start without end, and null for all-day items", () => {
    expect(plain(formatTimeRange({ startTime: "19:30", endTime: null }, MERIDA))).toBe("7:30 p.m.");
    expect(formatTimeRange({ startTime: null, endTime: null }, MERIDA)).toBeNull();
  });
});

describe("groupItineraryByDay", () => {
  it("groups by date in calendar order and keeps sortOrder inside a day", () => {
    const days = groupItineraryByDay([
      makeItinerary({ id: "c", date: "2026-09-15", sortOrder: 0 }),
      makeItinerary({ id: "b", date: "2026-09-14", sortOrder: 2 }),
      makeItinerary({ id: "a", date: "2026-09-14", sortOrder: 1 })
    ]);
    expect(days.map((day) => [day.date, day.items.map((item) => item.id)])).toEqual([
      ["2026-09-14", ["a", "b"]],
      ["2026-09-15", ["c"]]
    ]);
  });

  it("returns no days for an empty list", () => {
    expect(groupItineraryByDay([])).toEqual([]);
  });
});

describe("safeHttpsUrl / safeAssetUrl", () => {
  it("returns https links unchanged, including their query strings", () => {
    const link = "https://chat.whatsapp.com/Abc?s=cl&p=i&mlu=0";
    expect(safeHttpsUrl(link)).toBe(link);
  });

  it("rejects other schemes and garbage", () => {
    expect(safeHttpsUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpsUrl("http://example.com")).toBeNull();
    expect(safeHttpsUrl("no es un enlace")).toBeNull();
    expect(safeHttpsUrl(null)).toBeNull();
  });

  it("accepts site asset paths only under /images and /canciones", () => {
    expect(safeAssetUrl("/canciones/Cancion_Oficial.mp3")).toBe("/canciones/Cancion_Oficial.mp3");
    expect(safeAssetUrl("/images/../secret")).toBeNull();
    expect(safeAssetUrl("//evil.example/x.mp3")).toBeNull();
    expect(safeAssetUrl("/api/me")).toBeNull();
  });
});
