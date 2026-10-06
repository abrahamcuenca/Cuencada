/**
 * Helpers shared by the T5 profile and directory routes.
 */
import { apiErrorSchema } from "@cuencada/types";
import type { RateLimitOptions } from "@fastify/rate-limit";
import { ipKey, type RateLimitWindow } from "../../lib/rateLimit.js";

/** Error envelopes the T5 routes may answer with. */
export const t5ErrorResponses = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  429: apiErrorSchema,
  503: apiErrorSchema
} as const;

/**
 * Per-user rate limit. Runs in `preHandler`, after the auth guard has set
 * `request.user`, so the key is the user id (IP only as a fallback).
 *
 * @param prefix - Counter namespace, unique per route.
 * @param window - Max requests per time window.
 */
export function rateLimitByUser(prefix: string, window: RateLimitWindow): RateLimitOptions {
  return {
    ...window,
    hook: "preHandler",
    keyGenerator: (request) => `${prefix}:${request.user === null ? ipKey(request) : `user:${request.user.id}`}`
  };
}

/** Name of an unknown thrown value, safe to log (never the message, which may hold keys or PII). */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}
