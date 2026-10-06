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
import { useGetCuencadaHomeQuery } from "../features/cuencadas/api";
import { wantsMinimalChrome } from "../shared/lib/featureRoutes";
import { reportUnexpected } from "../shared/lib/reportUnexpected";
// Direct imports (not the shared/ui barrel) keep unused primitives' CSS out of the initial chunk.
import { BottomNav } from "../shared/ui/BottomNav";
import { Button } from "../shared/ui/Button";
import { type NavItem, renderRouterLink } from "../shared/ui/nav";
import { PageShell } from "../shared/ui/PageShell";
import { TopNav } from "../shared/ui/TopNav";
import { useAppDispatch, useAppSelector } from "./hooks";
import styles from "./layout.module.css";

/** "Programa" before the home query answers (or when there is no edition yet). */
export const PROGRAMA_FALLBACK_PATH = "/";
/** Mobile "Más" menu (Directorio, Árbol, Perfil, Sesiones, Admin, Cerrar sesión). */
export const MORE_PATH = "/mas";

/** Shown while the server has not confirmed a logout. */
export const LOGOUT_PENDING_NOTICE =
  "Cerraste sesión en este dispositivo, pero no pudimos confirmarlo con el servidor. Se completará al reconectar.";
/** Shown while a refresh cannot reach the server. */
export const OFFLINE_NOTICE = "Sin conexión. Reintentaremos al volver la conexión.";

/** Renders nothing: what the banner becomes when its chunk cannot load. */
function NoBanner(): ReactNode {
  return null;
}

// Lazy: only unverified users ever download it (keeps authApi out of the initial chunk).
// Fails soft: a chunk that cannot load (offline, stale tab after a deploy) renders
// nothing instead of reaching the layout's error boundary and taking down the shell.
const VerifyEmailBanner = lazy(() =>
  import("../features/auth/components/VerifyEmailBanner").then(
    (module) => ({ default: module.VerifyEmailBanner }),
    (error: unknown) => {
      reportUnexpected(error);
      return { default: NoBanner };
    }
  )
);

/**
 * Mobile tab bar destinations (Inicio, Programa, Fotos, Chat, Más).
 *
 * @param programaPath - `/cuencada/{year}` of the current or latest edition.
 * @returns The five BottomNav items.
 */
export function bottomNavItems(programaPath: string): readonly NavItem[] {
  return [
    { key: "inicio", label: "Inicio", href: "/", icon: "🏠", end: true },
    { key: "programa", label: "Programa", href: programaPath, icon: "📅" },
    { key: "fotos", label: "Fotos", href: "/galeria", icon: "📸" },
    { key: "chat", label: "Chat", href: "/chat", icon: "💬" },
    { key: "mas", label: "Más", href: MORE_PATH, icon: "☰" }
  ];
}

function topNavItems(programaPath: string): NavItem[] {
  return [
    { key: "programa", label: "Programa", href: programaPath },
    { key: "galeria", label: "Galería", href: "/galeria" },
    { key: "directorio", label: "Directorio", href: "/directorio" },
    { key: "arbol", label: "Árbol", href: "/arbol" },
    { key: "chat", label: "Chat", href: "/chat" }
  ];
}

/**
 * The "Programa" destination: the featured (upcoming/live) edition, else the
 * latest past one, from the same cached `GET /cuencadas/home` the Home page
 * uses (one shared request). `/` while it loads or when there is none.
 */
function useProgramaPath(): string {
  const { data } = useGetCuencadaHomeQuery();
  const year = data?.featured?.year ?? data?.latestPast?.year;
  return year === undefined ? PROGRAMA_FALLBACK_PATH : `/cuencada/${year}`;
}

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
  const { pathname } = useLocation();

  if (user === null) {
    // Already on the login screens: an "Entrar" button there is noise.
    if (pathname === "/entrar" || pathname.startsWith("/entrar/")) return null;
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
  const programaPath = useProgramaPath();
  const topItems = isAdmin ? [...topNavItems(programaPath), ADMIN_NAV_ITEM] : topNavItems(programaPath);

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
          <BottomNav items={bottomNavItems(programaPath)} currentPath={pathname} renderLink={renderRouterLink} label="Navegación inferior" />
        )
      }
    >
      <Outlet />
    </PageShell>
  );
}
