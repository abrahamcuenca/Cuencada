/**
 * Pure helpers for the RSVP card form: draft ↔ request mapping, the allowed
 * date window and Spanish validation on top of the contract schema.
 */
import {
  type LocationItem,
  type MyRsvp,
  RSVP_MAX_GUESTS,
  RSVP_DATE_WINDOW_DAYS,
  RSVP_NOTES_MAX_LENGTH,
  type RsvpStatus,
  type UpsertRsvpInput,
  upsertRsvpInputSchema
} from "@cuencada/types";
import { toZonedParts } from "../../../shared/lib/dates";

/** What the form edits. Text inputs hold strings; `""` means "not set". */
export interface RsvpDraft {
  status: RsvpStatus | null;
  guestCount: number;
  arrivalDate: string;
  departureDate: string;
  hotelLocationId: string;
  notes: string;
}

/** Form fields that can carry an error. */
export type RsvpField = "status" | "guestCount" | "arrivalDate" | "departureDate" | "hotelLocationId" | "notes";

/** Spanish error per field. */
export type RsvpFieldErrors = Partial<Record<RsvpField, string>>;

/** Inclusive `YYYY-MM-DD` bounds for the arrival/departure inputs. */
export interface DateWindow {
  min: string;
  max: string;
}

/** Result of {@link validateRsvpDraft}. */
export type RsvpValidation = { ok: true; body: UpsertRsvpInput } | { ok: false; errors: RsvpFieldErrors };


const RSVP_FIELDS: readonly RsvpField[] = ["status", "guestCount", "arrivalDate", "departureDate", "hotelLocationId", "notes"];

/**
 * @param rsvp - The saved RSVP, or `null` for a first answer.
 * @returns The form state that shows it.
 */
export function draftFromRsvp(rsvp: MyRsvp | null): RsvpDraft {
  return {
    status: rsvp?.status ?? null,
    guestCount: rsvp?.guestCount ?? 0,
    arrivalDate: rsvp?.arrivalDate ?? "",
    departureDate: rsvp?.departureDate ?? "",
    hotelLocationId: rsvp?.hotelLocationId ?? "",
    notes: rsvp?.notes ?? ""
  };
}

/**
 * @param value - Any number typed or stepped.
 * @returns An integer between 0 and {@link RSVP_MAX_GUESTS}.
 */
export function clampGuests(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(RSVP_MAX_GUESTS, Math.max(0, Math.trunc(value)));
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Calendar date of an instant in `timeZone`, as `YYYY-MM-DD`. */
function zonedDate(instant: string, timeZone: string): string {
  const parts = toZonedParts(instant, timeZone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

/**
 * Same rule as the server (T3-BE `rsvpEditability`): the deadline lasts until
 * the end of its calendar day in the edition's timezone, whatever hour is stored.
 *
 * @param deadline - RSVP deadline (ISO instant), or `null` for none.
 * @param now - The current instant.
 * @param timeZone - The edition's IANA timezone.
 * @returns Whether today, in that timezone, is after the deadline's day.
 */
export function isPastDeadline(deadline: string | null, now: Date, timeZone: string): boolean {
  return isDeadlineDayOver(deadline, zonedDate(now.toISOString(), timeZone), timeZone);
}

/**
 * {@link isPastDeadline} for a known local date (e.g. from `useZonedToday`,
 * which re-renders at local midnight so the card locks without a reload).
 *
 * @param deadline - RSVP deadline (ISO instant), or `null` for none.
 * @param today - Today's date (`YYYY-MM-DD`) in `timeZone`.
 * @param timeZone - The edition's IANA timezone.
 * @returns Whether `today` is after the deadline's day.
 */
export function isDeadlineDayOver(deadline: string | null, today: string, timeZone: string): boolean {
  if (deadline === null) return false;
  return today > zonedDate(deadline, timeZone);
}

/** A hotel the RSVP form can offer. */
export type HotelChoice = Pick<LocationItem, "id" | "name">;

/** Label of the saved hotel while the hotel list can't be loaded. */
export const SAVED_HOTEL_LABEL = "El hotel que ya elegiste";

/**
 * The hotels to offer. While the edition's hotel list is loading or failed,
 * the saved answer's hotel stays an option (and valid), so re-saving an RSVP
 * never fails with "Elige uno de los hoteles de la lista." just because the
 * list isn't here. Once the list is loaded it is the only source of truth.
 *
 * @param hotels - The edition's `hotel` locations (empty while unknown).
 * @param savedHotelId - `hotelLocationId` of the saved RSVP, or `null`.
 * @param listLoaded - Whether the hotel list (members details) has loaded.
 * @returns The options, the saved hotel last.
 */
export function hotelChoices(hotels: readonly LocationItem[], savedHotelId: string | null, listLoaded: boolean): HotelChoice[] {
  const choices: HotelChoice[] = hotels.filter((location) => location.kind === "hotel").map(({ id, name }) => ({ id, name }));
  if (!listLoaded && savedHotelId !== null && !choices.some((choice) => choice.id === savedHotelId)) {
    choices.push({ id: savedHotelId, name: SAVED_HOTEL_LABEL });
  }
  return choices;
}

/** Adds whole days to a calendar date (no timezone involved). */
function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + days));
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

/**
 * The dates arrival/departure may take: the edition's days, as seen in its
 * timezone, padded by `RSVP_DATE_WINDOW_DAYS` (contract, same rule as the server) on each side.
 *
 * @param startsAt - Edition start (ISO instant).
 * @param endsAt - Edition end (ISO instant).
 * @param timeZone - The edition's IANA timezone.
 * @returns Inclusive bounds for `<input type="date">`.
 */
export function editionDateWindow(startsAt: string, endsAt: string, timeZone: string): DateWindow {
  return {
    min: addDays(zonedDate(startsAt, timeZone), -RSVP_DATE_WINDOW_DAYS),
    max: addDays(zonedDate(endsAt, timeZone), RSVP_DATE_WINDOW_DAYS)
  };
}

function isRsvpField(value: unknown): value is RsvpField {
  return typeof value === "string" && (RSVP_FIELDS as readonly string[]).includes(value);
}

/**
 * Validates the draft and builds the `PUT` body.
 *
 * Runs Spanish pre-checks the schema can't express (date window, hotel list),
 * then the contract `upsertRsvpInputSchema` (bounds, departure ≥ arrival).
 * A "No" answer drops guests, dates and hotel.
 *
 * @param draft - Current form state.
 * @param window - Allowed date range.
 * @param hotelIds - Ids of the edition's `hotel` locations.
 * @returns The parsed body, or an error per field.
 */
export function validateRsvpDraft(draft: RsvpDraft, window: DateWindow, hotelIds: readonly string[]): RsvpValidation {
  const errors: RsvpFieldErrors = {};
  if (draft.status === null) {
    return { ok: false, errors: { status: "Elige Sí, Tal vez o No." } };
  }
  const attending = draft.status !== "no";
  const arrivalDate = attending && draft.arrivalDate !== "" ? draft.arrivalDate : null;
  const departureDate = attending && draft.departureDate !== "" ? draft.departureDate : null;
  const hotelLocationId = attending && draft.hotelLocationId !== "" ? draft.hotelLocationId : null;

  for (const [field, value] of [
    ["arrivalDate", arrivalDate],
    ["departureDate", departureDate]
  ] as const) {
    if (value !== null && (value < window.min || value > window.max)) {
      errors[field] = "Elige una fecha cercana a las fechas de la Cuencada.";
    }
  }
  if (hotelLocationId !== null && !hotelIds.includes(hotelLocationId)) {
    errors.hotelLocationId = "Elige uno de los hoteles de la lista.";
  }
  if (draft.notes.length > RSVP_NOTES_MAX_LENGTH) {
    errors.notes = `Máximo ${RSVP_NOTES_MAX_LENGTH} caracteres.`;
  }

  const parsed = upsertRsvpInputSchema.safeParse({
    status: draft.status,
    guestCount: attending ? draft.guestCount : 0,
    arrivalDate,
    departureDate,
    hotelLocationId,
    notes: draft.notes
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (isRsvpField(field) && errors[field] === undefined) errors[field] = issue.message;
    }
  }
  if (Object.keys(errors).length > 0 || !parsed.success) return { ok: false, errors };
  return { ok: true, body: parsed.data };
}

/**
 * @param body - The validated body being sent.
 * @param cuencadaId - The edition's id.
 * @param now - When the save started.
 * @returns The `MyRsvp` to show optimistically while the `PUT` is in flight.
 */
export function optimisticRsvp(body: UpsertRsvpInput, cuencadaId: string, now: Date): MyRsvp {
  return { cuencadaId, ...body, updatedAt: now.toISOString() };
}
