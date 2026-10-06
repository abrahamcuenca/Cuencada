/**
 * Opaque keyset cursor for the directory, ordered by `(lower(full_name), user id)`.
 *
 * - `n.<base64url(id + ":" + sortName)>` carries the exact sort key.
 * - `i.<base64url(id)>` is used when the name would push the cursor past the
 *   contract's 512-character limit; the server then reads the sort key of
 *   that user from the database (a position only; nothing is returned).
 */
import { cursorSchema, idSchema } from "@cuencada/types";
import { AppError } from "../../lib/errors.js";

/** Contract maximum for a cursor string. */
const CURSOR_MAX_LENGTH = 512;

/** Decoded cursor: the last entry of the previous page. */
export type DirectoryCursor = { kind: "name"; id: string; sortName: string } | { kind: "id"; id: string };

function invalidCursor(): AppError {
  return new AppError("VALIDATION", "Cursor inválido.", {
    details: [{ path: "cursor", message: "Cursor inválido." }]
  });
}

/**
 * Encode the position after `id`/`sortName`.
 *
 * @param id - Last entry's user id.
 * @param sortName - Its `lower(full_name)` exactly as the database computed it.
 */
export function encodeDirectoryCursor(id: string, sortName: string): string {
  const full = `n.${Buffer.from(`${id}:${sortName}`, "utf8").toString("base64url")}`;
  if (full.length <= CURSOR_MAX_LENGTH && cursorSchema.safeParse(full).success) return full;
  return `i.${Buffer.from(id, "utf8").toString("base64url")}`;
}

/**
 * Decode a client cursor.
 *
 * @param raw - Query value (already shape-checked by `cursorSchema`).
 * @throws AppError `VALIDATION` when it is not a cursor this server produced.
 */
export function decodeDirectoryCursor(raw: string): DirectoryCursor {
  const kind = raw.slice(0, 2);
  const decoded = Buffer.from(raw.slice(2), "base64url").toString("utf8");
  if (kind === "i.") {
    if (!idSchema.safeParse(decoded).success) throw invalidCursor();
    return { kind: "id", id: decoded };
  }
  if (kind !== "n.") throw invalidCursor();
  const separator = decoded.indexOf(":");
  const id = decoded.slice(0, separator);
  if (separator < 0 || !idSchema.safeParse(id).success) throw invalidCursor();
  return { kind: "name", id, sortName: decoded.slice(separator + 1) };
}
