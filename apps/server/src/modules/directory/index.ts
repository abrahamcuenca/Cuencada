/**
 * Directory module (T5 owns this folder). Registered under `/api` by
 * `app.ts`; add routes here: `/directory*` (member directory; use `requireVerifiedEmail: true`).
 * See `docs/coordination/WP-0.4.md` for the route checklist.
 */
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

/** Directory routes under `/api` (stub until T5). */
const directoryModule: FastifyPluginAsyncZod = async () => {};

export default directoryModule;
