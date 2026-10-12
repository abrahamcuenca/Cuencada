import type { FeatureRoutes } from "../../shared/lib/featureRoutes";

/**
 * Notifications routes (WP-6.1). The page is lazy-loaded; only the bell and
 * its unread count (`NotificationBell.tsx`, `api.ts`) are in the initial chunk.
 */
export const notificationsRoutes: FeatureRoutes = {
  member: [
    { path: "/notificaciones", lazy: async () => ({ Component: (await import("./pages/NotificationsPage")).NotificationsPage }) }
  ]
};
