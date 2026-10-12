/**
 * Auth module (T1) [SEC]: login, refresh-token rotation, logout, `/me`,
 * session management, change password, password reset, magic links, email
 * verification and two-step verification (WP-7). Mounted under `/api` by `app.ts`.
 *
 * See `docs/coordination/WP-T1-BE.md` for the decisions behind each route.
 */
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { registerAuthCleanup } from "./cleanup.js";
import emailRoutes from "./emailRoutes.js";
import { registerMailQueue } from "./mailQueue.js";
import passwordRoutes from "./passwordRoutes.js";
import sessionRoutes from "./sessionRoutes.js";
import twoFactorRoutes from "./twoFactorRoutes.js";

/** Auth routes under `/api`. */
const authModule: FastifyPluginAsyncZod = async (app) => {
  registerMailQueue(app);
  registerAuthCleanup(app);
  await app.register(sessionRoutes);
  await app.register(passwordRoutes);
  await app.register(emailRoutes);
  await app.register(twoFactorRoutes);
};

export default authModule;
