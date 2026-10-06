import type { FeatureRoutes } from "../../shared/lib/featureRoutes";

/** Admin console (`/admin/*` lets the admin page own nested routes) routes, owned by T8. Every page is lazy-loaded. */
export const adminRoutes: FeatureRoutes = {
  admin: [
    { path: "/admin/*", lazy: async () => ({ Component: (await import("./pages/AdminPage")).AdminPage }) }
  ]
};
