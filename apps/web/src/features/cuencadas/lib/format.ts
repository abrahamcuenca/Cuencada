/**
 * Cuencada-specific formatting built on `shared/lib/dates.ts`. Every function
 * takes the Cuencada's IANA timezone; nothing here reads the device timezone.
 */
import type { CuencadaStatus, DailyMessage, ItineraryItem } from "@cuencada/types";
import { formatDate, formatTime, toZonedParts } from "../../../shared/lib/dates";

/**
 * Date range of an edition, e.g. `"13—18 de septiembre de 2026"`, or
 * `"30 de agosto — 2 de septiembre de 2026"` across months.
 *
 * @param startsAt - ISO instant of the start.
 * @param endsAt - ISO instant of the end.
 * @param timeZone - The Cuencada's IANA timezone.
 * @returns A Spanish date range in that timezone.
 */
export function formatDateRange(startsAt: string, endsAt: string, timeZone: string): string {
  const start = toZonedParts(startsAt, timeZone);
  const end = toZonedParts(endsAt, timeZone);
  const endText = formatDate(endsAt, timeZone, { day: "numeric", month: "long", year: "numeric" });
  if (start.year === end.year && start.month === end.month) {
    if (start.day === end.day) return endText;
    return `${start.day}—${endText}`;
  }
  const startOptions: Intl.DateTimeFormatOptions =
    start.year === end.year ? { day: "numeric", month: "long" } : { day: "numeric", month: "long", year: "numeric" };
  return `${formatDate(startsAt, timeZone, startOptions)} — ${endText}`;
}

/**
 * The hero kicker line, e.g. `"Mérida · Yucatán · 13—18 de septiembre de 2026"`.
 * Uppercased by CSS (`.cu-kicker`), so screen readers get normal casing.
 *
 * @param place - City, state and the edition dates.
 * @returns The kicker text.
 */
export function formatKicker(place: { city: string; state: string; startsAt: string; endsAt: string; timezone: string }): string {
  return [place.city, place.state, formatDateRange(place.startsAt, place.endsAt, place.timezone)].filter(Boolean).join(" · ");
}

/**
 * Today's calendar date (`YYYY-MM-DD`) in the Cuencada's timezone.
 *
 * @param now - The current instant.
 * @param timeZone - The Cuencada's IANA timezone.
 * @returns The local date in that timezone.
 */
export function todayInTimezone(now: Date, timeZone: string): string {
  const parts = toZonedParts(now, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

/**
 * The daily message to show right now. The server already picks today's
 * message, but a response cached by the PWA can be a day old, so the date is
 * checked again against "today" in the Cuencada's timezone.
 *
 * @param message - `todayMessage` from the API.
 * @param now - The current instant.
 * @param timeZone - The Cuencada's IANA timezone.
 * @returns The message when it belongs to today, otherwise `null`.
 */
export function messageForToday(message: DailyMessage | null, now: Date, timeZone: string): DailyMessage | null {
  if (message === null) return null;
  return message.date === todayInTimezone(now, timeZone) ? message : null;
}

/**
 * The element id in a URL fragment, or `null` when there is none or it is
 * malformed (`decodeURIComponent` throws `URIError` on e.g. `#%E0%A4%A`).
 *
 * @param hash - `location.hash`, including the `#`.
 * @returns The decoded id.
 */
export function idFromHash(hash: string): string | null {
  if (hash.length < 2) return null;
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    // A hand-typed or truncated fragment: nothing to scroll to, and nothing worth reporting.
    return null;
  }
}

/** Instants for the shared `Countdown` (`target`, `end`, `now`). */
export interface CountdownInstants {
  target: number;
  end: number;
  now: number;
}

/**
 * Countdown instants driven by the server's `status`, not only by the device
 * clock: the server decides the edition is `active` or `past` (in the
 * edition's timezone), so a wrong device clock, or an edition that starts
 * "today" before its `startsAt` hour, still shows "¡YA LLEGÓ!" / the past
 * message. For `upcoming` the clock runs as usual, so the hero flips to live
 * on its own when `startsAt` passes while the page is open.
 *
 * @param status - Server status of the edition.
 * @param startsAt - ISO start.
 * @param endsAt - ISO end.
 * @param now - The current instant.
 * @returns Props for `Countdown`.
 */
export function countdownInstants(status: CuencadaStatus, startsAt: string, endsAt: string, now: Date): CountdownInstants {
  const nowMs = now.getTime();
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  if (status === "active") return { target: Math.min(start, nowMs), end: Math.max(end, nowMs + 1), now: nowMs };
  if (status === "past") return { target: Math.min(start, nowMs - 1), end: Math.min(end, nowMs), now: nowMs };
  return { target: start, end, now: nowMs };
}

/**
 * Time range of an itinerary item, e.g. `"7:40 a.m. – 6:00 p.m."`.
 *
 * @param item - Start/end wall-clock times (`HH:MM`, already in the Cuencada's timezone).
 * @param timeZone - The Cuencada's IANA timezone.
 * @returns The formatted range, or `null` for all-day items.
 */
export function formatTimeRange(item: Pick<ItineraryItem, "startTime" | "endTime">, timeZone: string): string | null {
  if (item.startTime === null) return null;
  const start = formatTime(item.startTime, timeZone);
  return item.endTime === null ? start : `${start} – ${formatTime(item.endTime, timeZone)}`;
}

/** One day of the programa. */
export interface ItineraryDay {
  date: string;
  items: ItineraryItem[];
}

/**
 * Groups itinerary items by date (ascending), keeping `sortOrder` inside each day.
 *
 * @param items - Items in any order.
 * @returns Days in calendar order.
 */
export function groupItineraryByDay(items: readonly ItineraryItem[]): ItineraryDay[] {
  const byDate = new Map<string, ItineraryItem[]>();
  const sorted = [...items].sort((a, b) => (a.date === b.date ? a.sortOrder - b.sortOrder : a.date < b.date ? -1 : 1));
  for (const item of sorted) {
    const day = byDate.get(item.date);
    if (day) day.push(item);
    else byDate.set(item.date, [item]);
  }
  return [...byDate.entries()].map(([date, dayItems]) => ({ date, items: dayItems }));
}

/**
 * An admin-entered link from the API, returned **unchanged** when it is an
 * `https:` URL. The server already validates links; this is defence in depth
 * so a bad row can never render a `javascript:` href.
 *
 * @param value - A link from the API.
 * @returns The same string, or `null` when it is not https.
 */
export function safeHttpsUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Like {@link safeHttpsUrl}, but also accepts the site asset paths the
 * contract allows (`/images/…`, `/canciones/…`).
 *
 * @param value - `songUrl` or `heroImageUrl` from the API.
 * @returns The same string, or `null` when it is neither https nor a site asset path.
 */
export function safeAssetUrl(value: string | null): string | null {
  if (value === null) return null;
  if (/^\/(?:images|canciones)\/[A-Za-z0-9._\-/]+$/.test(value) && !value.includes("..") && !value.includes("//")) return value;
  return safeHttpsUrl(value);
}
