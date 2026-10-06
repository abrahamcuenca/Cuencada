import { type FeatureRoutes, MINIMAL_CHROME } from "../../shared/lib/featureRoutes";

/**
 * Auth and sessions routes, owned by T1. Every page is lazy-loaded. The auth
 * screens ask for minimal chrome (no BottomNav under 900px, wireframes §3).
 */
export const authRoutes: FeatureRoutes = {
  public: [
    { path: "/entrar", handle: MINIMAL_CHROME, lazy: async () => ({ Component: (await import("./pages/LoginPage")).LoginPage }) },
    { path: "/entrar/enlace", handle: MINIMAL_CHROME, lazy: async () => ({ Component: (await import("./pages/MagicLinkPage")).MagicLinkPage }) },
    { path: "/invitacion", handle: MINIMAL_CHROME, lazy: async () => ({ Component: (await import("./pages/InvitePage")).InvitePage }) },
    { path: "/recuperar", handle: MINIMAL_CHROME, lazy: async () => ({ Component: (await import("./pages/ForgotPasswordPage")).ForgotPasswordPage }) },
    { path: "/restablecer", handle: MINIMAL_CHROME, lazy: async () => ({ Component: (await import("./pages/ResetPasswordPage")).ResetPasswordPage }) },
    { path: "/verificar", handle: MINIMAL_CHROME, lazy: async () => ({ Component: (await import("./pages/VerifyEmailPage")).VerifyEmailPage }) }
  ],
  session: [
    { path: "/cambiar-contrasena", handle: MINIMAL_CHROME, lazy: async () => ({ Component: (await import("./pages/ChangePasswordPage")).ChangePasswordPage }) }
  ],
  member: [
    { path: "/perfil/sesiones", lazy: async () => ({ Component: (await import("./pages/SessionsPage")).SessionsPage }) }
  ]
};
