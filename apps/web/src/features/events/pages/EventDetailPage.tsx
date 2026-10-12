/**
 * `/eventos/:year/:slug` (members, WP-5.4): the hero (cover, title, dates or
 * "Por anunciar", place, organizers), "Me apunto" / "Salir del evento", and
 * the tabs Detalles · Chat · Fotos. Organizers and admins get the
 * "Organización" tools (edit, people, albums, cover, publish; hide and slug
 * for admins; delete per the rules).
 *
 * [SEC] A malformed address, a missing event and an event the member cannot
 * see all render the same {@link EventNotFound} screen.
 */
import { type EventDetail, eventPathParamsSchema } from "@cuencada/types";
import { type ReactNode, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useAppSelector } from "../../../app/hooks";
import { isAbortError, isFetchBaseQueryError } from "../../../shared/api/errors";
import { Button } from "../../../shared/ui/Button";
import { Dialog } from "../../../shared/ui/Dialog";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { Skeleton } from "../../../shared/ui/Skeleton";
import { Tabs } from "../../../shared/ui/Tabs";
import { useToast } from "../../../shared/ui/Toast";
import { cx } from "../../../shared/ui/cx";
import { useAccessDenial } from "../../auth/accessDenied";
import { selectIsAdmin } from "../../auth/authSlice";
import { AccessDeniedState } from "../../auth/components/AccessDeniedState";
import { roomRemovedMessage, useRoomRemoved } from "../../chat/lib/useRoomRemoved";
import { useDeleteEventMutation, useGetEventQuery, useJoinEventMutation, useLeaveEventMutation, useUpdateEventMutation } from "../api";
import { AlbumsSheet } from "../components/AlbumsSheet";
import { CoverEditor } from "../components/CoverEditor";
import { EventBadges, EventCover, EventNotFound } from "../components/EventBits";
import { EventChatTab } from "../components/EventChatTab";
import { EventFormSheet } from "../components/EventFormSheet";
import { EventPhotosTab } from "../components/EventPhotosTab";
import { ParticipantsSection, ParticipantsSheet } from "../components/Participants";
import styles from "../events.module.css";
import { eventErrorMessage, formatEventDates, LAST_ORGANIZER_NOTE } from "../lib/format";

/** Tabs of the event page; the active one is kept in `?vista=`. */
const TAB_IDS = ["detalles", "chat", "fotos"] as const;
type TabId = (typeof TAB_IDS)[number];

function isTabId(value: string | null): value is TabId {
  return value !== null && (TAB_IDS as readonly string[]).includes(value);
}

/** The page: validates the address, then loads the event. */
export function EventDetailPage(): ReactNode {
  const params = useParams();
  const parsed = eventPathParamsSchema.safeParse({ year: params.year, slug: params.slug });
  if (!parsed.success) return <EventNotFound />;
  return <EventLoader key={`${parsed.data.year}/${parsed.data.slug}`} year={parsed.data.year} slug={parsed.data.slug} />;
}

function errorStatus(error: unknown): number | string | null {
  return isFetchBaseQueryError(error) ? error.status : null;
}

function EventLoader({ year, slug }: { year: number; slug: string }): ReactNode {
  const { data: event, error, isLoading, isError, refetch } = useGetEventQuery({ year, slug });
  const denial = useAccessDenial(error);
  if (isLoading) return <DetailSkeleton />;
  if (event === undefined || (isError && errorStatus(error) === 404)) {
    if (isError && isAbortError(error)) return null;
    const status = errorStatus(error);
    // 404 (missing or invisible) and 400 (malformed) look the same [SEC].
    if (status === 404 || status === 400) return <EventNotFound />;
    if (denial !== null) {
      return (
        <div className={cx("cu-container", styles.page)}>
          <AccessDeniedState denial={denial} headingLevel={1} verifyTitle="Verifica tu correo para ver los eventos" forbiddenTitle="No tienes acceso a los eventos" />
        </div>
      );
    }
    return (
      <div className={cx("cu-container", styles.page)}>
        <EmptyState
          icon="📡"
          headingLevel={1}
          title="No pudimos cargar el evento"
          description="Revisa tu conexión e inténtalo de nuevo."
          action={
            <Button variant="secondary" onClick={() => void refetch()}>
              Reintentar
            </Button>
          }
        />
      </div>
    );
  }
  return <EventView event={event} onRefetch={() => void refetch()} />;
}

function DetailSkeleton(): ReactNode {
  return (
    <div className={cx("cu-container", styles.page)} aria-busy="true">
      <span className="visually-hidden">Cargando evento…</span>
      <Skeleton shape="block" height="12rem" />
      <Skeleton shape="text" width="70%" />
      <Skeleton shape="text" width="40%" />
    </div>
  );
}

/** "Organiza: Rosa y Tomás". */
function organizersLine(event: EventDetail): string | null {
  const names = event.participants.filter((p) => p.role === "organizer").map((p) => p.displayName);
  if (names.length === 0) return null;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} y ${names.at(-1)}`;
  return `${names.length === 1 ? "Organiza" : "Organizan"}: ${list}`;
}

function EventView({ event, onRefetch }: { event: EventDetail; onRefetch: () => void }): ReactNode {
  const navigate = useNavigate();
  const toast = useToast();
  const [search, setSearch] = useSearchParams();
  const requested = search.get("vista");
  // WP-6.2: a `?foto=<id>` link (notification, shared photo) lands on the photos tab.
  const tab: TabId = isTabId(requested) ? requested : search.has("foto") ? "fotos" : "detalles";
  const [join, joinState] = useJoinEventMutation();
  const [leave, leaveState] = useLeaveEventMutation();
  const [confirmLeave, setConfirmLeave] = useState(false);

  const setTab = (next: string): void => {
    const params = new URLSearchParams(search);
    if (next === "detalles") params.delete("vista");
    else params.set("vista", next);
    setSearch(params, { replace: true });
  };

  // Lost access to the event's chat (removed, hidden, made participants-only…): say so and reload the event.
  useRoomRemoved((roomId) => {
    if (roomId !== event.chatRoomId) return;
    toast.show({ message: roomRemovedMessage(event.title), tone: "info" });
    setTab("detalles");
    onRefetch();
  });

  const onJoin = (): void => {
    join({ id: event.id })
      .unwrap()
      .then(() => toast.show({ message: `¡Te apuntaste a ${event.title}!`, tone: "success" }))
      .catch((cause: unknown) => {
        if (!isAbortError(cause)) toast.show({ message: eventErrorMessage(cause), tone: "danger" });
      });
  };

  const onLeave = (): void => {
    leave({ id: event.id })
      .unwrap()
      .then(() => {
        setConfirmLeave(false);
        toast.show({ message: `Saliste de ${event.title}.`, tone: "success" });
        // A participants-only event (or a draft) is no longer visible once you leave it.
        if ((event.visibility === "participants" || event.status === "draft") && !event.canManage) navigate("/eventos", { replace: true });
        else setTab("detalles");
      })
      .catch((cause: unknown) => {
        setConfirmLeave(false);
        if (!isAbortError(cause)) toast.show({ message: eventErrorMessage(cause), tone: "danger" });
      });
  };

  const organizers = organizersLine(event);
  const lastOrganizer = event.viewerRole === "organizer" && !event.canLeave;

  return (
    <article className={cx("cu-container", styles.page)}>
      <header className={styles.hero}>
        <EventCover url={event.coverUrl} variant="hero" onError={onRefetch} />
        <div className={styles.heroText}>
          <EventBadges event={event} />
          <h1 className={styles.title}>{event.title}</h1>
          <p className={styles.heroMeta}>
            <span aria-hidden="true">📅 </span>
            {formatEventDates(event)}
          </p>
          {event.locationText !== null ? (
            <p className={styles.heroMeta}>
              <span aria-hidden="true">📍 </span>
              {event.locationText}
            </p>
          ) : null}
          {organizers !== null ? <p className={styles.muted}>{organizers}</p> : null}
        </div>
        <div className={styles.heroActions}>
          {event.canJoin ? (
            <Button size="lg" icon="🙋" loading={joinState.isLoading} onClick={onJoin}>
              Me apunto
            </Button>
          ) : null}
          {event.viewerRole !== null && event.canLeave ? (
            <Button variant="secondary" onClick={() => setConfirmLeave(true)}>
              Salir del evento
            </Button>
          ) : null}
          {lastOrganizer ? <p className={styles.note}>{LAST_ORGANIZER_NOTE}</p> : null}
        </div>
      </header>

      {event.canManage ? <ManagePanel event={event} /> : null}

      <Tabs
        label="Secciones del evento"
        variant="underline"
        value={tab}
        onChange={setTab}
        className={styles.tabs}
        items={[
          { id: "detalles", label: "Detalles", content: <DetailsTab event={event} /> },
          { id: "chat", label: "Chat", content: <EventChatTab event={event} onJoin={onJoin} joining={joinState.isLoading} /> },
          { id: "fotos", label: "Fotos", content: <EventPhotosTab event={event} onJoin={onJoin} joining={joinState.isLoading} /> }
        ]}
      />

      <Dialog
        open={confirmLeave}
        onClose={() => setConfirmLeave(false)}
        role="alertdialog"
        closeOnBackdrop={false}
        title={`¿Salir de ${event.title}?`}
        description={
          event.visibility === "participants"
            ? "Dejarás de ver el evento, su chat y sus fotos. Para volver, alguien que lo organiza tendrá que agregarte."
            : "Dejarás de ver el chat y las fotos. Puedes volver a apuntarte cuando quieras."
        }
        footer={
          <>
            <Button variant="danger" fullWidth loading={leaveState.isLoading} onClick={onLeave}>
              Salir del evento
            </Button>
            <Button variant="secondary" fullWidth onClick={() => setConfirmLeave(false)}>
              Cancelar
            </Button>
          </>
        }
      />
    </article>
  );
}

function DetailsTab({ event }: { event: EventDetail }): ReactNode {
  return (
    <div className={styles.details}>
      {event.summary !== null ? <p className={styles.lead}>{event.summary}</p> : null}
      {event.details !== null ? (
        <section className={styles.block} aria-labelledby="evento-detalles">
          <h2 id="evento-detalles" className={styles.blockTitle}>
            Detalles
          </h2>
          <p className={styles.detailsText}>{event.details}</p>
        </section>
      ) : null}
      {event.summary === null && event.details === null ? <p className={styles.muted}>Todavía no hay más detalles.</p> : null}
      <ParticipantsSection event={event} />
    </div>
  );
}

type Sheet = "edit" | "people" | "albums" | "delete" | "hide" | null;

/** Organizers and admins: the event's tools. Every button is a UX hint; the server checks again. */
function ManagePanel({ event }: { event: EventDetail }): ReactNode {
  const isAdmin = useAppSelector(selectIsAdmin);
  const navigate = useNavigate();
  const toast = useToast();
  const [sheet, setSheet] = useState<Sheet>(null);
  const [update, updateState] = useUpdateEventMutation();
  const [remove, removeState] = useDeleteEventMutation();
  const close = (): void => setSheet(null);

  const setStatus = (status: "draft" | "published" | "hidden", message: string): void => {
    update({ id: event.id, body: { status } })
      .unwrap()
      .then(() => {
        close();
        toast.show({ message, tone: "success" });
      })
      .catch((cause: unknown) => {
        close();
        if (!isAbortError(cause)) toast.show({ message: eventErrorMessage(cause), tone: "danger" });
      });
  };

  const onDelete = (): void => {
    remove({ id: event.id })
      .unwrap()
      .then(() => {
        close();
        toast.show({ message: `Eliminaste ${event.title}.`, tone: "success" });
        navigate("/eventos", { replace: true });
      })
      .catch((cause: unknown) => {
        close();
        if (!isAbortError(cause)) toast.show({ message: eventErrorMessage(cause), tone: "danger" });
      });
  };

  // Unhide goes back to where it was before hiding: published if it ever was, else a draft.
  const unhideStatus = event.firstPublishedAt === null ? "draft" : "published";

  return (
    <section className={styles.manage} aria-labelledby="evento-organizacion">
      <h2 id="evento-organizacion" className={styles.blockTitle}>
        Organización
      </h2>
      {event.status === "draft" ? <p className={styles.note}>Es un borrador: solo lo ven quienes lo organizan y los administradores.</p> : null}
      {event.status === "hidden" ? <p className={styles.note}>Está oculto: solo lo ven los administradores.</p> : null}
      <div className={styles.manageButtons}>
        <Button variant="secondary" size="sm" icon="✏️" onClick={() => setSheet("edit")}>
          Editar evento
        </Button>
        <Button variant="secondary" size="sm" icon="👥" onClick={() => setSheet("people")}>
          Personas
        </Button>
        <Button variant="secondary" size="sm" icon="🖼️" onClick={() => setSheet("albums")}>
          Álbumes
        </Button>
        {event.status === "draft" ? (
          <Button size="sm" icon="📣" loading={updateState.isLoading} onClick={() => setStatus("published", "Evento publicado.")}>
            Publicar
          </Button>
        ) : null}
        {event.status === "published" ? (
          <Button variant="ghost" size="sm" loading={updateState.isLoading} onClick={() => setStatus("draft", "El evento volvió a ser borrador.")}>
            Pasar a borrador
          </Button>
        ) : null}
        {isAdmin && event.status !== "hidden" ? (
          <Button variant="ghost" size="sm" icon="🙈" onClick={() => setSheet("hide")}>
            Ocultar
          </Button>
        ) : null}
        {isAdmin && event.status === "hidden" ? (
          <Button variant="secondary" size="sm" icon="👁️" loading={updateState.isLoading} onClick={() => setStatus(unhideStatus, "El evento ya no está oculto.")}>
            Mostrar
          </Button>
        ) : null}
        {event.canDelete ? (
          <Button variant="danger" size="sm" icon="🗑️" onClick={() => setSheet("delete")}>
            Eliminar
          </Button>
        ) : null}
      </div>
      <CoverEditor event={event} />

      {sheet === "edit" ? <EventFormSheet key={`edit-${event.id}-${event.updatedAt}`} open event={event} onClose={close} /> : null}
      <ParticipantsSheet event={event} open={sheet === "people"} onClose={close} />
      <AlbumsSheet event={event} open={sheet === "albums"} onClose={close} />
      <Dialog
        open={sheet === "hide"}
        onClose={close}
        role="alertdialog"
        closeOnBackdrop={false}
        title={`¿Ocultar ${event.title}?`}
        description="Nadie más que los administradores lo verá, y quienes participan dejarán de ver su chat y sus fotos."
        footer={
          <>
            <Button variant="danger" fullWidth loading={updateState.isLoading} onClick={() => setStatus("hidden", "Evento oculto.")}>
              Ocultar evento
            </Button>
            <Button variant="secondary" fullWidth onClick={close}>
              Cancelar
            </Button>
          </>
        }
      />
      <Dialog
        open={sheet === "delete"}
        onClose={close}
        role="alertdialog"
        closeOnBackdrop={false}
        title={`¿Eliminar ${event.title}?`}
        description="Se borran el evento, su chat, sus álbumes y sus fotos. No se puede deshacer."
        footer={
          <>
            <Button variant="danger" fullWidth loading={removeState.isLoading} onClick={onDelete}>
              Eliminar evento
            </Button>
            <Button variant="secondary" fullWidth onClick={close}>
              Cancelar
            </Button>
          </>
        }
      />
    </section>
  );
}
