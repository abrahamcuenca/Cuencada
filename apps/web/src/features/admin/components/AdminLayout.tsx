import type { ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { cx } from "../../../shared/ui/cx";
import styles from "../admin.module.css";

/** One section of the admin console. */
interface AdminSection {
  to: string;
  icon: string;
  label: string;
  hint: string;
  /** Match only this exact path (the dashboard). */
  end?: boolean;
}

/**
 * Admin sections. Cuencadas, Asistencia, Fotos and Personas belong to other
 * tracks (T2, T3, T4, T6); this console only links to them. Asistencia is per
 * edition (`/admin/cuencadas/:id/asistencia`), so it opens from Cuencadas.
 */
export const ADMIN_SECTIONS: readonly AdminSection[] = [
  { to: "/admin", icon: "🏠", label: "Resumen", hint: "Pendientes y números del portal", end: true },
  { to: "/admin/cuencadas", icon: "📅", label: "Cuencadas", hint: "Ediciones, itinerario, lugares y avisos" },
  { to: "/admin/cuencadas", icon: "✅", label: "Asistencia", hint: "Ábrela desde cada Cuencada" },
  { to: "/admin/media", icon: "📷", label: "Fotos", hint: "Revisar y moderar fotos" },
  { to: "/admin/familia", icon: "🌳", label: "Personas y árbol", hint: "Familia, parentescos y cuentas" },
  { to: "/admin/invitaciones", icon: "💌", label: "Invitaciones", hint: "Invitar por correo o enlace" },
  { to: "/admin/usuarios", icon: "👥", label: "Usuarios", hint: "Roles, acceso y sesiones" },
  { to: "/admin/bitacora", icon: "📜", label: "Bitácora", hint: "Quién cambió qué y cuándo" }
];

/** The section list: large rows on phones, a sidebar at ≥900px. */
export function AdminNav(): ReactNode {
  return (
    <>
      <h2 className={styles.navTitle}>Secciones</h2>
      <ul className={styles.navList}>
        {ADMIN_SECTIONS.map((section) => (
          <li key={section.label}>
            <NavLink to={section.to} end={section.end === true} className={cx(styles.navLink)}>
              <span aria-hidden="true" className={styles.navIcon}>
                {section.icon}
              </span>
              <span className={styles.navText}>
                <span className={styles.navLabel}>{section.label}</span>
                <span className={styles.navHint}>{section.hint}</span>
              </span>
              <span aria-hidden="true" className={styles.chevron}>
                ›
              </span>
            </NavLink>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * Shell of the T8 admin pages (`/admin`, invitaciones, usuarios, bitácora).
 * On phones the dashboard lists the sections under its cards and the other
 * pages show "‹ Panel"; at ≥900px the sections are a sidebar.
 */
export function AdminLayout(): ReactNode {
  const { pathname } = useLocation();
  const isDashboard = pathname === "/admin" || pathname === "/admin/";
  return (
    <div className={cx("cu-container", styles.layout)}>
      <nav aria-label="Secciones de administración" className={isDashboard ? styles.sidebar : styles.sidebarDesktopOnly}>
        <AdminNav />
      </nav>
      <div className={styles.content}>
        {isDashboard ? null : (
          <Link to="/admin" className={styles.back}>
            ‹ Panel
          </Link>
        )}
        <Outlet />
      </div>
    </div>
  );
}
