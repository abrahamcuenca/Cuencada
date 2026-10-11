/**
 * Event copy and formatting (WP-5.4). Dates are shown in the event's own
 * timezone, never the device's. Pure: no React, no store.
 */
import { type EventSummary, EventIssueCode, slugifyEventTitle } from "@cuencada/types";
import { getApiErrorMessage, isFetchBaseQueryError } from "../../../shared/api/errors";
import { formatDate, formatTime, toZonedParts } from "../../../shared/lib/dates";
import type { BadgeTone } from "../../../shared/ui/Badge";

/** Shown instead of dates while an event has none. */
export const EVENT_DATES_TBA = "Por anunciar";
/** The 404 screen title: the same for a missing event and one the caller cannot see [SEC]. */
export const EVENT_NOT_FOUND_TITLE = "No encontramos ese evento";
/** The 404 screen text (no hint that the event exists). */
export const EVENT_NOT_FOUND_TEXT = "Revisa la dirección o busca el evento en la lista.";
/** Copy under the slug preview (WP-5.2 Security M1: members never pick the slug). */
export const SLUG_CODE_NOTE = "la dirección lleva un código corto";
/** Consent copy of the participants picker (ADR 0001 §7, WP-5.4). */
export const PARTICIPANT_CONSENT_NOTE = "Les avisaremos y podrán salir cuando quieran.";
/** Shown to the last organizer instead of "Salir del evento". */
export const LAST_ORGANIZER_NOTE = "Eres la única persona que organiza. Para salir, nombra antes a alguien más como organizador.";

/** The `/eventos/{year}/{slug}` path of an event. */
export function eventPath(event: Pick<EventSummary, "year" | "slug">): string {
  return `/eventos/${event.year}/${encodeURIComponent(event.slug)}`;
}

/**
 * The dates line: `"Por anunciar"` when undated; one day with times
 * (`"sábado, 14 de noviembre de 2026 · 2:00 p.m. – 6:00 p.m."`); or a day range
 * (`"14 — 16 de noviembre de 2026"`).
 *
 * @param event - Dates and timezone.
 */
export function formatEventDates(event: Pick<EventSummary, "startsAt" | "endsAt" | "timezone">): string {
  const { startsAt, endsAt, timezone } = event;
  if (startsAt === null || endsAt === null) return EVENT_DATES_TBA;
  try {
    const start = toZonedParts(startsAt, timezone);
    const end = toZonedParts(endsAt, timezone);
    if (start.year === end.year && start.month === end.month && start.day === end.day) {
      const day = formatDate(startsAt, timezone, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
      return `${day} · ${formatTime(startsAt, timezone)} – ${formatTime(endsAt, timezone)}`;
    }
    const endText = formatDate(endsAt, timezone, { day: "numeric", month: "long", year: "numeric" });
    if (start.year === end.year && start.month === end.month) return `${start.day} — ${endText}`;
    const startOptions: Intl.DateTimeFormatOptions =
      start.year === end.year ? { day: "numeric", month: "long" } : { day: "numeric", month: "long", year: "numeric" };
    return `${formatDate(startsAt, timezone, startOptions)} — ${endText}`;
  } catch {
    // An unknown timezone from an older server: better a plain line than a crash.
    return EVENT_DATES_TBA;
  }
}

/**
 * Short date for cards: undated events say "Por anunciar · {year}".
 *
 * @param event - Year, dates and timezone.
 */
export function formatCardDates(event: Pick<EventSummary, "year" | "startsAt" | "endsAt" | "timezone">): string {
  if (event.startsAt === null || event.endsAt === null) return `${EVENT_DATES_TBA} · ${event.year}`;
  return formatEventDates(event);
}

/**
 * @param count - Participants.
 * @returns "Nadie se ha apuntado", "1 participante", "12 participantes".
 */
export function participantCountLabel(count: number): string {
  if (count <= 0) return "Nadie se ha apuntado";
  return count === 1 ? "1 participante" : `${count} participantes`;
}

/** One status badge on a card or the event page. */
export interface EventBadge {
  label: string;
  tone: BadgeTone;
}

/**
 * Badges for an event: "Borrador", "Oculto" (only admins ever receive hidden
 * events), "Solo participantes", and the caller's role.
 *
 * @param event - Status, visibility and role.
 */
export function eventBadges(event: Pick<EventSummary, "status" | "visibility" | "viewerRole">): EventBadge[] {
  const badges: EventBadge[] = [];
  if (event.status === "draft") badges.push({ label: "Borrador", tone: "neutral" });
  if (event.status === "hidden") badges.push({ label: "Oculto", tone: "danger" });
  if (event.visibility === "participants") badges.push({ label: "Solo participantes", tone: "accent" });
  if (event.viewerRole === "organizer") badges.push({ label: "Organizas", tone: "brand" });
  else if (event.viewerRole === "participant") badges.push({ label: "Participas", tone: "success" });
  return badges;
}

/**
 * The address preview of the create form: the slug the title gives, then a
 * placeholder for the random code the server adds (Security M1; members
 * never type a slug, the real code comes back in the response).
 *
 * @param title - What the member typed.
 * @param year - The event's year.
 * @returns e.g. `/eventos/2026/carne-asada-····`.
 */
export function slugPreview(title: string, year: number): string {
  return `/eventos/${year}/${slugifyEventTitle(title)}-····`;
}

/**
 * The `details[].code` of an event error (`EVENT_*`), if any.
 *
 * @param error - An RTK Query error.
 */
export function eventIssueCode(error: unknown): string | null {
  if (!isFetchBaseQueryError(error)) return null;
  const body: unknown = error.data;
  if (typeof body !== "object" || body === null || !("error" in body)) return null;
  const envelope: unknown = body.error;
  if (typeof envelope !== "object" || envelope === null || !("details" in envelope) || !Array.isArray(envelope.details)) return null;
  const details: unknown[] = envelope.details;
  for (const detail of details) {
    if (typeof detail === "object" && detail !== null && "code" in detail && typeof detail.code === "string") return detail.code;
  }
  return null;
}

const ISSUE_MESSAGES: Readonly<Record<string, string>> = {
  [EventIssueCode.LastOrganizer]: "Debe quedar al menos una persona organizando. Nombra antes a alguien más como organizador.",
  [EventIssueCode.AlbumNotEmpty]: "Este álbum tiene fotos. Bórralas (o muévelas) antes de eliminarlo.",
  [EventIssueCode.DeleteNotAllowed]: "Solo puedes eliminar un borrador sin fotos. Si hace falta, pídeselo a un administrador.",
  [EventIssueCode.JoinNotAllowed]: "A este evento solo se entra por invitación de quien lo organiza.",
  [EventIssueCode.NotParticipant]: "Apúntate al evento para ver el chat y las fotos.",
  [EventIssueCode.ManageNotAllowed]: "Solo quienes organizan el evento pueden cambiar esto.",
  [EventIssueCode.SlugTaken]: "Otro evento de ese año ya usa esa dirección. Elige otra.",
  [EventIssueCode.NotFound]: "Ese evento ya no está disponible."
};

/**
 * Spanish message for a failed event write: the `EVENT_*` reason when there
 * is one, else the server's message (or a generic one).
 *
 * @param error - An RTK Query error.
 */
export function eventErrorMessage(error: unknown): string {
  const code = eventIssueCode(error);
  return (code !== null ? ISSUE_MESSAGES[code] : undefined) ?? getApiErrorMessage(error);
}
