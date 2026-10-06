import type { FeatureRoutes } from "../../shared/lib/featureRoutes";

/**
 * Media gallery routes, owned by T4. Every page is lazy-loaded.
 * `/admin/media` is more specific than T8's `/admin/*`, so React Router ranks it first.
 */
export const galleryRoutes: FeatureRoutes = {
  member: [
    { path: "/galeria/:year?", lazy: async () => ({ Component: (await import("./pages/GalleryPage")).GalleryPage }) }
  ],
  admin: [
    { path: "/admin/media", lazy: async () => ({ Component: (await import("./admin/AdminMediaPage")).AdminMediaPage }) }
  ]
};
