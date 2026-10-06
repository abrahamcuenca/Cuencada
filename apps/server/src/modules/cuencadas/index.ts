/**
 * Cuencadas module (T2): public/member reads of editions plus the admin
 * console for editions, itinerary, locations and daily messages. Mounted
 * under `/api` by `app.ts`. Announcements live in `modules/announcements`.
 */
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import cuencadaAdminRoutes from "./admin-routes.js";
import cuencadaContentRoutes from "./content-routes.js";
import dailyMessagesRoutes from "./daily-messages-routes.js";
import cuencadaPublicRoutes from "./public-routes.js";

/** Cuencada routes under `/api`. */
const cuencadasModule: FastifyPluginAsyncZod = async (app) => {
  await app.register(cuencadaPublicRoutes);
  await app.register(cuencadaAdminRoutes);
  await app.register(cuencadaContentRoutes);
  await app.register(dailyMessagesRoutes);
};

export default cuencadasModule;
