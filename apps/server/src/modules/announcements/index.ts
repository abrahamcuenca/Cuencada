/**
 * Announcements module (T2 owns this folder). Registered under `/api` by
 * `app.ts`; add routes here: `/announcements` and `/admin/announcements*`.
 * See `docs/coordination/WP-0.4.md` for the route checklist.
 */
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

/** Announcements routes under `/api` (stub until T2). */
const announcementsModule: FastifyPluginAsyncZod = async () => {};

export default announcementsModule;
