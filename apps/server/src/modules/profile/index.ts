/**
 * Profile module (T5 owns this folder). Registered under `/api` by
 * `app.ts`; add routes here: `/profile/me*` (own profile and avatar).
 * See `docs/coordination/WP-0.4.md` for the route checklist.
 */
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

/** Profile routes under `/api` (stub until T5). */
const profileModule: FastifyPluginAsyncZod = async () => {};

export default profileModule;
