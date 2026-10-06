/**
 * Pure date logic for Cuencada editions: calendar dates in an IANA zone,
 * computed status and the home page selection. No I/O; `now` is always passed
 * in (from `app.clock`) so tests can pin it.
 */
import { CuencadaStatus, HomeMode } from "@cuencada/types";

const formatters = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    // en-CA keeps the parts numeric; we assemble YYYY-MM-DD from parts anyway.
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * Calendar date (`YYYY-MM-DD`) of `instant` as seen in `timeZone`.
 *
 * @param instant - Any point in time.
 * @param timeZone - IANA zone (validated with `timezoneSchema` on write).
 * @returns The local calendar day, e.g. `2026-09-12` for `2026-09-13T05:30Z` in `America/Merida`.
 * @throws RangeError when `timeZone` is unknown to `Intl` (never for stored rows).
 */
export function localDateInZone(instant: Date, timeZone: string): string {
  let year = "";
  let month = "";
  let day = "";
  for (const part of dateFormatter(timeZone).formatToParts(instant)) {
    if (part.type === "year") year = part.value;
    else if (part.type === "month") month = part.value;
    else if (part.type === "day") day = part.value;
  }
  return `${year}-${month}-${day}`;
}

/** The fields status depends on. */
export interface StatusInput {
  isPublished: boolean;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
}

/**
 * Status of an edition at `now`, by **calendar day in the edition's
 * timezone**: unpublished → `draft`; today before the start day → `upcoming`;
 * from the start day through the end day (inclusive) → `active`; after the
 * end day → `past`. So the whole first and last days count as active, even
 * when `startsAt` is in the evening.
 *
 * @param edition - Publication flag, instants and IANA zone.
 * @param now - Current instant (`app.clock.now()`).
 */
export function computeCuencadaStatus(edition: StatusInput, now: Date): CuencadaStatus {
  if (!edition.isPublished) return CuencadaStatus.Draft;
  const today = localDateInZone(now, edition.timezone);
  const startDay = localDateInZone(edition.startsAt, edition.timezone);
  const endDay = localDateInZone(edition.endsAt, edition.timezone);
  // ISO calendar dates compare correctly as strings.
  if (today < startDay) return CuencadaStatus.Upcoming;
  if (today > endDay) return CuencadaStatus.Past;
  return CuencadaStatus.Active;
}

/** Minimal shape {@link selectHome} needs. */
export interface HomeCandidate {
  status: CuencadaStatus;
  startsAt: Date;
  endsAt: Date;
}

/** Result of {@link selectHome}. */
export interface HomeSelection<TEdition extends HomeCandidate> {
  mode: HomeMode;
  /** The active edition, else the soonest upcoming one, else `null` (memories mode). */
  featured: TEdition | null;
  /** The past edition that ended most recently, if any. */
  latestPast: TEdition | null;
}

/**
 * Pick what the home page shows from the published editions: an active
 * edition wins (earliest start if several overlap), then the soonest upcoming
 * one; with neither, the page is in `memories` mode. `latestPast` is always
 * the most recently ended past edition. Drafts are ignored.
 *
 * @param editions - Published editions with their computed status.
 */
export function selectHome<TEdition extends HomeCandidate>(editions: readonly TEdition[]): HomeSelection<TEdition> {
  const byStart = (a: TEdition, b: TEdition): number => a.startsAt.getTime() - b.startsAt.getTime();
  const active = editions.filter((e) => e.status === CuencadaStatus.Active).sort(byStart);
  const upcoming = editions.filter((e) => e.status === CuencadaStatus.Upcoming).sort(byStart);
  const past = editions
    .filter((e) => e.status === CuencadaStatus.Past)
    .sort((a, b) => b.endsAt.getTime() - a.endsAt.getTime());

  const latestPast = past[0] ?? null;
  const firstActive = active[0];
  if (firstActive !== undefined) return { mode: HomeMode.Active, featured: firstActive, latestPast };
  const firstUpcoming = upcoming[0];
  if (firstUpcoming !== undefined) return { mode: HomeMode.Upcoming, featured: firstUpcoming, latestPast };
  return { mode: HomeMode.Memories, featured: null, latestPast };
}
