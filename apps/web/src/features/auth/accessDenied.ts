import type { CurrentUser } from "@cuencada/types";
import { useAppSelector } from "../../app/hooks";
import { isFetchBaseQueryError } from "../../shared/api/errors";
import { selectCurrentUser } from "./authSlice";

/**
 * Why a member-only request was refused with 403:
 * - `unverified`: the caller's email isn't verified yet (show "Verifica tu correo…" + resend);
 * - `forbidden`: any other 403 (show a generic "No tienes acceso…").
 */
export type AccessDenial = "unverified" | "forbidden";

/**
 * Error code the server uses for "verify your email first" (WP-0.8a).
 * TODO(WP-0.8a): switch to `ErrorCode.EMAIL_UNVERIFIED` from `@cuencada/types`
 * once it is on main; the literal keeps this working before and after.
 */
export const EMAIL_UNVERIFIED_CODE = "EMAIL_UNVERIFIED";

/**
 * Just the `error.code` string of an error envelope. Deliberately looser than
 * `apiErrorSchema` (whose code is a closed enum), so a code this build doesn't
 * know yet is still read instead of dropping the whole body.
 */
function rawErrorCode(error: unknown): string | null {
  if (!isFetchBaseQueryError(error)) return null;
  const body: unknown = error.data;
  if (typeof body !== "object" || body === null || !("error" in body)) return null;
  const envelope: unknown = body.error;
  if (typeof envelope !== "object" || envelope === null || !("code" in envelope)) return null;
  return typeof envelope.code === "string" && envelope.code.length <= 64 ? envelope.code : null;
}

/** HTTP status of a `fetchBaseQuery` error, or `null` when there was no HTTP answer. */
function httpStatus(error: unknown): number | null {
  if (!isFetchBaseQueryError(error)) return null;
  if (typeof error.status === "number") return error.status;
  return "originalStatus" in error ? error.originalStatus : null;
}

/**
 * Classifies a 403 from a member-only endpoint (directory, family tree,
 * attendees, gallery, …). One rule for every feature:
 * - `EMAIL_UNVERIFIED` → `unverified` (preferred, explicit server code);
 * - `FORBIDDEN` while the current user has `emailVerified === false` →
 *   `unverified` (older servers that only send `FORBIDDEN`);
 * - any other 403 → `forbidden`.
 *
 * @param error - The `error` from an RTK Query result.
 * @param user - The signed-in user, or `null`.
 * @returns The denial kind, or `null` when the error is not a 403.
 */
export function classifyAccessDenial(error: unknown, user: Pick<CurrentUser, "emailVerified"> | null): AccessDenial | null {
  if (httpStatus(error) !== 403) return null;
  const code = rawErrorCode(error);
  if (code === EMAIL_UNVERIFIED_CODE) return "unverified";
  if (code === "FORBIDDEN" && user?.emailVerified === false) return "unverified";
  return "forbidden";
}

/**
 * {@link classifyAccessDenial} with the signed-in user from the store.
 *
 * @param error - The `error` from an RTK Query result (or `undefined`).
 * @returns The denial kind, or `null` when the error is not a 403.
 */
export function useAccessDenial(error: unknown): AccessDenial | null {
  const user = useAppSelector(selectCurrentUser);
  return classifyAccessDenial(error, user);
}
