import type { FeatureRoutes } from "../../shared/lib/featureRoutes";

/**
 * Events routes (WP-5.4). Every page is lazy-loaded, so nothing here adds to
 * the initial bundle. `/admin/eventos` is more specific than the admin
 * feature's `/admin/*`, so React Router ranks it first (like `/admin/media`).
 */
export const eventsRoutes: FeatureRoutes = {
  member: [
    { path: "/eventos", lazy: async () => ({ Component: (await import("./pages/EventsPage")).EventsPage }) },
    { path: "/eventos/:year/:slug", lazy: async () => ({ Component: (await import("./pages/EventDetailPage")).EventDetailPage }) }
  ],
  admin: [{ path: "/admin/eventos", lazy: async () => ({ Component: (await import("./admin/AdminEventsPage")).AdminEventsPage }) }]
};
