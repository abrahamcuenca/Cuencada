/**
 * Date and time formatting for the Cuencada portal.
 *
 * Everything renders in Spanish (`es-MX`) and in the **Cuencada's** IANA
 * timezone (e.g. `America/Merida`), never the viewer's device timezone: a
 * relative in Madrid must see the same "9:00 a.m." as the family in Mérida.
 *
 * Two kinds of input exist in the contracts:
 * - calendar dates `YYYY-MM-DD` and wall-clock times `HH:MM`, which already
 *   belong to the Cuencada's timezone and are formatted without conversion;
 * - ISO instants (`2026-09-13T15:00:00Z`) or `Date`s, which are converted to
 *   the given timezone.
 */

/** Locale used for every user-facing date. */
export const DATE_LOCALE = "es-MX";

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WALL_CLOCK_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A date input: a `Date`, an ISO instant, or a calendar date `YYYY-MM-DD`. */
export type DateInput = Date | string;

/** Calendar fields of an instant as seen in a given timezone. */
export interface ZonedParts {
  year: number;
  /** 1–12. */
  month: number;
  day: number;
  /** 0–23. */
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
}

/** Remaining time until a target instant, split for a countdown display. */
export interface Countdown {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  /** Milliseconds remaining, never negative. */
  totalMs: number;
  /** True once `now` has reached the target. */
  isPast: boolean;
}

function toInstant(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Fecha inválida: ${String(value)}`);
  }
  return date;
}

/** Midday UTC for a calendar date, so formatting in UTC can never shift the day. */
function calendarDateToUtcNoon(value: string): Date | null {
  const match = CALENDAR_DATE.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12));
  if (date.getUTCDate() !== Number(day)) {
    throw new RangeError(`Fecha inválida: ${value}`);
  }
  return date;
}

/**
 * Formats a date in Spanish for the Cuencada's timezone.
 *
 * Calendar dates (`YYYY-MM-DD`) are shown as-is, with no timezone shift.
 *
 * @param value - A `Date`, ISO instant, or calendar date.
 * @param timeZone - IANA timezone of the Cuencada, e.g. `America/Merida`.
 * @param options - `Intl.DateTimeFormat` options; defaults to `{ dateStyle: "long" }`.
 * @returns e.g. `"13 de septiembre de 2026"`.
 * @throws {RangeError} For an unparseable date or unknown timezone.
 */
export function formatDate(
  value: DateInput,
  timeZone: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: "long" }
): string {
  if (typeof value === "string") {
    const calendar = calendarDateToUtcNoon(value);
    if (calendar) {
      return new Intl.DateTimeFormat(DATE_LOCALE, { ...options, timeZone: "UTC" }).format(calendar);
    }
  }
  return new Intl.DateTimeFormat(DATE_LOCALE, { ...options, timeZone }).format(toInstant(value));
}

/**
 * Formats a time of day in Spanish 12-hour style for the Cuencada's timezone.
 *
 * Wall-clock strings (`HH:MM`, as in `ItineraryItem.startTime`) are already
 * local to the Cuencada and are not converted.
 *
 * @param value - A `Date`, an ISO instant, or a 24h `HH:MM` string.
 * @param timeZone - IANA timezone of the Cuencada.
 * @returns e.g. `"6:30 p.m."`.
 * @throws {RangeError} For an unparseable value or unknown timezone.
 */
export function formatTime(value: DateInput, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  if (typeof value === "string") {
    const match = WALL_CLOCK_TIME.exec(value);
    if (match) {
      const wallClock = new Date(Date.UTC(2000, 0, 1, Number(match[1]), Number(match[2])));
      return new Intl.DateTimeFormat(DATE_LOCALE, { ...options, timeZone: "UTC" }).format(wallClock);
    }
  }
  return new Intl.DateTimeFormat(DATE_LOCALE, { ...options, timeZone }).format(toInstant(value));
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * Splits an instant into calendar fields as seen in `timeZone`
 * (e.g. to decide which itinerary day is "today" in Mérida).
 *
 * @param value - A `Date` or ISO instant.
 * @param timeZone - IANA timezone.
 * @returns Numeric year, month (1–12), day, hour (0–23), minute, second and weekday.
 * @throws {RangeError} For an unparseable value or unknown timezone.
 */
export function toZonedParts(value: Date | string, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    weekday: "short"
  }).formatToParts(toInstant(value));

  const pick = (type: Intl.DateTimeFormatPartTypes): string => {
    const part = parts.find((candidate) => candidate.type === type);
    if (!part) throw new RangeError(`Intl no devolvió la parte ${type}.`);
    return part.value;
  };

  const weekday = WEEKDAYS[pick("weekday")];
  if (weekday === undefined) throw new RangeError("Día de la semana desconocido.");

  return {
    year: Number(pick("year")),
    month: Number(pick("month")),
    day: Number(pick("day")),
    hour: Number(pick("hour")),
    minute: Number(pick("minute")),
    second: Number(pick("second")),
    weekday
  };
}

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Computes the time left until `target`, clamped at zero.
 *
 * Pure: pass `now` explicitly so a ticking component and its tests agree.
 * Days are 24h spans of elapsed time (timezone-independent), which is what a
 * countdown shows.
 *
 * @param target - The instant being counted down to (e.g. `startsAt`).
 * @param now - The current instant.
 * @returns Days, hours, minutes and seconds remaining, plus `isPast`.
 * @throws {RangeError} For an unparseable value.
 */
export function computeCountdown(target: Date | string, now: Date | string): Countdown {
  const remaining = toInstant(target).getTime() - toInstant(now).getTime();
  const totalMs = Math.max(0, remaining);
  return {
    days: Math.floor(totalMs / DAY_MS),
    hours: Math.floor((totalMs % DAY_MS) / HOUR_MS),
    minutes: Math.floor((totalMs % HOUR_MS) / MINUTE_MS),
    seconds: Math.floor((totalMs % MINUTE_MS) / SECOND_MS),
    totalMs,
    isPast: remaining <= 0
  };
}
