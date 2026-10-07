import { lazy, type ReactNode, Suspense } from "react";
import { Link, Outlet, useLocation, useMatches } from "react-router-dom";
import {
  type SessionAudience,
  selectIsOffline,
  selectLogoutPending,
  selectSessionAudience,
  type WithAuthState
} from "../features/auth/authSlice";
import { logout } from "../features/auth/session";
import { type ChatUnreadBadge, useChatUnreadBadge } from "../features/chat/unread";
import { useGetCuencadaHomeQuery } from "../features/cuencadas/api";
import { PwaStatusMount } from "../features/pwa";
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
/** Mobile "Más" menu (Directorio, Árbol, Perfil, Sesiones, Panel, Cerrar sesión). */
export const MORE_PATH = "/mas";
/** Login page, the anonymous "Entrar" tab and button. */
export const LOGIN_NAV_PATH = "/entrar";
/** Visible label of the admin console link (TopNav). */
export const ADMIN_NAV_LABEL = "Panel";

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

/** The `badge`/`badgeLabel` of the Chat nav item, or nothing when there is no unread message. */
function chatBadgeProps(chatBadge: ChatUnreadBadge | undefined): Pick<NavItem, "badge" | "badgeLabel"> {
  if (chatBadge === undefined || chatBadge.count === 0 || chatBadge.label === undefined) return {};
  return { badge: chatBadge.count, badgeLabel: chatBadge.label };
}

/**
 * Mobile tab bar destinations for who is looking:
 * - `member`/`admin`: Inicio, Programa, Fotos, Chat, Más (admin entries live in /mas);
 * - `anonymous`: Inicio, Programa, Entrar (member pages would only bounce to /entrar);
 * - `pending` (session restoring at boot): Inicio, Programa, so a returning
 *   member never sees the anonymous tabs flash before their own.
 *
 * @param audience - From `selectSessionAudience`.
 * @param programaPath - `/cuencada/{year}` of the current or latest edition.
 * @param chatBadge - Unread chat messages for the "Chat" tab (T7).
 * @returns The BottomNav items.
 */
export function bottomNavItems(audience: SessionAudience, programaPath: string, chatBadge?: ChatUnreadBadge): readonly NavItem[] {
  const publicItems: NavItem[] = [
    { key: "inicio", label: "Inicio", href: "/", icon: "🏠", end: true },
    { key: "programa", label: "Programa", href: programaPath, icon: "📅" }
  ];
  switch (audience) {
    case "pending":
      return publicItems;
    case "anonymous":
      return [...publicItems, { key: "entrar", label: "Entrar", href: LOGIN_NAV_PATH, icon: "🔑" }];
    case "member":
    case "admin":
      return [
        ...publicItems,
        { key: "fotos", label: "Fotos", href: "/galeria", icon: "📸" },
        { key: "chat", label: "Chat", href: "/chat", icon: "💬", ...chatBadgeProps(chatBadge) },
        { key: "mas", label: "Más", href: MORE_PATH, icon: "☰" }
      ];
  }
}

/**
 * TopNav (≥900px) destinations for who is looking. The brand links home for
 * members; anonymous visitors also get an explicit "Inicio" next to "Programa".
 * The admin link ("Panel") is a UX hint only; the server enforces the role.
 *
 * @param audience - From `selectSessionAudience`.
 * @param programaPath - `/cuencada/{year}` of the current or latest edition.
 * @param chatBadge - Unread chat messages for the "Chat" link.
 * @returns The TopNav items.
 */
export function topNavItems(audience: SessionAudience, programaPath: string, chatBadge?: ChatUnreadBadge): readonly NavItem[] {
  const programa: NavItem = { key: "programa", label: "Programa", href: programaPath };
  switch (audience) {
    case "pending":
      return [programa];
    case "anonymous":
      return [{ key: "inicio", label: "Inicio", href: "/", end: true }, programa];
    case "member":
    case "admin": {
      const items: NavItem[] = [
        programa,
        { key: "galeria", label: "Galería", href: "/galeria" },
        { key: "directorio", label: "Directorio", href: "/directorio" },
        { key: "arbol", label: "Árbol", href: "/arbol" },
        { key: "chat", label: "Chat", href: "/chat", ...chatBadgeProps(chatBadge) }
      ];
      return audience === "admin" ? [...items, { key: "admin", label: ADMIN_NAV_LABEL, href: "/admin" }] : items;
    }
  }
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

function Brand(): ReactNode {
  return (
    <Link to="/" className={styles.brand}>
      <img src="/images/logo-96.webp" alt="" width={44} height={44} />
      <span>Cuencada</span>
    </Link>
  );
}

function SessionAction({ audience }: { audience: SessionAudience }): ReactNode {
  const dispatch = useAppDispatch();
  const { pathname } = useLocation();

  // Session still restoring: neither "Entrar" nor "Salir" yet (no flash of the wrong one).
  if (audience === "pending") return null;
  if (audience === "anonymous") {
    // Already on the login screens: an "Entrar" button there is noise.
    if (pathname === LOGIN_NAV_PATH || pathname.startsWith(`${LOGIN_NAV_PATH}/`)) return null;
    return (
      <Button to={LOGIN_NAV_PATH} size="sm">
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
 * The destinations depend on the session ({@link topNavItems},
 * {@link bottomNavItems}): public ones while it restores, plus "Entrar" for
 * anonymous visitors, the member destinations once logged in, and "Panel"
 * for admins. That is a UX hint, not access control; the server enforces
 * authentication and the role.
 */
export function AppLayout(): ReactNode {
  const { pathname } = useLocation();
  const audience = useAppSelector(selectSessionAudience);
  const showStatus = useAppSelector((state) => selectIsOffline(state) || selectLogoutPending(state));
  const showVerify = useAppSelector(selectNeedsEmailVerification);
  // Auth screens (route handle MINIMAL_CHROME) get no BottomNav; it is hidden at ≥900px anyway.
  const minimalChrome = useMatches().some((match) => wantsMinimalChrome(match.handle));
  const programaPath = useProgramaPath();
  const chatBadge = useChatUnreadBadge();

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
          items={topNavItems(audience, programaPath, chatBadge)}
          currentPath={pathname}
          renderLink={renderRouterLink}
          brand={<Brand />}
          actions={<SessionAction audience={audience} />}
        />
      }
      bottomNav={
        minimalChrome ? undefined : (
          <BottomNav items={bottomNavItems(audience, programaPath, chatBadge)} currentPath={pathname} renderLink={renderRouterLink} label="Navegación inferior" />
        )
      }
    >
      <Outlet />
      <PwaStatusMount />
    </PageShell>
  );
}
