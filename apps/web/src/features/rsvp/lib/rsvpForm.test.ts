import { RSVP_DATE_WINDOW_DAYS } from "@cuencada/types";
import { describe, expect, it } from "vitest";
import type { LocationItem } from "@cuencada/types";
import {
  clampGuests,
  draftFromRsvp,
  editionDateWindow,
  hotelChoices,
  isDeadlineDayOver,
  isPastDeadline,
  optimisticRsvp,
  type RsvpDraft,
  SAVED_HOTEL_LABEL,
  validateRsvpDraft
} from "./rsvpForm";

const WINDOW = { min: "2027-07-03", max: "2027-07-22" };
const HOTELS = ["00000000-0000-4000-8000-000000000271"];

function draft(overrides: Partial<RsvpDraft> = {}): RsvpDraft {
  return { ...draftFromRsvp(null), status: "yes", ...overrides };
}

describe("editionDateWindow", () => {
  it("pads the edition days, seen in its timezone, by RSVP_DATE_WINDOW_DAYS (14) on each side", () => {
    expect(RSVP_DATE_WINDOW_DAYS).toBe(14);
    // 06:00Z on Jul 10 is midnight in Mérida; 05:59Z on Jul 16 is still Jul 15 there.
    expect(editionDateWindow("2027-07-10T06:00:00Z", "2027-07-16T05:59:59Z", "America/Merida")).toEqual({
      min: "2027-06-26",
      max: "2027-07-29"
    });
  });

  it("crosses month and year boundaries", () => {
    expect(editionDateWindow("2027-01-02T06:00:00Z", "2027-12-29T06:00:00Z", "America/Merida")).toEqual({
      min: "2026-12-19",
      max: "2028-01-12"
    });
  });
});

describe("isPastDeadline", () => {
  // Stored at 09:00 on May 31 in Mérida (UTC-6): the RSVP stays open all that day there.
  const DEADLINE = "2027-05-31T15:00:00Z";

  it("is false without a deadline", () => {
    expect(isPastDeadline(null, new Date("2099-01-01T00:00:00Z"), "America/Merida")).toBe(false);
  });

  it("stays open until the end of the deadline's day in the edition's timezone", () => {
    expect(isPastDeadline(DEADLINE, new Date("2027-05-31T16:00:00Z"), "America/Merida")).toBe(false);
    // 23:59:59 on May 31 in Mérida, already June 1 in UTC.
    expect(isPastDeadline(DEADLINE, new Date("2027-06-01T05:59:59Z"), "America/Merida")).toBe(false);
  });

  it("closes at local midnight after the deadline's day", () => {
    expect(isPastDeadline(DEADLINE, new Date("2027-06-01T06:00:00Z"), "America/Merida")).toBe(true);
  });
});

describe("clampGuests", () => {
  it("keeps the count between 0 and 20", () => {
    expect(clampGuests(-1)).toBe(0);
    expect(clampGuests(0)).toBe(0);
    expect(clampGuests(20)).toBe(20);
    expect(clampGuests(21)).toBe(20);
    expect(clampGuests(Number.NaN)).toBe(0);
    expect(clampGuests(2.7)).toBe(2);
  });
});

describe("validateRsvpDraft", () => {
  it("requires a status", () => {
    expect(validateRsvpDraft(draftFromRsvp(null), WINDOW, HOTELS)).toEqual({ ok: false, errors: { status: "Elige Sí, Tal vez o No." } });
  });

  it("builds the body with nulls for empty fields", () => {
    const result = validateRsvpDraft(draft({ guestCount: 3, notes: "  " }), WINDOW, HOTELS);
    expect(result).toEqual({
      ok: true,
      body: { status: "yes", guestCount: 3, arrivalDate: null, departureDate: null, hotelLocationId: null, notes: null }
    });
  });

  it("rejects a departure before the arrival", () => {
    const result = validateRsvpDraft(draft({ arrivalDate: "2027-07-12", departureDate: "2027-07-11" }), WINDOW, HOTELS);
    expect(result).toEqual({ ok: false, errors: { departureDate: "La salida debe ser igual o posterior a la llegada." } });
  });

  it("accepts arrival and departure on the same day, at the window bounds", () => {
    expect(validateRsvpDraft(draft({ arrivalDate: "2027-07-03", departureDate: "2027-07-03" }), WINDOW, HOTELS).ok).toBe(true);
    expect(validateRsvpDraft(draft({ arrivalDate: "2027-07-22", departureDate: "2027-07-22" }), WINDOW, HOTELS).ok).toBe(true);
  });

  it("rejects dates outside the window", () => {
    const result = validateRsvpDraft(draft({ arrivalDate: "2027-07-02", departureDate: "2027-07-23" }), WINDOW, HOTELS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.arrivalDate).toMatch(/fechas de la Cuencada/);
      expect(result.errors.departureDate).toMatch(/fechas de la Cuencada/);
    }
  });

  it("rejects a hotel that is not one of the edition's hotels", () => {
    const result = validateRsvpDraft(draft({ hotelLocationId: "00000000-0000-4000-8000-000000000273" }), WINDOW, HOTELS);
    expect(result).toEqual({ ok: false, errors: { hotelLocationId: "Elige uno de los hoteles de la lista." } });
  });

  it("drops guests, dates and hotel when the answer is No", () => {
    const result = validateRsvpDraft(
      draft({ status: "no", guestCount: 4, arrivalDate: "2027-07-12", departureDate: "2027-07-01", hotelLocationId: "x", notes: "Suerte" }),
      WINDOW,
      HOTELS
    );
    expect(result).toEqual({
      ok: true,
      body: { status: "no", guestCount: 0, arrivalDate: null, departureDate: null, hotelLocationId: null, notes: "Suerte" }
    });
  });

  it("rejects notes over 500 characters", () => {
    const result = validateRsvpDraft(draft({ notes: "a".repeat(501) }), WINDOW, HOTELS);
    expect(result).toEqual({ ok: false, errors: { notes: "Máximo 500 caracteres." } });
  });
});

describe("optimisticRsvp", () => {
  it("adds the edition id and the save time", () => {
    const body = { status: "maybe", guestCount: 0, arrivalDate: null, departureDate: null, hotelLocationId: null, notes: null } as const;
    expect(optimisticRsvp(body, "id-1", new Date("2026-10-06T12:00:00Z"))).toEqual({ ...body, cuencadaId: "id-1", updatedAt: "2026-10-06T12:00:00.000Z" });
  });
});

describe("isDeadlineDayOver", () => {
  it("is open all of the deadline's local day and closed from the next one", () => {
    // 18:00Z on May 31 is noon May 31 in Mérida.
    expect(isDeadlineDayOver("2027-05-31T18:00:00Z", "2027-05-31", "America/Merida")).toBe(false);
    expect(isDeadlineDayOver("2027-05-31T18:00:00Z", "2027-06-01", "America/Merida")).toBe(true);
    expect(isDeadlineDayOver(null, "2099-01-01", "America/Merida")).toBe(false);
  });
});

describe("hotelChoices", () => {
  const hotel = (id: string, name: string, kind: LocationItem["kind"] = "hotel"): LocationItem =>
    ({ id, name, kind }) as LocationItem; // Only id/name/kind are read here.
  const A = "00000000-0000-4000-8000-000000000271";
  const B = "00000000-0000-4000-8000-000000000272";

  it("offers only hotel locations once the list has loaded, even if the saved one is gone", () => {
    expect(hotelChoices([hotel(A, "Hotel A"), hotel(B, "Salón", "venue")], B, true)).toEqual([{ id: A, name: "Hotel A" }]);
  });

  it("keeps the saved hotel as an option while the list is loading or failed", () => {
    expect(hotelChoices([], A, false)).toEqual([{ id: A, name: SAVED_HOTEL_LABEL }]);
    expect(hotelChoices([], null, false)).toEqual([]);
  });
});
