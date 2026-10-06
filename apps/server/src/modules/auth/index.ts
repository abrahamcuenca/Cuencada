/**
 * Auth module (T1) [SEC]: login, refresh-token rotation, logout, `/me`,
 * session management, change password, password reset, magic links and email
 * verification. Mounted under `/api` by `app.ts`.
 *
 * See `docs/coordination/WP-T1-BE.md` for the decisions behind each route.
 */
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import emailRoutes from "./emailRoutes.js";
import passwordRoutes from "./passwordRoutes.js";
import sessionRoutes from "./sessionRoutes.js";

/** Auth routes under `/api`. */
const authModule: FastifyPluginAsyncZod = async (app) => {
  await app.register(sessionRoutes);
  await app.register(passwordRoutes);
  await app.register(emailRoutes);
};

export default authModule;
