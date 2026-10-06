import type { MediaItem } from "@cuencada/types";
import { formatDate } from "../../../shared/lib/dates";

/**
 * Timezone for gallery dates. `CuencadaSummary` and `MediaItem` don't carry
 * the edition's timezone yet (see Requests in WP-T4-FE.md), and every edition
 * so far is in Yucatán, the contract default.
 */
export const GALLERY_TIMEZONE = "America/Merida";

/**
 * Short upload date ("14 sept").
 *
 * @param iso - `createdAt` instant.
 * @returns The day and short month in Spanish.
 */
export function formatUploadDate(iso: string): string {
  return formatDate(iso, GALLERY_TIMEZONE, { day: "numeric", month: "short" });
}

/**
 * "Subida por Rosa · 14 sept".
 *
 * @param item - A gallery item.
 * @returns The attribution line.
 */
export function uploadedByLine(item: Pick<MediaItem, "uploaderName" | "createdAt">): string {
  return `Subida por ${item.uploaderName ?? "un familiar"} · ${formatUploadDate(item.createdAt)}`;
}

/**
 * Alternative text: the caption when there is one, else what and who.
 *
 * @param item - A gallery item.
 * @returns A Spanish description for `alt` / `aria-label`.
 */
export function mediaAlt(item: Pick<MediaItem, "caption" | "kind" | "uploaderName" | "createdAt">): string {
  if (item.caption) return item.caption;
  const what = item.kind === "video" ? "Video" : "Foto";
  return `${what} de ${item.uploaderName ?? "un familiar"}, ${formatUploadDate(item.createdAt)}`;
}

/**
 * Parses the `:year` route param.
 *
 * @param raw - The param.
 * @returns The year, or `null` when it isn't a plausible four-digit year.
 */
export function parseYearParam(raw: string): number | null {
  if (!/^\d{4}$/.test(raw)) return null;
  const year = Number(raw);
  return year >= 1900 && year <= 2999 ? year : null;
}
