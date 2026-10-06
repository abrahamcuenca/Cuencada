/**
 * Invites module (T1 owns this folder). Registered under `/api` by
 * `app.ts`; add routes here: invite inspect/accept (`/invites/*`) and admin invites (`/admin/invites*`).
 * See `docs/coordination/WP-0.4.md` for the route checklist.
 */
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

/** Invites routes under `/api` (stub until T1). */
const invitesModule: FastifyPluginAsyncZod = async () => {};

export default invitesModule;
