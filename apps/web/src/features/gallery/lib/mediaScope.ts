/**
 * Where a gallery list or upload belongs (WP-5.4): an edition's year (the
 * original gallery, `/api/cuencadas/:year/media…`), an event album
 * (`/api/events/:eventId/albums/:albumId/media…`) or, WP-6.3, a Memory Box
 * (`/api/memories/:id/media…`). The grid, lightbox, uploader and upload
 * manager are shared; only the endpoints differ.
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

/** A Memory Box ("Baúl de recuerdos", WP-6.3). `label` is the box title. */
export interface MemoryMediaScope {
  kind: "memory";
  memoryAlbumId: string;
  label: string;
}

/** A gallery list / upload target. */
export type MediaScope = YearMediaScope | AlbumMediaScope | MemoryMediaScope;

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
 * @returns `year:2026`, `album:{albumId}` or `memory:{memoryAlbumId}`.
 */
export function mediaScopeKey(scope: MediaScope): string {
  switch (scope.kind) {
    case "year":
      return `year:${scope.year}`;
    case "album":
      return `album:${scope.albumId}`;
    case "memory":
      return `memory:${scope.memoryAlbumId}`;
  }
}

/**
 * @param scope - The scope.
 * @returns What the upload panel shows next to a file from another scope.
 */
export function mediaScopeLabel(scope: MediaScope): string {
  return scope.kind === "year" ? String(scope.year) : scope.label;
}
