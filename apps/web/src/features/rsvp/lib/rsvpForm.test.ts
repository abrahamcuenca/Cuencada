import { describe, expect, it } from "vitest";
import { clampGuests, draftFromRsvp, editionDateWindow, optimisticRsvp, type RsvpDraft, validateRsvpDraft } from "./rsvpForm";

const WINDOW = { min: "2027-07-03", max: "2027-07-22" };
const HOTELS = ["00000000-0000-4000-8000-000000000271"];

function draft(overrides: Partial<RsvpDraft> = {}): RsvpDraft {
  return { ...draftFromRsvp(null), status: "yes", ...overrides };
}

describe("editionDateWindow", () => {
  it("pads the edition days, seen in its timezone, by a week on each side", () => {
    // 06:00Z on Jul 10 is midnight in Mérida; 05:59Z on Jul 16 is still Jul 15 there.
    expect(editionDateWindow("2027-07-10T06:00:00Z", "2027-07-16T05:59:59Z", "America/Merida")).toEqual({
      min: "2027-07-03",
      max: "2027-07-22"
    });
  });

  it("crosses month and year boundaries", () => {
    expect(editionDateWindow("2027-01-02T06:00:00Z", "2027-12-29T06:00:00Z", "America/Merida")).toEqual({
      min: "2026-12-26",
      max: "2028-01-05"
    });
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
