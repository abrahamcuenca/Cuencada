/**
 * Opaque keyset cursor of `GET /api/events`: `(year, undated flag, starts_at
 * as epoch microseconds, id)` of the last row of the previous page.
 */
import { idSchema } from "@cuencada/types";
import { AppError } from "../../lib/errors.js";
import { MAX_CURSOR_MICROS } from "../media/cursor.js";
import type { EventListCursor } from "./repository.js";

/** Encode the position of a list row. */
export function encodeEventCursor(cursor: EventListCursor): string {
  return Buffer.from(`${cursor.year}:${cursor.flag ? 1 : 0}:${cursor.micros}:${cursor.id}`, "utf8").toString("base64url");
}

/**
 * Decode a client cursor.
 *
 * @throws AppError VALIDATION when it is not a cursor this server produced.
 */
export function decodeEventCursor(raw: string): EventListCursor {
  const parts = Buffer.from(raw, "base64url").toString("utf8").split(":");
  const [year, flag, micros, id] = parts;
  const valid =
    parts.length === 4 &&
    year !== undefined &&
    /^\d{4}$/.test(year) &&
    (flag === "0" || flag === "1") &&
    micros !== undefined &&
    /^-?\d{1,18}$/.test(micros) &&
    BigInt(micros) <= MAX_CURSOR_MICROS &&
    BigInt(micros) >= -MAX_CURSOR_MICROS &&
    idSchema.safeParse(id).success;
  if (!valid || id === undefined || micros === undefined || year === undefined) {
    throw new AppError("VALIDATION", "Cursor inválido.", { details: [{ path: "cursor", message: "Cursor inválido." }] });
  }
  return { year: Number(year), flag: flag === "1", micros, id };
}
