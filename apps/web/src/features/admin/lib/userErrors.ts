import { getApiErrorCode, getApiErrorMessage, parseApiError } from "../../../shared/api/errors";

/** Shown for 403 when the server sent no usable message. */
export const SELF_CHANGE_MESSAGE = "No puedes cambiar tu propio rol ni desactivar tu propia cuenta.";
/** Shown for 409 on a user change (the last active admin guardrail). */
export const LAST_ADMIN_MESSAGE = "Debe quedar al menos un administrador activo.";

/**
 * Spanish message for a failed admin user action, branching on the error
 * code (never on the message):
 * - 403: the self-change guardrail, or the caller lost admin rights; the server's message says which
 * - 409: the last active admin guardrail
 *
 * @param error - What `.unwrap()` rejected with.
 * @returns A message for the sheet's alert.
 */
export function userActionErrorMessage(error: unknown): string {
  switch (getApiErrorCode(error)) {
    case "FORBIDDEN":
      return parseApiError(error)?.error.message ?? SELF_CHANGE_MESSAGE;
    case "CONFLICT":
      return LAST_ADMIN_MESSAGE;
    case "NOT_FOUND":
      return "Esta cuenta ya no existe. Recarga la lista.";
    case "RATE_LIMITED":
      return "Hiciste muchos cambios seguidos. Espera un minuto e inténtalo otra vez.";
    default:
      return getApiErrorMessage(error);
  }
}
