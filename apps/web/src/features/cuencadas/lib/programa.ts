import { type CuencadaHome, HomeMode } from "@cuencada/types";

/** Home modes whose featured edition has dates, and so a programa to open. */
const DATED_MODES: ReadonlySet<string> = new Set<string>([HomeMode.Upcoming, HomeMode.Active]);

/**
 * The edition year "Programa" should open: the featured edition while it is
 * upcoming or active, otherwise the latest past one.
 *
 * Defensive on purpose: any other mode, including one this build doesn't know
 * yet (WP-3.1a adds `announced`, a published edition without dates or
 * itinerary), counts as undated, so the link never lands on a year page with
 * no programa.
 *
 * @param home - `GET /cuencadas/home`, or `undefined` while it loads.
 * @returns The year, or `null` when there is no edition to show.
 */
export function programaYear(home: Pick<CuencadaHome, "mode" | "featured" | "latestPast"> | undefined): number | null {
  if (home === undefined) return null;
  const mode: string = home.mode;
  if (DATED_MODES.has(mode) && home.featured !== null) return home.featured.year;
  return home.latestPast?.year ?? null;
}
