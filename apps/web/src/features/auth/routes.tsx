import type { FeatureRoutes } from "../../shared/lib/featureRoutes";

/** Auth and sessions routes, owned by T1. Every page is lazy-loaded. */
export const authRoutes: FeatureRoutes = {
  public: [
    { path: "/entrar", lazy: async () => ({ Component: (await import("./pages/LoginPage")).LoginPage }) },
    { path: "/entrar/enlace", lazy: async () => ({ Component: (await import("./pages/MagicLinkPage")).MagicLinkPage }) },
    { path: "/invitacion", lazy: async () => ({ Component: (await import("./pages/InvitePage")).InvitePage }) },
    { path: "/recuperar", lazy: async () => ({ Component: (await import("./pages/ForgotPasswordPage")).ForgotPasswordPage }) },
    { path: "/restablecer", lazy: async () => ({ Component: (await import("./pages/ResetPasswordPage")).ResetPasswordPage }) }
  ],
  session: [
    { path: "/cambiar-contrasena", lazy: async () => ({ Component: (await import("./pages/ChangePasswordPage")).ChangePasswordPage }) }
  ],
  member: [
    { path: "/perfil/sesiones", lazy: async () => ({ Component: (await import("./pages/SessionsPage")).SessionsPage }) }
  ]
};
