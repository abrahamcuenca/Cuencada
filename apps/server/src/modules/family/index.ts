/**
 * Family module (T6 owns this folder). Registered under `/api` by
 * `app.ts`; add routes here: `/family/*` and admin people/relationships (use `requireVerifiedEmail: true` on reads).
 * See `docs/coordination/WP-0.4.md` for the route checklist.
 */
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

/** Family routes under `/api` (stub until T6). */
const familyModule: FastifyPluginAsyncZod = async () => {};

export default familyModule;
