import { describe, expect, it } from "vitest";
import { computeCountdown, formatDate, formatTime, toZonedParts } from "./dates";

const MERIDA = "America/Merida";

/** Intl uses narrow no-break spaces in times; normalise for readable assertions. */
function plain(value: string): string {
  return value.replace(/[  ]/g, " ");
}

describe("formatDate", () => {
  it("formats a calendar date in Spanish without shifting the day", () => {
    expect(formatDate("2026-09-13", MERIDA)).toBe("13 de septiembre de 2026");
    // Even in a timezone far west of UTC the calendar day must not move.
    expect(formatDate("2026-09-13", "Pacific/Honolulu")).toBe("13 de septiembre de 2026");
  });

  it("converts an instant to the Cuencada's timezone before formatting", () => {
    // 03:00 UTC on the 14th is still the evening of the 13th in Mérida (UTC-6).
    expect(formatDate("2026-09-14T03:00:00Z", MERIDA)).toBe("13 de septiembre de 2026");
    expect(formatDate(new Date("2026-09-14T03:00:00Z"), "UTC")).toBe("14 de septiembre de 2026");
  });

  it("accepts custom Intl options such as a weekday", () => {
    expect(formatDate("2026-09-13", MERIDA, { weekday: "long", day: "numeric", month: "long" })).toBe(
      "domingo, 13 de septiembre"
    );
  });

  it("throws RangeError for an invalid date", () => {
    expect(() => formatDate("2026-02-30", MERIDA)).toThrow(RangeError);
    expect(() => formatDate("no es fecha", MERIDA)).toThrow(RangeError);
  });
});

describe("formatTime", () => {
  it("formats an instant as 12-hour Spanish time in the given timezone", () => {
    expect(plain(formatTime("2026-09-13T18:30:00Z", MERIDA))).toBe("12:30 p.m.");
  });

  it("formats a wall-clock HH:MM string without timezone conversion", () => {
    expect(plain(formatTime("09:05", MERIDA))).toBe("9:05 a.m.");
    expect(plain(formatTime("00:00", "Asia/Tokyo"))).toBe("12:00 a.m.");
  });

  it("throws RangeError for an unparseable value", () => {
    expect(() => formatTime("25:99", MERIDA)).toThrow(RangeError);
  });
});

describe("toZonedParts", () => {
  it("returns the calendar fields of an instant as seen in the timezone", () => {
    expect(toZonedParts("2026-09-14T03:15:30Z", MERIDA)).toEqual({
      year: 2026,
      month: 9,
      day: 13,
      hour: 21,
      minute: 15,
      second: 30,
      weekday: 0
    });
  });

  it("reports midnight as hour 0, not 24", () => {
    expect(toZonedParts("2026-09-13T06:00:00Z", MERIDA).hour).toBe(0);
  });

  it("throws RangeError for an unknown timezone", () => {
    expect(() => toZonedParts("2026-09-13T06:00:00Z", "Mars/Olympus")).toThrow(RangeError);
  });
});

describe("computeCountdown", () => {
  it("splits the remaining time into days, hours, minutes and seconds", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    const target = new Date(now.getTime() + ((12 * 24 + 5) * 3600 + 7 * 60 + 9) * 1000);
    expect(computeCountdown(target, now)).toEqual({
      days: 12,
      hours: 5,
      minutes: 7,
      seconds: 9,
      totalMs: target.getTime() - now.getTime(),
      isPast: false
    });
  });

  it("clamps to zero and flags isPast once the target is reached", () => {
    expect(computeCountdown("2026-09-13T06:00:00Z", "2026-09-13T06:00:00Z")).toMatchObject({ totalMs: 0, isPast: true });
    expect(computeCountdown("2026-09-13T06:00:00Z", "2026-09-20T06:00:00Z")).toEqual({
      days: 0,
      hours: 0,
      minutes: 0,
      seconds: 0,
      totalMs: 0,
      isPast: true
    });
  });

  it("is not past one millisecond before the target", () => {
    const result = computeCountdown("2026-09-13T06:00:00.001Z", "2026-09-13T06:00:00.000Z");
    expect(result.isPast).toBe(false);
    expect(result.seconds).toBe(0);
  });
});
