import type { FeatureRoutes } from "../../shared/lib/featureRoutes";

/**
 * Memory Box routes (WP-6.3, "Baúl de recuerdos"). Every page is
 * lazy-loaded, so nothing here adds to the initial bundle.
 * `/admin/recuerdos` is more specific than the admin feature's `/admin/*`,
 * so React Router ranks it first (like `/admin/eventos`).
 */
export const memoriesRoutes: FeatureRoutes = {
  member: [
    { path: "/recuerdos", lazy: async () => ({ Component: (await import("./pages/MemoriesPage")).MemoriesPage }) },
    { path: "/recuerdos/:id", lazy: async () => ({ Component: (await import("./pages/MemoryAlbumPage")).MemoryAlbumPage }) }
  ],
  admin: [{ path: "/admin/recuerdos", lazy: async () => ({ Component: (await import("./admin/AdminMemoriesPage")).AdminMemoriesPage }) }]
};
