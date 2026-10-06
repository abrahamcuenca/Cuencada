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

/**
 * @param entries - Loaded rows.
 * @returns Distinct family branches, sorted, for the filter suggestions.
 */
export function knownBranches(entries: readonly DirectoryEntry[]): string[] {
  const branches = new Set<string>();
  for (const entry of entries) if (entry.familyBranch) branches.add(entry.familyBranch);
  return [...branches].sort((a, b) => a.localeCompare(b, "es-MX"));
}
