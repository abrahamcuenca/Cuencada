/**
 * Helpers shared by the T5 profile and directory routes.
 */
import { apiErrorSchema } from "@cuencada/types";

/** Error envelopes the T5 routes may answer with. */
export const t5ErrorResponses = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  429: apiErrorSchema,
  503: apiErrorSchema
} as const;

/** Per-user rate limit (`preHandler`, keyed on the user id); shared with the media module. */
export { rateLimitByUser } from "../media/shared.js";

/** Name of an unknown thrown value, safe to log (never the message, which may hold keys or PII). */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}
