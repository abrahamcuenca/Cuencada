import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { selectIsAdmin } from "../features/auth/authSlice";
import { logout } from "../features/auth/session";
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
  { to: "/perfil/sesiones", label: "Sesiones", icon: "🔐" }
];

const ADMIN_LINK: MoreLink = { to: "/admin", label: "Administración", icon: "⭐" };

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
            onClick={() => {
              dispatch(logout())
                .then(() => navigate("/", { replace: true }))
                .catch(reportUnexpected);
            }}
          >
            Cerrar sesión
          </Button>
        </li>
      </ul>
    </section>
  );
}
