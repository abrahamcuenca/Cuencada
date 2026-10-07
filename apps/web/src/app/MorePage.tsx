import { type ReactNode, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { selectIsAdmin } from "../features/auth/authSlice";
import { logout } from "../features/auth/session";
import { InstallAppCard } from "../features/pwa";
import { reportUnexpected } from "../shared/lib/reportUnexpected";
import { Button } from "../shared/ui/Button";
import { useAppDispatch, useAppSelector } from "./hooks";
import styles from "./more.module.css";

interface MoreLink {
  to: string;
  label: string;
  icon: string;
}

const MEMBER_LINKS: readonly MoreLink[] = [
  { to: "/directorio", label: "Directorio", icon: "🧭" },
  { to: "/arbol", label: "Árbol familiar", icon: "🌳" },
  { to: "/perfil", label: "Mi perfil", icon: "🙂" },
  { to: "/perfil/sesiones", label: "Sesiones y seguridad", icon: "🔐" }
];

/** Longest the logout waits for the navigation home before running anyway. */
export const LOGOUT_NAVIGATION_TIMEOUT_MS = 1500;

const ADMIN_LINK: MoreLink = { to: "/admin", label: "Panel de administración", icon: "⭐" };

/**
 * `/mas`: the mobile "Más" tab. Large tappable rows for destinations that
 * don't fit in the bottom bar, plus "Cerrar sesión". At ≥900px the TopNav
 * shows these links directly.
 *
 * The Admin row is a UX hint only; the server enforces the role.
 */
export function MorePage(): ReactNode {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const isAdmin = useAppSelector(selectIsAdmin);
  const links = isAdmin ? [...MEMBER_LINKS, ADMIN_LINK] : MEMBER_LINKS;
  const [leaving, setLeaving] = useState(false);
  const resolveLeft = useRef<(() => void) | null>(null);

  // Resolves the "page has left" promise when /mas unmounts (the new route committed,
  // or an error boundary replaced it).
  useEffect(
    () => () => {
      resolveLeft.current?.();
    },
    []
  );

  /**
   * "Cerrar sesión": leave the guarded /mas first, then log out, so RequireAuth's
   * /entrar redirect cannot race the navigation home. The logout waits for the
   * navigation to finish **and** this page to unmount (RR7 commits in a
   * transition, so the promise alone can settle before the old tree is gone), but
   * never longer than {@link LOGOUT_NAVIGATION_TIMEOUT_MS}: a slow chunk, a
   * blocker or a stuck navigation can delay the logout, never skip it.
   */
  const onLogout = async (): Promise<void> => {
    if (leaving) return;
    setLeaving(true);
    const left = new Promise<void>((resolve) => {
      resolveLeft.current = resolve;
    });
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, LOGOUT_NAVIGATION_TIMEOUT_MS));
    try {
      await Promise.race([Promise.resolve(navigate("/", { replace: true })).then(() => left), timeout]);
    } finally {
      dispatch(logout()).catch(reportUnexpected);
    }
  };

  return (
    <section className={styles.page}>
      <h1 className={styles.title}>Más</h1>
      <ul className={styles.list}>
        {links.map((link) => (
          <li key={link.to}>
            <Button to={link.to} variant="secondary" size="lg" fullWidth icon={link.icon} className={styles.row}>
              {link.label}
            </Button>
          </li>
        ))}
        <li className={styles.logout}>
          <Button
            variant="danger"
            size="lg"
            fullWidth
            loading={leaving}
            onClick={() => {
              onLogout().catch(reportUnexpected);
            }}
          >
            Cerrar sesión
          </Button>
        </li>
      </ul>
      <InstallAppCard />
    </section>
  );
}
