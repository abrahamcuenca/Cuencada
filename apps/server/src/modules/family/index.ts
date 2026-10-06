/**
 * Family module (T6). Registered under `/api` by `app.ts`:
 * - `/family/*` (verified members): search, person, tree, self edit.
 * - `/admin/people*`, `/admin/relationships*` (admins): people CRUD,
 *   account linking and relationships with cycle prevention.
 */
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import adminFamilyRoutes from "./admin-routes.js";
import memberFamilyRoutes from "./member-routes.js";

/** Family routes under `/api`. */
const familyModule: FastifyPluginAsyncZod = async (app) => {
  await app.register(memberFamilyRoutes);
  await app.register(adminFamilyRoutes);
};

export default familyModule;
