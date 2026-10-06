import type { FeatureRoutes } from "../../shared/lib/featureRoutes";

/** Profile routes, owned by T5. Every page is lazy-loaded. */
export const profileRoutes: FeatureRoutes = {
  member: [
    { path: "/perfil", lazy: async () => ({ Component: (await import("./pages/ProfilePage")).ProfilePage }) }
  ]
};
