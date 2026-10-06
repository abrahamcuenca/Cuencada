import { getApiErrorCode, isFetchBaseQueryError } from "../../../shared/api/errors";

/** Why the server refused chat: an unverified email, or any other 403. */
export type ChatDenial = "unverified" | "forbidden";

/**
 * Classifies a chat 403. `EMAIL_UNVERIFIED` is the server's explicit signal;
 * a plain `FORBIDDEN` counts as "unverified" only when the in-memory user is
 * known to be unverified (older servers). Every other 403 gets the generic
 * state, never the misleading "verify your email".
 *
 * @param error - An RTK Query error.
 * @param emailVerified - The signed-in user's `emailVerified`, if known.
 * @returns The denial, or `null` when the error is not a chat refusal.
 */
export function chatDenial(error: unknown, emailVerified: boolean | undefined): ChatDenial | null {
  if (!isFetchBaseQueryError(error) || error.status !== 403) return null;
  const code = getApiErrorCode(error);
  // The base query already routes this one to /cambiar-contrasena.
  if (code === "PASSWORD_CHANGE_REQUIRED") return null;
  if (code === "EMAIL_UNVERIFIED") return "unverified";
  if (code === "FORBIDDEN" && emailVerified === false) return "unverified";
  return "forbidden";
}
