/**
 * Pure RSVP rules: when an edition accepts RSVP changes and which
 * arrival/departure dates are sensible. No I/O; `now` comes from `app.clock`.
 *
 * Status and calendar days reuse the Cuencadas module (T2) helpers, so
 * "upcoming/active/past" means exactly what the edition pages show.
 */
import { type ApiErrorDetail, CuencadaStatus, RSVP_DATE_WINDOW_DAYS, RSVP_DATES_PENDING_MESSAGE } from "@cuencada/types";
import { computeCuencadaStatus, localDateInZone } from "../cuencadas/status.js";

/** Edition fields the RSVP rules depend on. Dates are both set or both `null` (announced). */
export interface RsvpEditionInput {
  isPublished: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  timezone: string;
  rsvpDeadline: Date | null;
}

/** Why an edition does not accept RSVP changes. */
export const RsvpClosedReason = {
  Draft: "draft",
  /** Published without dates yet (status `announced`, WP-3.1a). */
  DatesPending: "dates_pending",
  Past: "past",
  DeadlinePassed: "deadline_passed"
} as const;
export type RsvpClosedReason = (typeof RsvpClosedReason)[keyof typeof RsvpClosedReason];

/** Spanish messages for the 409 answered when an RSVP cannot be changed. */
export const RSVP_CLOSED_MESSAGES: Record<RsvpClosedReason, string> = {
  draft: "Esta Cuencada todavía no acepta confirmaciones.",
  dates_pending: RSVP_DATES_PENDING_MESSAGE,
  past: "Esta Cuencada ya pasó; ya no se pueden cambiar las confirmaciones.",
  deadline_passed: "La fecha límite para confirmar asistencia ya pasó."
};

/** Result of {@link rsvpEditability}. */
export type RsvpEditability = { editable: true } | { editable: false; reason: RsvpClosedReason };

/**
 * Whether members may create or change their RSVP at `now`: the edition must
 * be published, have dates (not `announced`: there is no stay window yet,
 * whatever the deadline says) and be `upcoming` or `active` (calendar days in its timezone),
 * and, when a deadline is set, today (in the edition's timezone) must be on
 * or before the deadline's calendar day. The deadline therefore lasts until
 * local midnight at the end of that day, whatever hour was stored.
 *
 * @param edition - Publication flag, dates, timezone and deadline.
 * @param now - Current instant.
 */
export function rsvpEditability(edition: RsvpEditionInput, now: Date): RsvpEditability {
  const status = computeCuencadaStatus(edition, now);
  if (status === CuencadaStatus.Draft) return { editable: false, reason: RsvpClosedReason.Draft };
  if (status === CuencadaStatus.Announced) return { editable: false, reason: RsvpClosedReason.DatesPending };
  if (status === CuencadaStatus.Past) return { editable: false, reason: RsvpClosedReason.Past };
  if (edition.rsvpDeadline !== null) {
    const today = localDateInZone(now, edition.timezone);
    const deadlineDay = localDateInZone(edition.rsvpDeadline, edition.timezone);
    // ISO calendar dates compare correctly as strings.
    if (today > deadlineDay) return { editable: false, reason: RsvpClosedReason.DeadlinePassed };
  }
  return { editable: true };
}

/**
 * Shift an ISO calendar date by whole days (pure calendar arithmetic, no zone).
 *
 * @param isoDate - `YYYY-MM-DD`.
 * @param days - Days to add (negative to subtract).
 */
export function addDays(isoDate: string, days: number): string {
  const ms = Date.parse(`${isoDate}T00:00:00Z`) + days * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** The allowed arrival/departure range for an edition (inclusive). */
export interface RsvpDateWindow {
  earliest: string;
  latest: string;
}

/**
 * Allowed stay window: `RSVP_DATE_WINDOW_DAYS` before the first day through
 * the same number of days after the last day, in the edition's timezone.
 *
 * Dated editions only: the caller checks {@link rsvpEditability} first, which
 * refuses an `announced` (undated) edition.
 *
 * @param edition - Dates and timezone.
 */
export function rsvpDateWindow(edition: { startsAt: Date; endsAt: Date; timezone: string }): RsvpDateWindow {
  return {
    earliest: addDays(localDateInZone(edition.startsAt, edition.timezone), -RSVP_DATE_WINDOW_DAYS),
    latest: addDays(localDateInZone(edition.endsAt, edition.timezone), RSVP_DATE_WINDOW_DAYS)
  };
}

/**
 * Validation problems for arrival/departure against the edition window.
 * (The schema already rejects `departure < arrival`.)
 *
 * @param dates - Parsed input dates (`null` = not given).
 * @param window - From {@link rsvpDateWindow}.
 * @returns Field details for a 400 `VALIDATION`; empty when valid.
 */
export function rsvpDateProblems(
  dates: { arrivalDate: string | null; departureDate: string | null },
  window: RsvpDateWindow
): ApiErrorDetail[] {
  const problems: ApiErrorDetail[] = [];
  const message = `Elige una fecha entre ${window.earliest} y ${window.latest}.`;
  for (const field of ["arrivalDate", "departureDate"] as const) {
    const value = dates[field];
    if (value !== null && (value < window.earliest || value > window.latest)) {
      problems.push({ path: field, message });
    }
  }
  return problems;
}
