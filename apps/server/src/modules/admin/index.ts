/**
 * Admin module (T8) [SEC]: user management, the read-only audit log viewer
 * and the dashboard summary. Registered under `/api` by `app.ts`. Every route
 * is `auth: "admin"` and every mutation writes an audit row.
 *
 * See `docs/coordination/WP-T8-BE.md`.
 */
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import adminAuditRoutes from "./auditRoutes.js";
import adminSummaryRoutes from "./summaryRoutes.js";
import adminUserRoutes from "./userRoutes.js";

/** Admin routes under `/api`. */
const adminModule: FastifyPluginAsyncZod = async (app) => {
  await app.register(adminUserRoutes);
  await app.register(adminAuditRoutes);
  await app.register(adminSummaryRoutes);
};

export default adminModule;
