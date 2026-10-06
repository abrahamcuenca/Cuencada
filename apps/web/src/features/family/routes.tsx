import type { FeatureRoutes } from "../../shared/lib/featureRoutes";

/** Family tree routes, owned by T6. Every page is lazy-loaded. */
export const familyRoutes: FeatureRoutes = {
  member: [
    { path: "/arbol/:personId?", lazy: async () => ({ Component: (await import("./pages/FamilyTreePage")).FamilyTreePage }) }
  ]
};
