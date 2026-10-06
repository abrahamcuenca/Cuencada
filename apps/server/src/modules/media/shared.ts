/**
 * Helpers shared by the member and admin media routes.
 */
import { apiErrorSchema } from "@cuencada/types";
import type { RateLimitOptions } from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ipKey, type RateLimitWindow } from "../../lib/rateLimit.js";
import type { AuthUser } from "../../plugins/auth.js";
import type { MediaJobDeps } from "./jobs/mediaProcess.js";
import type { Viewer } from "./service.js";

/** Error envelopes every media route may answer with. */
export const mediaErrorResponses = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
  429: apiErrorSchema,
  503: apiErrorSchema
} as const;

/** `204 No Content`: no body. */
export const noContentSchema = z.void();

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

/** The visibility subject for an authenticated user. */
export function viewerOf(user: AuthUser): Viewer {
  return { id: user.id, role: user.role };
}

/** Job dependencies from the app's decorators. */
export function jobDeps(app: FastifyInstance): MediaJobDeps {
  return { db: app.db, storage: app.storage, clock: app.clock, log: app.log, jobs: app.jobs };
}

export { deleteObjectsQuietly } from "./objects.js";
