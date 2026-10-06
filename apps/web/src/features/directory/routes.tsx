import type { FeatureRoutes } from "../../shared/lib/featureRoutes";

/** Family directory routes, owned by T5. Every page is lazy-loaded. */
export const directoryRoutes: FeatureRoutes = {
  member: [
    { path: "/directorio/:userId?", lazy: async () => ({ Component: (await import("./pages/DirectoryPage")).DirectoryPage }) }
  ]
};
