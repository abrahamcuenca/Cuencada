/**
 * Where a gallery list or upload belongs (WP-5.4): an edition's year (the
 * original gallery, `/api/cuencadas/:year/media…`) or an event album
 * (`/api/events/:eventId/albums/:albumId/media…`). The grid, lightbox,
 * uploader and upload manager are shared; only the endpoints differ.
 */

/** An edition's gallery. */
export interface YearMediaScope {
  kind: "year";
  year: number;
}

/** An event album. `label` names it in the upload panel ("Fotos · Viaje a la playa"). */
export interface AlbumMediaScope {
  kind: "album";
  eventId: string;
  albumId: string;
  label: string;
}

/** A gallery list / upload target. */
export type MediaScope = YearMediaScope | AlbumMediaScope;

/**
 * @param year - Edition year.
 * @returns The year scope.
 */
export function yearScope(year: number): YearMediaScope {
  return { kind: "year", year };
}

/**
 * Stable identity of a scope (the label is not part of it).
 *
 * @param scope - The scope.
 * @returns `year:2026` or `album:{albumId}`.
 */
export function mediaScopeKey(scope: MediaScope): string {
  return scope.kind === "year" ? `year:${scope.year}` : `album:${scope.albumId}`;
}

/**
 * @param scope - The scope.
 * @returns What the upload panel shows next to a file from another scope.
 */
export function mediaScopeLabel(scope: MediaScope): string {
  return scope.kind === "year" ? String(scope.year) : scope.label;
}
