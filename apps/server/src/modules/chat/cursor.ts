/**
 * Opaque `nextBefore` cursor for chat history: `(created_at, id)` of the oldest
 * message on the previous page. The timestamp travels as epoch microseconds so
 * Postgres' precision survives (a JS `Date` would drop microseconds and skip rows).
 */
import { idSchema } from "@cuencada/types";
import { AppError } from "../../lib/errors.js";

/** Largest accepted cursor timestamp: 9999-12-31T23:59:59.999999Z in epoch microseconds. */
const MAX_CURSOR_MICROS = 253402300799999999n;
const CURSOR_PREFIX = "c1";

/** Decoded history cursor. */
export interface ChatCursor {
  /** Epoch microseconds of `created_at`, as a decimal string. */
  micros: string;
  id: string;
}

/**
 * Encode a cursor.
 *
 * @param cursor - The oldest row of the page just returned.
 */
export function encodeChatCursor(cursor: ChatCursor): string {
  return Buffer.from(`${CURSOR_PREFIX}:${cursor.micros}:${cursor.id}`, "utf8").toString("base64url");
}

/**
 * Decode a client cursor.
 *
 * @param raw - `before` from the query string (shape-checked by `cursorSchema`).
 * @throws AppError VALIDATION when it is not a cursor this server produced.
 */
export function decodeChatCursor(raw: string): ChatCursor {
  const [prefix, micros, id, ...rest] = Buffer.from(raw, "base64url").toString("utf8").split(":");
  // Bound the timestamp so `::bigint` and the interval arithmetic can never overflow (→ 500).
  const inRange = micros !== undefined && /^\d{1,18}$/.test(micros) && BigInt(micros) <= MAX_CURSOR_MICROS;
  if (prefix !== CURSOR_PREFIX || !inRange || rest.length > 0 || !idSchema.safeParse(id).success) {
    throw new AppError("VALIDATION", "Cursor inválido.", {
      details: [{ path: "before", message: "Cursor inválido." }]
    });
  }
  // `inRange` and the id check above prove both parts are strings.
  return { micros: micros ?? "", id: id ?? "" };
}
