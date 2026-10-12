/**
 * Memory Box module (WP-6.3, "Baúl de recuerdos"): member routes under
 * `/api/memories` and admin routes under `/api/admin/memory-albums`.
 * Registered by the media module (box media are gallery media: the same
 * confirm, processing, moderation, cleanup and social routes). Authorization
 * is ADR 0001 §8; routes are `docs/coordination/WP-6.0.md`; implementation
 * notes are `docs/coordination/WP-6.3.md`.
 */
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import adminMemoryRoutes from "./adminRoutes.js";
import memoryRoutes from "./routes.js";

/** Memory Box routes under `/api`. */
const memoriesModule: FastifyPluginAsyncZod = async (app) => {
  await app.register(memoryRoutes);
  await app.register(adminMemoryRoutes);
};

export default memoriesModule;
