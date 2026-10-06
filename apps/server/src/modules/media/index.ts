/**
 * Media module (T4 owns this folder). Registered under `/api` by
 * `app.ts`; add routes here: gallery uploads/confirm/list, reports and admin moderation (uses `app.storage` and `app.jobs`).
 * See `docs/coordination/WP-0.4.md` for the route checklist.
 */
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

/** Media routes under `/api` (stub until T4). */
const mediaModule: FastifyPluginAsyncZod = async () => {};

export default mediaModule;
