import type { FeatureRoutes } from "../../shared/lib/featureRoutes";

/** Media gallery routes, owned by T4. Every page is lazy-loaded. */
export const galleryRoutes: FeatureRoutes = {
  member: [
    { path: "/galeria/:year?", lazy: async () => ({ Component: (await import("./pages/GalleryPage")).GalleryPage }) }
  ]
};
