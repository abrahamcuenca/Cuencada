import { lazy, type ReactNode, Suspense } from "react";
import { Link, Outlet, useLocation, useMatches } from "react-router-dom";
import {
  selectCurrentUser,
  selectIsAdmin,
  selectIsOffline,
  selectLogoutPending,
  type WithAuthState
} from "../features/auth/authSlice";
import { logout } from "../features/auth/session";
import { wantsMinimalChrome } from "../shared/lib/featureRoutes";
// Direct imports (not the shared/ui barrel) keep unused primitives' CSS out of the initial chunk.
import { BottomNav } from "../shared/ui/BottomNav";
import { Button } from "../shared/ui/Button";
import { type NavItem, renderRouterLink } from "../shared/ui/nav";
import { PageShell } from "../shared/ui/PageShell";
import { TopNav } from "../shared/ui/TopNav";
import { useAppDispatch, useAppSelector } from "./hooks";
import styles from "./layout.module.css";

// TODO(T2): point "Programa" at the current Cuencada from `GET /api/cuencadas/home`.
const PROGRAMA_PATH = "/cuencada/2026";
/** Mobile "Más" menu (Directorio, Árbol, Perfil, Sesiones, Admin, Cerrar sesión). */
export const MORE_PATH = "/mas";

/** Shown while the server has not confirmed a logout. */
export const LOGOUT_PENDING_NOTICE =
  "Cerraste sesión en este dispositivo, pero no pudimos confirmarlo con el servidor. Se completará al reconectar.";
/** Shown while a refresh cannot reach the server. */
export const OFFLINE_NOTICE = "Sin conexión. Reintentaremos al volver la conexión.";

// Lazy: only unverified users ever download it (keeps authApi out of the initial chunk).
const VerifyEmailBanner = lazy(async () => ({
  default: (await import("../features/auth/components/VerifyEmailBanner")).VerifyEmailBanner
}));

/** Mobile tab bar destinations (Inicio, Programa, Fotos, Chat, Más). */
export const BOTTOM_NAV_ITEMS: readonly NavItem[] = [
  { key: "inicio", label: "Inicio", href: "/", icon: "🏠", end: true },
  { key: "programa", label: "Programa", href: PROGRAMA_PATH, icon: "📅" },
  { key: "fotos", label: "Fotos", href: "/galeria", icon: "📸" },
  { key: "chat", label: "Chat", href: "/chat", icon: "💬" },
  { key: "mas", label: "Más", href: MORE_PATH, icon: "☰" }
];

const TOP_NAV_ITEMS: readonly NavItem[] = [
  { key: "programa", label: "Programa", href: PROGRAMA_PATH },
  { key: "galeria", label: "Galería", href: "/galeria" },
  { key: "directorio", label: "Directorio", href: "/directorio" },
  { key: "arbol", label: "Árbol", href: "/arbol" },
  { key: "chat", label: "Chat", href: "/chat" }
];

const ADMIN_NAV_ITEM: NavItem = { key: "admin", label: "Admin", href: "/admin" };

function Brand(): ReactNode {
  return (
    <Link to="/" className={styles.brand}>
      <img src="/images/logo-96.webp" alt="" width={44} height={44} />
      <span>Cuencada</span>
    </Link>
  );
}

function SessionAction(): ReactNode {
  const dispatch = useAppDispatch();
  const user = useAppSelector(selectCurrentUser);

  if (user === null) {
    return (
      <Button to="/entrar" size="sm">
        Entrar
      </Button>
    );
  }
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => {
        void dispatch(logout());
      }}
    >
      Salir
    </Button>
  );
}

function StatusBanner(): ReactNode {
  const isOffline = useAppSelector(selectIsOffline);
  const logoutPending = useAppSelector(selectLogoutPending);
  if (logoutPending) return <output>{LOGOUT_PENDING_NOTICE}</output>;
  if (isOffline) return <output>{OFFLINE_NOTICE}</output>;
  return null;
}

/** True for a logged-in user whose email is not verified yet (shows the T1 banner). */
function selectNeedsEmailVerification(state: WithAuthState): boolean {
  return state.auth.status === "authenticated" && state.auth.user?.emailVerified === false;
}

/**
 * App shell built on the WP-0.7 primitives: `TopNav` (brand, links at
 * ≥900px, Entrar/Salir), the routed page inside `PageShell`'s `<main>`, and
 * the mobile `BottomNav`.
 *
 * The Admin link appears only when the in-memory role is admin. That is a UX
 * hint, not access control; the server enforces the role.
 */
export function AppLayout(): ReactNode {
  const { pathname } = useLocation();
  const isAdmin = useAppSelector(selectIsAdmin);
  const showStatus = useAppSelector((state) => selectIsOffline(state) || selectLogoutPending(state));
  const showVerify = useAppSelector(selectNeedsEmailVerification);
  // Auth screens (route handle MINIMAL_CHROME) get no BottomNav; it is hidden at ≥900px anyway.
  const minimalChrome = useMatches().some((match) => wantsMinimalChrome(match.handle));
  const topItems = isAdmin ? [...TOP_NAV_ITEMS, ADMIN_NAV_ITEM] : TOP_NAV_ITEMS;

  return (
    <PageShell
      layout="bleed"
      banner={
        showStatus || showVerify ? (
          <>
            {showStatus ? <StatusBanner /> : null}
            {showVerify ? (
              <Suspense fallback={null}>
                <VerifyEmailBanner />
              </Suspense>
            ) : null}
          </>
        ) : undefined
      }
      header={
        <TopNav
          items={topItems}
          currentPath={pathname}
          renderLink={renderRouterLink}
          brand={<Brand />}
          actions={<SessionAction />}
        />
      }
      bottomNav={
        minimalChrome ? undefined : (
          <BottomNav items={BOTTOM_NAV_ITEMS} currentPath={pathname} renderLink={renderRouterLink} label="Navegación inferior" />
        )
      }
    >
      <Outlet />
    </PageShell>
  );
}
