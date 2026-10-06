/**
 * Opaque keyset cursor for `(created_at desc, id desc)` lists. The timestamp
 * travels as epoch microseconds so Postgres' microsecond precision survives
 * the round trip (a JS `Date` would truncate to milliseconds and skip rows).
 */
import { idSchema } from "@cuencada/types";
import { AppError } from "../../lib/errors.js";

/** Largest accepted cursor timestamp: 9999-12-31T23:59:59.999999Z in epoch microseconds. */
export const MAX_CURSOR_MICROS = 253402300799999999n;

/** Decoded cursor: the last row of the previous page. */
export interface MediaCursor {
  /** Epoch microseconds of `created_at`, as a decimal string. */
  micros: string;
  id: string;
}

/**
 * Encode a cursor.
 *
 * @param cursor - Last row's position.
 */
export function encodeCursor(cursor: MediaCursor): string {
  return Buffer.from(`${cursor.micros}:${cursor.id}`, "utf8").toString("base64url");
}

/**
 * Decode a client cursor.
 *
 * @param raw - Value from the query string (already shape-checked by `cursorSchema`).
 * @throws AppError VALIDATION when it is not a cursor this server produced.
 */
export function decodeCursor(raw: string): MediaCursor {
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const separator = decoded.indexOf(":");
  const micros = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  // Bound the timestamp so `::bigint` and the interval arithmetic can never overflow (→ 500).
  const inRange = /^\d{1,18}$/.test(micros) && BigInt(micros) <= MAX_CURSOR_MICROS;
  if (separator < 1 || !inRange || !idSchema.safeParse(id).success) {
    throw new AppError("VALIDATION", "Cursor inválido.", { details: [{ path: "cursor", message: "Cursor inválido." }] });
  }
  return { micros, id };
}
