/**
 * Invites module (T1) [SEC]: public inspect/accept (`/invites/*`) and admin
 * list/create/revoke/resend (`/admin/invites*`). Mounted under `/api`.
 */
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import adminInviteRoutes from "./adminRoutes.js";
import publicInviteRoutes from "./publicRoutes.js";

/** Invite routes under `/api`. */
const invitesModule: FastifyPluginAsyncZod = async (app) => {
  await app.register(publicInviteRoutes);
  await app.register(adminInviteRoutes);
};

export default invitesModule;
