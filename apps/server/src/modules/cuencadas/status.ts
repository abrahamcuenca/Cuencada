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

/** The fields status depends on. Dates are both set or both `null` (DB CHECK). */
export interface StatusInput {
  isPublished: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  timezone: string;
}

/**
 * Status of an edition at `now`, by **calendar day in the edition's
 * timezone**: unpublished → `draft`; published without dates → `announced`;
 * today before the start day → `upcoming`; from the start day through the
 * end day (inclusive) → `active`; after the end day → `past`. So the whole
 * first and last days count as active, even when `startsAt` is in the evening.
 *
 * @param edition - Publication flag, instants and IANA zone.
 * @param now - Current instant (`app.clock.now()`).
 */
export function computeCuencadaStatus(edition: StatusInput, now: Date): CuencadaStatus {
  if (!edition.isPublished) return CuencadaStatus.Draft;
  if (edition.startsAt === null || edition.endsAt === null) return CuencadaStatus.Announced;
  const today = localDateInZone(now, edition.timezone);
  const startDay = localDateInZone(edition.startsAt, edition.timezone);
  const endDay = localDateInZone(edition.endsAt, edition.timezone);
  // ISO calendar dates compare correctly as strings.
  if (today < startDay) return CuencadaStatus.Upcoming;
  if (today > endDay) return CuencadaStatus.Past;
  return CuencadaStatus.Active;
}

/**
 * Calendar year of `instant` in `timeZone` (e.g. still 2026 in Mérida at
 * `2027-01-01T03:00Z`).
 *
 * @param instant - Any point in time.
 * @param timeZone - IANA zone.
 */
export function localYearInZone(instant: Date, timeZone: string): number {
  return Number(localDateInZone(instant, timeZone).slice(0, 4));
}

/** Minimal shape {@link selectHome} needs. */
export interface HomeCandidate {
  status: CuencadaStatus;
  year: number;
  timezone: string;
  startsAt: Date | null;
  endsAt: Date | null;
}

/** Result of {@link selectHome}. */
export interface HomeSelection<TEdition extends HomeCandidate> {
  mode: HomeMode;
  /**
   * The active edition, else the soonest upcoming one, else the announced one
   * (no dates yet), else `null` (memories mode).
   */
  featured: TEdition | null;
  /** The past edition that ended most recently, if any. */
  latestPast: TEdition | null;
}

/** Epoch ms of a date that the caller's status filter guarantees is set. */
function time(value: Date | null): number {
  // Only `active`/`upcoming`/`past` editions reach the sorts, and those have both dates.
  return value === null ? Number.POSITIVE_INFINITY : value.getTime();
}

/**
 * Pick what the home page shows from the published editions, in this order:
 * 1. an active edition (earliest start if several overlap);
 * 2. the soonest dated upcoming one;
 * 3. an announced edition (no dates yet) whose year is this year or later, in
 *    the edition's timezone; the lowest such year if several. An announced
 *    edition of a year that is already over is stale and ignored;
 * 4. otherwise `memories` mode.
 *
 * `latestPast` is always the most recently ended past edition (Home links to
 * its memories in every mode). Drafts are ignored.
 *
 * @param editions - Published editions with their computed status.
 * @param now - Current instant (`app.clock.now()`), for "this year".
 */
export function selectHome<TEdition extends HomeCandidate>(editions: readonly TEdition[], now: Date): HomeSelection<TEdition> {
  const byStart = (a: TEdition, b: TEdition): number => time(a.startsAt) - time(b.startsAt);
  const active = editions.filter((e) => e.status === CuencadaStatus.Active).sort(byStart);
  const upcoming = editions.filter((e) => e.status === CuencadaStatus.Upcoming).sort(byStart);
  const announced = editions
    .filter((e) => e.status === CuencadaStatus.Announced && e.year >= localYearInZone(now, e.timezone))
    .sort((a, b) => a.year - b.year);
  const past = editions
    .filter((e) => e.status === CuencadaStatus.Past)
    .sort((a, b) => time(b.endsAt) - time(a.endsAt));

  const latestPast = past[0] ?? null;
  const firstActive = active[0];
  if (firstActive !== undefined) return { mode: HomeMode.Active, featured: firstActive, latestPast };
  const firstUpcoming = upcoming[0];
  if (firstUpcoming !== undefined) return { mode: HomeMode.Upcoming, featured: firstUpcoming, latestPast };
  const firstAnnounced = announced[0];
  if (firstAnnounced !== undefined) return { mode: HomeMode.Announced, featured: firstAnnounced, latestPast };
  return { mode: HomeMode.Memories, featured: null, latestPast };
}
