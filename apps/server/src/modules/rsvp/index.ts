/**
 * RSVP module (T3 owns this folder). Registered under `/api` by
 * `app.ts`; add routes here: `/cuencadas/:year/rsvp*`, `/cuencadas/:year/attendees` and admin RSVP/attendance routes.
 * See `docs/coordination/WP-0.4.md` for the route checklist.
 */
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

/** RSVP routes under `/api` (stub until T3). */
const rsvpModule: FastifyPluginAsyncZod = async () => {};

export default rsvpModule;
