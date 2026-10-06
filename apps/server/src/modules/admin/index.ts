/**
 * Admin module (T8 owns this folder). Registered under `/api` by
 * `app.ts`; add routes here: `/admin/users*` and `/admin/audit-logs`.
 * See `docs/coordination/WP-0.4.md` for the route checklist.
 */
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

/** Admin routes under `/api` (stub until T8). */
const adminModule: FastifyPluginAsyncZod = async () => {};

export default adminModule;
