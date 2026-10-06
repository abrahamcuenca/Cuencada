import type { DirectoryEntry } from "@cuencada/types";
import type { DirectoryFilters } from "../api";

/** The search runs from this many characters (fewer shows the whole list). */
export const SEARCH_MIN_CHARS = 2;
/** Quiet time before a typed search is sent. */
export const SEARCH_DEBOUNCE_MS = 300;

/** Filters chosen in the sheet. Empty string means "any". */
export interface DirectorySheetFilters {
  familyBranch: string;
  city: string;
}

/** No filters. */
export const NO_FILTERS: DirectorySheetFilters = { familyBranch: "", city: "" };

/**
 * Builds the list query: only non-empty keys, and `q` only from
 * {@link SEARCH_MIN_CHARS} characters, so equivalent searches share a cache entry.
 *
 * @param search - The debounced search text.
 * @param filters - The sheet filters.
 * @returns The `GET /directory` arguments.
 */
export function toDirectoryQuery(search: string, filters: DirectorySheetFilters): DirectoryFilters {
  const query: DirectoryFilters = {};
  const q = search.trim();
  if (q.length >= SEARCH_MIN_CHARS) query.q = q;
  const branch = filters.familyBranch.trim();
  if (branch !== "") query.familyBranch = branch;
  const city = filters.city.trim();
  if (city !== "") query.city = city;
  return query;
}

/** Lower-case, accent-free form for prefix matching ("Mérida" ≈ "merida"). */
function fold(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("es-MX").trim();
}

/**
 * City suggestions for the filter: the visible cities among the loaded rows
 * that start with what was typed (accent- and case-insensitive), sorted.
 * Memory only, from rows the member already received.
 *
 * @param entries - Loaded rows.
 * @param typed - The city typed so far.
 * @param max - At most this many suggestions.
 * @returns Matching cities.
 */
export function citySuggestions(entries: readonly DirectoryEntry[], typed: string, max = 8): string[] {
  const prefix = fold(typed);
  const byKey = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.city) continue;
    const key = fold(entry.city);
    if (key !== "" && key.startsWith(prefix) && !byKey.has(key)) byKey.set(key, entry.city.trim());
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b, "es-MX")).slice(0, max);
}

/**
 * True for the 400 a "Cargar más" gets when its cursor no longer fits the
 * list (e.g. the member just hid themselves from the directory, so the
 * keyset row the cursor points at is gone). The fix is to reload page 1.
 *
 * @param error - The `error` of a failed `fetchNextPage`.
 * @returns Whether the cursor was refused.
 */
export function isStaleCursorError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 400;
}

/**
 * @param entries - Loaded rows.
 * @returns Distinct family branches, sorted, for the filter suggestions.
 */
export function knownBranches(entries: readonly DirectoryEntry[]): string[] {
  const branches = new Set<string>();
  for (const entry of entries) if (entry.familyBranch) branches.add(entry.familyBranch);
  return [...branches].sort((a, b) => a.localeCompare(b, "es-MX"));
}
