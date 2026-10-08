/**
 * Family module (T6). Registered under `/api` by `app.ts`:
 * - `/family/*` (verified members): search, person, tree, self edit.
 * - `/family/people/:id/photo*` (verified members; WP-4.3): tree photos.
 * - `/admin/people*`, `/admin/relationships*` (admins): people CRUD,
 *   account linking and relationships with cycle prevention.
 */
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import adminFamilyRoutes from "./admin-routes.js";
import memberFamilyRoutes from "./member-routes.js";
import personPhotoRoutes from "./photo-routes.js";

/** Family routes under `/api`. */
const familyModule: FastifyPluginAsyncZod = async (app) => {
  await app.register(memberFamilyRoutes);
  await app.register(adminFamilyRoutes);
  await app.register(personPhotoRoutes);
};

export default familyModule;
