/**
 * RSVP module (T3): members' own RSVP, the summary and attendee strip, and
 * the admin RSVP table/CSV and historical attendance. Mounted under `/api`
 * by `app.ts`. See `docs/coordination/WP-T3-BE.md`.
 */
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import rsvpAdminRoutes from "./admin-routes.js";
import rsvpMemberRoutes from "./member-routes.js";

/** RSVP routes under `/api`. */
const rsvpModule: FastifyPluginAsyncZod = async (app) => {
  await app.register(rsvpMemberRoutes);
  await app.register(rsvpAdminRoutes);
};

export default rsvpModule;
