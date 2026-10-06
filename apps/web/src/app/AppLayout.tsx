import type { ReactNode } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { selectCurrentUser, selectIsAdmin } from "../features/auth/authSlice";
import { logout } from "../features/auth/session";
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

/** Mobile tab bar destinations (Inicio, Programa, Fotos, Chat, Más). */
export const BOTTOM_NAV_ITEMS: readonly NavItem[] = [
  { key: "inicio", label: "Inicio", href: "/", icon: "🏠", end: true },
  { key: "programa", label: "Programa", href: PROGRAMA_PATH, icon: "📅" },
  { key: "fotos", label: "Fotos", href: "/galeria", icon: "📸" },
  { key: "chat", label: "Chat", href: "/chat", icon: "💬" },
  { key: "mas", label: "Más", href: "/perfil", icon: "☰" }
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
  const topItems = isAdmin ? [...TOP_NAV_ITEMS, ADMIN_NAV_ITEM] : TOP_NAV_ITEMS;

  return (
    <PageShell
      layout="bleed"
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
        <BottomNav
          items={BOTTOM_NAV_ITEMS}
          currentPath={pathname}
          renderLink={renderRouterLink}
          label="Navegación inferior"
        />
      }
    >
      <Outlet />
    </PageShell>
  );
}
