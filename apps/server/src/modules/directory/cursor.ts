/**
 * Opaque keyset cursor for the directory: base64url of the last entry's
 * **user id only** (like the T6 family cursors). It never carries a name.
 *
 * The server resolves the position `(lower(full_name), id)` from the
 * database, restricted to listed, active members, so a cursor pointing at an
 * unlisted, disabled or unknown user gets the same generic 400 (no
 * existence oracle).
 */
import { idSchema } from "@cuencada/types";
import { AppError } from "../../lib/errors.js";

/** Decoded cursor: the user id of the last entry of the previous page. */
export interface DirectoryCursor {
  id: string;
}

/**
 * The single, generic cursor error (400 `VALIDATION`). Used for malformed
 * cursors and for ids that are not a listed, active member alike.
 */
export function invalidDirectoryCursor(): AppError {
  return new AppError("VALIDATION", "Cursor inválido.", {
    details: [{ path: "cursor", message: "Cursor inválido." }]
  });
}

/**
 * Encode the position after `id`.
 *
 * @param id - Last entry's user id.
 */
export function encodeDirectoryCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}

/**
 * Decode a client cursor.
 *
 * @param raw - Query value (already shape-checked by `cursorSchema`).
 * @throws AppError `VALIDATION` when it does not decode to a uuid.
 */
export function decodeDirectoryCursor(raw: string): DirectoryCursor {
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  if (!idSchema.safeParse(decoded).success) throw invalidDirectoryCursor();
  return { id: decoded };
}
