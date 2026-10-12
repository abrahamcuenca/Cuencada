/**
 * `/admin/eventos` (admins, WP-5.4): every event, hidden and drafts
 * included (`GET /api/admin/events`), with "Ocultar" / "Mostrar" and
 * "Eliminar". Opening an event goes to its page, where admins have the full
 * organizer tools.
 */
import type { AdminEventSummary, EventStatus, EventVisibility } from "@cuencada/types";
import { type ReactNode, useId, useState } from "react";
import { Link } from "react-router-dom";
import { isAbortError } from "../../../shared/api/errors";
import { Button } from "../../../shared/ui/Button";
import { Dialog } from "../../../shared/ui/Dialog";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { Select } from "../../../shared/ui/Select";
import { Skeleton } from "../../../shared/ui/Skeleton";
import { useToast } from "../../../shared/ui/Toast";
import { cx } from "../../../shared/ui/cx";
import { type AdminEventFilter, useDeleteEventMutation, useListAdminEventsInfiniteQuery, useUpdateEventMutation } from "../api";
import { EventBadges } from "../components/EventBits";
import styles from "../events.module.css";
import { eventErrorMessage, eventPath, formatCardDates, participantCountLabel } from "../lib/format";

const STATUS_OPTIONS = [
  { value: "", label: "Todos los estados" },
  { value: "published", label: "Publicados" },
  { value: "draft", label: "Borradores" },
  { value: "hidden", label: "Ocultos" }
];
const VISIBILITY_OPTIONS = [
  { value: "", label: "Cualquier visibilidad" },
  { value: "members", label: "Todos los miembros" },
  { value: "participants", label: "Solo participantes" }
];

function isStatus(value: string): value is EventStatus {
  return value === "published" || value === "draft" || value === "hidden";
}

function isVisibility(value: string): value is EventVisibility {
  return value === "members" || value === "participants";
}

/** The admin list. */
export function AdminEventsPage(): ReactNode {
  const statusId = useId();
  const visibilityId = useId();
  const [status, setStatus] = useState("");
  const [visibility, setVisibility] = useState("");
  const filter: AdminEventFilter = { ...(isStatus(status) ? { status } : {}), ...(isVisibility(visibility) ? { visibility } : {}) };
  const { data, isLoading, isError, error, refetch, hasNextPage, fetchNextPage, isFetchingNextPage } = useListAdminEventsInfiniteQuery(filter);
  const events = data?.pages.flatMap((page) => page.items) ?? [];

  let content: ReactNode;
  if (isLoading) {
    content = <Skeleton shape="block" height="12rem" />;
  } else if (isError && data === undefined) {
    content = isAbortError(error) ? null : (
      <EmptyState
        icon="📡"
        title="No pudimos cargar los eventos"
        description="Revisa tu conexión e inténtalo de nuevo."
        action={
          <Button variant="secondary" onClick={() => void refetch()}>
            Reintentar
          </Button>
        }
      />
    );
  } else if (events.length === 0) {
    content = <EmptyState icon="🎉" title="No hay eventos con esos filtros" />;
  } else {
    content = (
      <ul className={styles.adminList} aria-label="Eventos">
        {events.map((event) => (
          <AdminEventRow key={event.id} event={event} />
        ))}
      </ul>
    );
  }

  return (
    <div className={cx("cu-container", styles.page)}>
      <Link to="/admin" className={styles.back}>
        ‹ Panel
      </Link>
      <h1 className={styles.title}>Eventos</h1>
      <p className={styles.intro}>Todos los eventos, también los borradores y los ocultos.</p>
      <div className={styles.filters}>
        <div className={styles.yearFilter}>
          <label htmlFor={statusId} className={styles.albumLabel}>
            Estado
          </label>
          <Select id={statusId} value={status} options={STATUS_OPTIONS} onChange={(e) => setStatus(e.target.value)} />
        </div>
        <div className={styles.yearFilter}>
          <label htmlFor={visibilityId} className={styles.albumLabel}>
            Visibilidad
          </label>
          <Select id={visibilityId} value={visibility} options={VISIBILITY_OPTIONS} onChange={(e) => setVisibility(e.target.value)} />
        </div>
      </div>
      {content}
      {hasNextPage ? (
        <div className={styles.more}>
          <Button variant="secondary" loading={isFetchingNextPage} onClick={() => void fetchNextPage()}>
            Cargar más
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function AdminEventRow({ event }: { event: AdminEventSummary }): ReactNode {
  const toast = useToast();
  const [update, updateState] = useUpdateEventMutation();
  const [remove, removeState] = useDeleteEventMutation();
  const [confirm, setConfirm] = useState<"hide" | "delete" | null>(null);
  const hidden = event.status === "hidden";

  const fail = (cause: unknown): void => {
    setConfirm(null);
    if (!isAbortError(cause)) toast.show({ message: eventErrorMessage(cause), tone: "danger" });
  };

  const onToggleHidden = (): void => {
    const status: EventStatus = hidden ? (event.firstPublishedAt === null ? "draft" : "published") : "hidden";
    update({ id: event.id, body: { status } })
      .unwrap()
      .then(() => {
        setConfirm(null);
        toast.show({ message: hidden ? `${event.title} ya no está oculto.` : `Ocultaste ${event.title}.`, tone: "success" });
      })
      .catch(fail);
  };

  const onDelete = (): void => {
    remove({ id: event.id })
      .unwrap()
      .then(() => {
        setConfirm(null);
        toast.show({ message: `Eliminaste ${event.title}.`, tone: "success" });
      })
      .catch(fail);
  };

  return (
    <li className={styles.adminRow}>
      <div className={styles.adminInfo}>
        <EventBadges event={event} />
        <h2 className={styles.adminTitle}>
          <Link to={eventPath(event)}>{event.title}</Link>
        </h2>
        <p className={styles.muted}>
          {formatCardDates(event)} · {participantCountLabel(event.participantCount)} · {event.mediaCount === 1 ? "1 foto" : `${event.mediaCount} fotos`}
        </p>
        <p className={styles.muted}>Creado por {event.createdByName ?? "una cuenta eliminada"}</p>
      </div>
      <div className={styles.inlineActions}>
        {hidden ? (
          <Button variant="secondary" size="sm" loading={updateState.isLoading} onClick={onToggleHidden}>
            Mostrar
          </Button>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => setConfirm("hide")}>
            Ocultar
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => setConfirm("delete")}>
          Eliminar
        </Button>
      </div>
      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        role="alertdialog"
        closeOnBackdrop={false}
        title={confirm === "delete" ? `¿Eliminar ${event.title}?` : `¿Ocultar ${event.title}?`}
        description={
          confirm === "delete"
            ? "Se borran el evento, su chat, sus álbumes y sus fotos. No se puede deshacer."
            : "Solo los administradores lo verán; quienes participan pierden el acceso al chat y a las fotos."
        }
        footer={
          <>
            <Button variant="danger" fullWidth loading={confirm === "delete" ? removeState.isLoading : updateState.isLoading} onClick={confirm === "delete" ? onDelete : onToggleHidden}>
              {confirm === "delete" ? "Eliminar evento" : "Ocultar evento"}
            </Button>
            <Button variant="secondary" fullWidth onClick={() => setConfirm(null)}>
              Cancelar
            </Button>
          </>
        }
      />
    </li>
  );
}
