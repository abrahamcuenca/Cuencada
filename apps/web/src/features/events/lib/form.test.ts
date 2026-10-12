import { describe, expect, it } from "vitest";
import { asOrganizer, makeDetail } from "../testing/fixtures";
import { initialFormValues, previewYear, toCreateRequest, toUpdateRequest, yearOptions } from "./form";

const now = new Date("2026-10-11T12:00:00.000Z");

describe("toCreateRequest", () => {
  it("sends an undated event with its year and never a slug for members", () => {
    const values = { ...initialFormValues(undefined, now), title: "Carne asada", summary: "  ", slug: "intento" };
    const result = toCreateRequest(values, false);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request).toEqual({
      title: "Carne asada",
      summary: null,
      details: null,
      startsAt: null,
      endsAt: null,
      year: 2026,
      timezone: "America/Merida",
      locationText: null,
      visibility: "members",
      publish: true
    });
    expect("slug" in result.request).toBe(false);
  });

  it("sends both dates as instants in Mérida time, without a year", () => {
    const values = { ...initialFormValues(undefined, now), title: "Posada", dated: true, startsAt: "2026-12-20T18:00", endsAt: "2026-12-20T23:00" };
    const result = toCreateRequest(values, false);
    expect(result.ok && result.request).toMatchObject({ startsAt: "2026-12-20T18:00:00-06:00", endsAt: "2026-12-20T23:00:00-06:00" });
    expect(result.ok && "year" in result.request).toBe(false);
  });

  it("asks for both dates and refuses an end before the start", () => {
    const missing = toCreateRequest({ ...initialFormValues(undefined, now), title: "Posada", dated: true, startsAt: "2026-12-20T18:00" }, false);
    expect(missing).toEqual({ ok: false, errors: { endsAt: "Escribe la fecha y hora de fin." } });
    const reversed = toCreateRequest({ ...initialFormValues(undefined, now), title: "Posada", dated: true, startsAt: "2026-12-20T18:00", endsAt: "2026-12-20T10:00" }, false);
    expect(reversed.ok).toBe(false);
    if (!reversed.ok) expect(reversed.errors.endsAt).toBe("La fecha de fin debe ser posterior al inicio.");
  });

  it("requires a title", () => {
    const result = toCreateRequest(initialFormValues(undefined, now), false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.title).toBeDefined();
  });

  it("lets admins type a slug", () => {
    const result = toCreateRequest({ ...initialFormValues(undefined, now), title: "Posada", slug: "posada-familiar" }, true);
    expect(result.ok && result.request).toMatchObject({ slug: "posada-familiar" });
  });
});

describe("toUpdateRequest", () => {
  const event = asOrganizer(makeDetail());

  it("returns null when nothing changed", () => {
    expect(toUpdateRequest(initialFormValues(event), event, false)).toBeNull();
  });

  it("sends only the changed fields, and status for the publish switch", () => {
    const result = toUpdateRequest({ ...initialFormValues(event), title: "Paseo largo", published: false }, event, false);
    expect(result).toEqual({ ok: true, request: { title: "Paseo largo", status: "draft" } });
  });

  it("clears both dates and sends the year when the event goes back to Por anunciar", () => {
    const result = toUpdateRequest({ ...initialFormValues(event), dated: false, year: "2027" }, event, false);
    expect(result).toEqual({ ok: true, request: { startsAt: null, endsAt: null, year: 2027 } });
  });

  it("never sends a slug for members, and does for admins", () => {
    expect(toUpdateRequest({ ...initialFormValues(event), slug: "otra" }, event, false)).toBeNull();
    expect(toUpdateRequest({ ...initialFormValues(event), slug: "otra-direccion" }, event, true)).toEqual({ ok: true, request: { slug: "otra-direccion" } });
  });

  it("leaves a hidden event's status alone", () => {
    const hidden = { ...event, status: "hidden" as const };
    expect(toUpdateRequest({ ...initialFormValues(hidden), published: true }, hidden, true)).toBeNull();
  });
});

describe("previewYear and yearOptions", () => {
  it("uses the start date's year in Mérida when dated", () => {
    expect(previewYear({ ...initialFormValues(undefined, now), dated: true, startsAt: "2027-01-01T00:30", year: "2026" })).toBe(2027);
    expect(previewYear({ ...initialFormValues(undefined, now), year: "2028" })).toBe(2028);
  });

  it("offers this year and the next three, plus the edited event's year", () => {
    expect(yearOptions(now)).toEqual([2026, 2027, 2028, 2029]);
    expect(yearOptions(now, 2024)).toEqual([2024, 2026, 2027, 2028, 2029]);
  });
});
