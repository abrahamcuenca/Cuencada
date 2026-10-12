/**
 * The create/edit form of an event (WP-5.4): form values, their mapping to
 * the contract requests, and client-side validation with the same zod
 * schemas the server uses. Dates are typed as wall-clock times in the
 * event's timezone (America/Merida for new events).
 */
import {
  type AdminCreateEventRequest,
  type AdminUpdateEventRequest,
  adminCreateEventInputSchema,
  adminUpdateEventInputSchema,
  type CreateEventRequest,
  createEventInputSchema,
  EVENT_DEFAULT_TIMEZONE,
  type EventDetail,
  type EventStatus,
  type EventVisibility,
  eventYearOf,
  type UpdateEventRequest,
  updateEventInputSchema
} from "@cuencada/types";
import { toZonedParts } from "../../../shared/lib/dates";
import { blankToNull, type FieldErrors, isoToZonedLocal, issuesToFieldErrors, zonedLocalToIso } from "../../cuencadas/admin/forms";

/** What the form holds (strings as typed). */
export interface EventFormValues {
  title: string;
  summary: string;
  details: string;
  /** Off: "Por anunciar" (only a year). On: start and end. */
  dated: boolean;
  /** `YYYY-MM-DDTHH:MM` in `timezone`. */
  startsAt: string;
  endsAt: string;
  /** Year of an undated event. */
  year: string;
  locationText: string;
  visibility: EventVisibility;
  /** Create: publish right away. Edit: published (vs. draft). */
  published: boolean;
  /** Admins only (blank: generated). */
  slug: string;
  /** Not editable in the form; new events use {@link EVENT_DEFAULT_TIMEZONE}. */
  timezone: string;
}

/** A request ready to send, or the field errors that stop it. */
export type FormResult<TRequest> = { ok: true; request: TRequest } | { ok: false; errors: FieldErrors };

/**
 * @param now - Reference instant.
 * @returns The current year in the default timezone.
 */
export function currentEventYear(now: Date = new Date()): number {
  return toZonedParts(now, EVENT_DEFAULT_TIMEZONE).year;
}

/**
 * Years offered for an undated event: this year and the next three, plus
 * the event's own year when editing.
 *
 * @param now - Reference instant.
 * @param keep - A year that must be in the list (the edited event's).
 */
export function yearOptions(now: Date = new Date(), keep?: number): number[] {
  const first = currentEventYear(now);
  const years = [first, first + 1, first + 2, first + 3];
  if (keep !== undefined && !years.includes(keep)) years.push(keep);
  return years.sort((a, b) => a - b);
}

/**
 * @param event - The event being edited, or `undefined` for a new one.
 * @param now - Reference instant (default year of a new event).
 */
export function initialFormValues(event?: EventDetail, now: Date = new Date()): EventFormValues {
  if (event === undefined) {
    return {
      title: "",
      summary: "",
      details: "",
      dated: false,
      startsAt: "",
      endsAt: "",
      year: String(currentEventYear(now)),
      locationText: "",
      visibility: "members",
      published: true,
      slug: "",
      timezone: EVENT_DEFAULT_TIMEZONE
    };
  }
  const dated = event.startsAt !== null && event.endsAt !== null;
  return {
    title: event.title,
    summary: event.summary ?? "",
    details: event.details ?? "",
    dated,
    startsAt: event.startsAt === null ? "" : isoToZonedLocal(event.startsAt, event.timezone),
    endsAt: event.endsAt === null ? "" : isoToZonedLocal(event.endsAt, event.timezone),
    year: String(event.year),
    locationText: event.locationText ?? "",
    visibility: event.visibility,
    published: event.status === "published",
    slug: event.slug,
    timezone: event.timezone
  };
}

/**
 * The year the address will use: the start date's year when dated (in the
 * event's timezone), else the chosen year.
 *
 * @param values - Form values.
 */
export function previewYear(values: EventFormValues): number {
  if (values.dated) {
    const iso = zonedLocalToIso(values.startsAt, values.timezone);
    const derived = iso === null ? null : eventYearOf(iso, values.timezone);
    if (derived !== null) return derived;
  }
  const typed = Number(values.year);
  return Number.isInteger(typed) ? typed : currentEventYear();
}

/** Dates and year as the contract wants them, or field errors. */
function dateFields(values: EventFormValues): { ok: true; startsAt: string | null; endsAt: string | null; year?: number } | { ok: false; errors: FieldErrors } {
  if (!values.dated) {
    const year = Number(values.year);
    if (!Number.isInteger(year)) return { ok: false, errors: { year: "Elige el año del evento." } };
    return { ok: true, startsAt: null, endsAt: null, year };
  }
  const startsAt = zonedLocalToIso(values.startsAt, values.timezone);
  const endsAt = zonedLocalToIso(values.endsAt, values.timezone);
  const errors: FieldErrors = {};
  if (startsAt === null) errors.startsAt = "Escribe la fecha y hora de inicio.";
  if (endsAt === null) errors.endsAt = "Escribe la fecha y hora de fin.";
  if (startsAt === null || endsAt === null) return { ok: false, errors };
  return { ok: true, startsAt, endsAt };
}

/**
 * The `POST /events` (or admin) body for a new event, checked with the
 * contract schema.
 *
 * @param values - Form values.
 * @param asAdmin - Admins may type a slug (`POST /admin/events`).
 */
export function toCreateRequest(values: EventFormValues, asAdmin: boolean): FormResult<CreateEventRequest | AdminCreateEventRequest> {
  const dates = dateFields(values);
  if (!dates.ok) return dates;
  const request: AdminCreateEventRequest = {
    title: values.title,
    summary: blankToNull(values.summary),
    details: blankToNull(values.details),
    startsAt: dates.startsAt,
    endsAt: dates.endsAt,
    ...(dates.year === undefined ? {} : { year: dates.year }),
    timezone: values.timezone,
    locationText: blankToNull(values.locationText),
    visibility: values.visibility,
    publish: values.published,
    ...(asAdmin && values.slug.trim() !== "" ? { slug: values.slug.trim() } : {})
  };
  const parsed = (asAdmin ? adminCreateEventInputSchema : createEventInputSchema).safeParse(request);
  if (!parsed.success) return { ok: false, errors: issuesToFieldErrors(parsed.error.issues) };
  return { ok: true, request };
}

/**
 * The `PATCH` body for an edit: only what changed. Dates move together; the
 * year is sent only for an undated event. `published` maps to `status`
 * (`draft` ↔ `published`; a hidden event's status is left alone).
 *
 * @param values - Form values.
 * @param event - The event as loaded.
 * @param asAdmin - Admins may change the slug (`PATCH /admin/events/:id`).
 * @returns The request, `null` when nothing changed, or field errors.
 */
export function toUpdateRequest(
  values: EventFormValues,
  event: EventDetail,
  asAdmin: boolean
): FormResult<UpdateEventRequest | AdminUpdateEventRequest> | null {
  const before = initialFormValues(event);
  const dates = dateFields(values);
  if (!dates.ok) return dates;
  const request: AdminUpdateEventRequest = {};
  if (values.title !== before.title) request.title = values.title;
  if (values.summary !== before.summary) request.summary = blankToNull(values.summary);
  if (values.details !== before.details) request.details = blankToNull(values.details);
  if (values.locationText !== before.locationText) request.locationText = blankToNull(values.locationText);
  if (values.visibility !== before.visibility) request.visibility = values.visibility;
  const datesChanged = values.dated !== before.dated || (values.dated && (values.startsAt !== before.startsAt || values.endsAt !== before.endsAt));
  if (datesChanged) {
    request.startsAt = dates.startsAt;
    request.endsAt = dates.endsAt;
  }
  if (!values.dated && (datesChanged || values.year !== before.year) && dates.year !== undefined) request.year = dates.year;
  if (event.status !== "hidden" && values.published !== before.published) {
    const status: EventStatus = values.published ? "published" : "draft";
    request.status = status;
  }
  if (asAdmin && values.slug.trim() !== before.slug) request.slug = values.slug.trim();
  if (Object.keys(request).length === 0) return null;
  const parsed = (asAdmin ? adminUpdateEventInputSchema : updateEventInputSchema).safeParse(request);
  if (!parsed.success) return { ok: false, errors: issuesToFieldErrors(parsed.error.issues) };
  return { ok: true, request };
}
