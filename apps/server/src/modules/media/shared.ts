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

/**
 * Delete objects, logging (without keys) and continuing on failure. A later
 * idempotent `DELETE` retries them.
 *
 * @param app - For storage and the logger.
 * @param mediaId - For the log line.
 * @param keys - Object keys to remove.
 */
export async function deleteObjectsQuietly(app: FastifyInstance, mediaId: string, keys: string[]): Promise<void> {
  for (const key of keys) {
    try {
      await app.storage.delete(key);
    } catch (error) {
      app.log.warn({ mediaId, errorName: error instanceof Error ? error.name : "unknown" }, "media object delete failed");
    }
  }
}
