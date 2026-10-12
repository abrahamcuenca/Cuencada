/**
 * Copy and small helpers for the Memory Box pages (WP-6.3). Pure; tested in
 * `format.test.ts`.
 */
import { type MemoryAlbumStatus, MemoryIssueCode } from "@cuencada/types";
import { getApiErrorMessage, parseApiError } from "../../../shared/api/errors";

/** The feature's name, everywhere it is shown. */
export const MEMORY_BOX_NAME = "Baúl de recuerdos";

/** Shown for a missing box and for one the member cannot see (identical on purpose). */
export const MEMORY_NOT_FOUND_TITLE = "No encontramos ese baúl";

/**
 * @param count - Photos and videos the viewer can see in the box.
 * @returns "Aún sin fotos", "1 foto o video" or "12 fotos y videos".
 */
export function mediaCountLabel(count: number): string {
  if (count === 0) return "Aún sin fotos";
  if (count === 1) return "1 foto o video";
  return `${count.toLocaleString("es-MX")} fotos y videos`;
}

/** Spanish label of a box status (admin panel). */
export const STATUS_LABELS: Record<MemoryAlbumStatus, string> = {
  draft: "Borrador",
  published: "Publicado",
  hidden: "Oculto"
};

/** Path of a box page. */
export function memoryPath(id: string): string {
  return `/recuerdos/${encodeURIComponent(id)}`;
}

const ISSUE_MESSAGES: Record<string, string> = {
  [MemoryIssueCode.NotEmpty]: "Este baúl todavía tiene fotos o videos. Bórralos primero (o déjalo oculto).",
  [MemoryIssueCode.NotFound]: "Ese baúl ya no existe."
};

/**
 * @param error - An RTK Query error.
 * @returns A Spanish message for a Memory Box error (known detail codes first, then the server's message).
 */
export function memoryErrorMessage(error: unknown): string {
  const code = parseApiError(error)?.error.details?.[0]?.code;
  return (code !== undefined ? ISSUE_MESSAGES[code] : undefined) ?? getApiErrorMessage(error);
}

/**
 * @param error - An RTK Query error.
 * @returns True for a 404 (a missing box, or a draft/hidden one for members).
 */
export function isNotFound(error: unknown): boolean {
  return parseApiError(error)?.error.code === "NOT_FOUND";
}
