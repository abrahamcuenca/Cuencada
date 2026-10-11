/**
 * Events module (WP-5.3, "Eventos"): member routes, the cover routes and the
 * admin routes, registered under `/api` by `app.ts`. Authorization is ADR
 * 0001 §7; the route list is `docs/coordination/WP-5.2.md`; implementation
 * notes are `docs/coordination/WP-5.3.md`.
 */
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import adminEventRoutes from "./adminRoutes.js";
import eventCoverRoutes from "./coverRoutes.js";
import eventRoutes from "./routes.js";

/** Event routes under `/api`. */
const eventsModule: FastifyPluginAsyncZod = async (app) => {
  await app.register(eventRoutes);
  await app.register(eventCoverRoutes);
  await app.register(adminEventRoutes);
};

export default eventsModule;
