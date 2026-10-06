/**
 * Pure helpers for the RSVP card form: draft ↔ request mapping, the allowed
 * date window and Spanish validation on top of the contract schema.
 */
import {
  type MyRsvp,
  RSVP_MAX_GUESTS,
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

/** Days before the start and after the end that arrival/departure may fall on. */
export const DATE_WINDOW_PADDING_DAYS = 7;

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

/** Adds whole days to a calendar date (no timezone involved). */
function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + days));
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

/**
 * The dates arrival/departure may take: the edition's days, as seen in its
 * timezone, padded by {@link DATE_WINDOW_PADDING_DAYS} on each side.
 *
 * @param startsAt - Edition start (ISO instant).
 * @param endsAt - Edition end (ISO instant).
 * @param timeZone - The edition's IANA timezone.
 * @returns Inclusive bounds for `<input type="date">`.
 */
export function editionDateWindow(startsAt: string, endsAt: string, timeZone: string): DateWindow {
  return {
    min: addDays(zonedDate(startsAt, timeZone), -DATE_WINDOW_PADDING_DAYS),
    max: addDays(zonedDate(endsAt, timeZone), DATE_WINDOW_PADDING_DAYS)
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
