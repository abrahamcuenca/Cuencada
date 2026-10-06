import type { AdminSummary } from "@cuencada/types";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { formatDate } from "../../../shared/lib/dates";
import { Button } from "../../../shared/ui/Button";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { Skeleton } from "../../../shared/ui/Skeleton";
import { cx } from "../../../shared/ui/cx";
import { PORTAL_TIME_ZONE } from "../../auth/sessionDisplay";
import styles from "../admin.module.css";
import { useGetAdminSummaryQuery } from "../api";

/** One tappable counter. */
interface StatCard {
  key: string;
  value: number;
  label: string;
  to: string;
  /** Highlight when non-zero: something is waiting for an admin. */
  needsAttention?: boolean;
}

/**
 * @param summary - `GET /admin/summary`.
 * @returns The dashboard cards, in reading order.
 */
function statCards(summary: AdminSummary): StatCard[] {
  return [
    { key: "usersActive", value: summary.usersActive, label: "Usuarios activos", to: "/admin/usuarios?estado=active" },
    { key: "usersDisabled", value: summary.usersDisabled, label: "Usuarios deshabilitados", to: "/admin/usuarios?estado=disabled" },
    // The users list has no "unverified" filter; the rows carry a "Sin verificar" badge.
    { key: "usersUnverified", value: summary.usersUnverified, label: "Sin verificar correo", to: "/admin/usuarios?estado=active" },
    { key: "invitesPending", value: summary.invitesPending, label: "Invitaciones pendientes", to: "/admin/invitaciones?estado=pending" },
    { key: "mediaPendingReview", value: summary.mediaPendingReview, label: "Fotos por revisar", to: "/admin/media?cola=pending", needsAttention: true },
    { key: "mediaReported", value: summary.mediaReported, label: "Fotos reportadas", to: "/admin/media?cola=reported", needsAttention: true }
  ];
}

/** `/admin`: the dashboard. Counters come from one SQL statement on the server. */
export function DashboardPage(): ReactNode {
  const summary = useGetAdminSummaryQuery(undefined, { refetchOnMountOrArgChange: true });

  return (
    <>
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Administración</h1>
      </div>
      <section aria-labelledby="admin-resumen" className={styles.panel}>
        <h2 id="admin-resumen" className={styles.sectionTitle}>
          Resumen
        </h2>
        {summary.data === undefined ? (
          summary.isError ? (
            <EmptyState icon="⚠️" title="No pudimos cargar el resumen" action={<Button onClick={() => void summary.refetch()}>Reintentar</Button>} />
          ) : (
            <Skeleton shape="block" height="12rem" />
          )
        ) : (
          <>
            <ul className={styles.stats}>
              {statCards(summary.data).map((card) => (
                <li key={card.key}>
                  <Link to={card.to} className={cx(styles.stat, card.needsAttention === true && card.value > 0 && styles.statAlert)}>
                    <span className={styles.statValue}>{card.value.toLocaleString("es-MX")}</span>
                    <span className={styles.statLabel}>{card.label}</span>
                  </Link>
                </li>
              ))}
            </ul>
            <UpcomingEdition summary={summary.data} />
          </>
        )}
      </section>
    </>
  );
}

function UpcomingEdition({ summary }: { summary: AdminSummary }): ReactNode {
  const edition = summary.upcomingEdition;
  if (edition === null) {
    return (
      <p className={styles.muted}>
        No hay una próxima Cuencada publicada. <Link to="/admin/cuencadas">Ver Cuencadas</Link>
      </p>
    );
  }
  return (
    <Link to={`/admin/cuencadas/${encodeURIComponent(edition.cuencadaId)}/asistencia`} className={styles.edition}>
      <span className={styles.itemTitle}>
        RSVPs de la próxima Cuencada: {edition.title}
        {edition.title.includes(String(edition.year)) ? "" : ` (${edition.year})`}
      </span>
      <span className={styles.muted}>Empieza el {formatDate(edition.startsAt, PORTAL_TIME_ZONE)}</span>
      <span className={styles.rsvpCounts}>
        <span>
          <span aria-hidden="true">✅ </span>
          {edition.rsvpYes} sí
        </span>
        <span>
          <span aria-hidden="true">🤔 </span>
          {edition.rsvpMaybe} quizá
        </span>
        <span>
          <span aria-hidden="true">❌ </span>
          {edition.rsvpNo} no
        </span>
        <span>
          <span aria-hidden="true">➕ </span>
          {edition.rsvpGuests} acompañantes
        </span>
      </span>
      <span className={styles.muted}>Ver asistencia ›</span>
    </Link>
  );
}
