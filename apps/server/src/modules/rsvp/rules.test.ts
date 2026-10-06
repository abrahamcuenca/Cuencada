import { describe, expect, it } from "vitest";
import { addDays, rsvpDateProblems, rsvpDateWindow, rsvpEditability } from "./rules.js";

const edition = {
  isPublished: true,
  startsAt: new Date("2026-09-13T00:00:00-06:00"),
  endsAt: new Date("2026-09-18T23:59:59-06:00"),
  timezone: "America/Merida",
  rsvpDeadline: new Date("2026-09-10T09:00:00-06:00")
};

describe("rsvpEditability", () => {
  it("allows changes before the deadline while upcoming", () => {
    expect(rsvpEditability(edition, new Date("2026-09-01T12:00:00Z"))).toEqual({
      editable: true
    });
  });

  it("keeps the deadline open until local midnight at the end of the deadline day", () => {
    // 23:59:59 on 10 Sep in Mérida (UTC-6), hours after the stored 09:00 deadline.
    expect(rsvpEditability(edition, new Date("2026-09-11T05:59:59Z")).editable).toBe(true);
    expect(rsvpEditability(edition, new Date("2026-09-11T06:00:00Z"))).toEqual({
      editable: false,
      reason: "deadline_passed"
    });
  });

  it("uses the edition timezone, not UTC, for the deadline day", () => {
    const tokyo = {
      ...edition,
      timezone: "Asia/Tokyo",
      rsvpDeadline: new Date("2026-09-10T09:00:00+09:00")
    };
    // 23:59 on 10 Sep in Tokyo is 14:59Z, still the 10th in UTC as well; 00:00 on the 11th is 15:00Z on the 10th UTC.
    expect(rsvpEditability(tokyo, new Date("2026-09-10T14:59:59Z")).editable).toBe(true);
    expect(rsvpEditability(tokyo, new Date("2026-09-10T15:00:00Z")).editable).toBe(false);
  });

  it("allows changes while the edition is active when there is no deadline", () => {
    const open = { ...edition, rsvpDeadline: null };
    expect(rsvpEditability(open, new Date("2026-09-15T12:00:00Z")).editable).toBe(true);
  });

  it("closes past editions and drafts", () => {
    const open = { ...edition, rsvpDeadline: null };
    expect(rsvpEditability(open, new Date("2026-09-19T06:00:00Z"))).toEqual({
      editable: false,
      reason: "past"
    });
    expect(rsvpEditability({ ...open, isPublished: false }, new Date("2026-09-01T12:00:00Z"))).toEqual({
      editable: false,
      reason: "draft"
    });
  });
});

describe("rsvpDateWindow", () => {
  it("spans 14 local days before the first day through 14 after the last", () => {
    expect(rsvpDateWindow(edition)).toEqual({
      earliest: "2026-08-30",
      latest: "2026-10-02"
    });
  });
});

describe("rsvpDateProblems", () => {
  const window = { earliest: "2026-08-30", latest: "2026-10-02" };

  it("accepts null dates and dates on the window edges", () => {
    expect(rsvpDateProblems({ arrivalDate: null, departureDate: null }, window)).toEqual([]);
    expect(rsvpDateProblems({ arrivalDate: "2026-08-30", departureDate: "2026-10-02" }, window)).toEqual([]);
  });

  it("flags each date outside the window by field", () => {
    const problems = rsvpDateProblems({ arrivalDate: "2026-08-29", departureDate: "2026-10-03" }, window);
    expect(problems.map((problem) => problem.path)).toEqual(["arrivalDate", "departureDate"]);
  });
});

describe("addDays", () => {
  it("crosses month and year boundaries", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});
