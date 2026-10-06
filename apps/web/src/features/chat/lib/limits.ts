/**
 * Copies of contract constants used by code in the **initial** chunk (the
 * Chat tab badge pulls in `api.ts`, `unread.ts` and `lib/rooms.ts`).
 *
 * Importing a value from `@cuencada/types` keeps that whole module, every
 * zod schema in `chat.ts` included, in the initial bundle, so these numbers
 * are mirrored here. `limits.test.ts` fails if they drift from the contract.
 * Lazy chat code imports the contract directly.
 */

/** `CHAT_UNREAD_COUNT_MAX`: the server stops counting here; the UI shows "999+". */
export const UNREAD_COUNT_MAX = 999;
