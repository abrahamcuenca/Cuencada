import type { ReactNode } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";
import { selectCurrentUser, selectIsAdmin } from "../features/auth/authSlice";
import { logout } from "../features/auth/session";
import { useAppDispatch, useAppSelector } from "./hooks";
import styles from "./layout.module.css";

// TODO(T2): point "Programa" at the current Cuencada from `GET /api/cuencadas/home`.
const PROGRAMA_PATH = "/cuencada/2026";

/** Mobile bottom tab bar (Inicio, Programa, Fotos, Chat, Más). Hidden at ≥900px. */
export function DefaultBottomNav(): ReactNode {
  return (
    <nav className={styles.bottomNav} aria-label="Navegación inferior">
      <NavLink to="/" end>
        Inicio
      </NavLink>
      <NavLink to={PROGRAMA_PATH}>Programa</NavLink>
      <NavLink to="/galeria">Fotos</NavLink>
      <NavLink to="/chat">Chat</NavLink>
      <NavLink to="/perfil">Más</NavLink>
    </nav>
  );
}

function SessionAction(): ReactNode {
  const dispatch = useAppDispatch();
  const user = useAppSelector(selectCurrentUser);

  if (user === null) {
    return (
      <Link className={styles.action} to="/entrar">
        Entrar
      </Link>
    );
  }
  return (
    <button
      type="button"
      className={styles.action}
      onClick={() => {
        void dispatch(logout());
      }}
    >
      Salir
    </button>
  );
}

/** Props of {@link AppLayout}. */
export interface AppLayoutProps {
  /** Replaces the default bottom tab bar (e.g. with the WP-0.7 `BottomNav`). */
  bottomNav?: ReactNode;
}

/**
 * App shell: sticky header (brand, top nav at ≥900px, Entrar/Salir), the
 * routed page in `<main>`, and a bottom tab bar slot for mobile.
 *
 * The Admin link appears only for users whose in-memory role is admin. That
 * is a UX hint, not access control; the server enforces the role.
 */
export function AppLayout({ bottomNav }: AppLayoutProps): ReactNode {
  const isAdmin = useAppSelector(selectIsAdmin);

  return (
    <div className={styles.layout}>
      <header className={styles.header}>
        <Link className={styles.brand} to="/">
          <img src="/images/Logo_Cuencada2026.jpg" alt="" width={40} height={40} />
          <span>Cuencada</span>
        </Link>
        <nav className={styles.topNav} aria-label="Navegación principal">
          <NavLink to={PROGRAMA_PATH}>Programa</NavLink>
          <NavLink to="/galeria">Galería</NavLink>
          <NavLink to="/directorio">Directorio</NavLink>
          <NavLink to="/arbol">Árbol</NavLink>
          <NavLink to="/chat">Chat</NavLink>
          {isAdmin ? <NavLink to="/admin">Admin</NavLink> : null}
        </nav>
        <SessionAction />
      </header>
      <main className={styles.main}>
        <Outlet />
      </main>
      {bottomNav ?? <DefaultBottomNav />}
    </div>
  );
}
