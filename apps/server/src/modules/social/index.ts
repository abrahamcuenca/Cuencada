/**
 * Photo social module (WP-6.2, ADR 0001 §8): tags, hearts, comments,
 * "Fotos de {persona}" and the admin comment queue. Registered under `/api`
 * by the media module (photos and their social data share one scope rule).
 *
 * Exports {@link moveMediaTagsTx} for WP-6.4's `mergePeopleTx`.
 */
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import adminSocialRoutes from "./adminRoutes.js";
import socialRoutes from "./routes.js";

export { type MoveMediaTagsResult, moveMediaTagsTx } from "./tags.js";

/** Social routes under `/api`. */
const socialModule: FastifyPluginAsyncZod = async (app) => {
  await app.register(socialRoutes);
  await app.register(adminSocialRoutes);
};

export default socialModule;
