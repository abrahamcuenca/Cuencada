/**
 * `/notificaciones` (members, WP-6.1): the feed behind the bell, grouped by
 * day (Hoy, Ayer, Esta semana, Anteriores), newest first, keyset paged with
 * "Cargar más". Tapping an entry marks it read and opens its target: the
 * photo (`?foto=<id>` on its gallery, event or box page), the event, or the
 * proposal. "Marcar todo como leído" clears the badge. An `event_added`
 * entry keeps the one-tap "Salir" of the WP-5.4 consent notice.
 *
 * While the page is open it holds the shared chat socket, so new entries
 * arrive live (`notification` frames); elsewhere the bell polls.
 */
import type { Notification as AppNotification } from "@cuencada/types";
import { type ReactNode, useMemo } from "react";
import { Link } from "react-router-dom";
import { useAppSelector } from "../../../app/hooks";
import { isAbortError } from "../../../shared/api/errors";
import { reportUnexpected } from "../../../shared/lib/reportUnexpected";
import { AvatarCircle } from "../../../shared/ui/AvatarCircle";
import { Button } from "../../../shared/ui/Button";
import { cx } from "../../../shared/ui/cx";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { Skeleton } from "../../../shared/ui/Skeleton";
import { useToast } from "../../../shared/ui/Toast";
import { useAccessDenial } from "../../auth/accessDenied";
import { AccessDeniedState } from "../../auth/components/AccessDeniedState";
import { readerTimeZone, roomTimeLabel } from "../../chat/lib/format";
import { useChatConnection } from "../../chat/socket";
import { selectCanUseChat } from "../../chat/unread";
import { useLeaveEventMutation } from "../../events/api";
import { eventErrorMessage } from "../../events/lib/format";
import { useMarkNotificationsReadMutation, useListNotificationsInfiniteQuery } from "../feedApi";
import { groupNotifications, notificationHint, notificationHref, notificationIcon, notificationText } from "../lib/format";
import styles from "../notifications.module.css";

/** The page. */
export function NotificationsPage(): ReactNode {
  const canUse = useAppSelector(selectCanUseChat);
  // Live entries while the feed is open (the socket is shared with the chat pages).
  useChatConnection(canUse);
  const query = useListNotificationsInfiniteQuery();
  const [markRead, markState] = useMarkNotificationsReadMutation();
  const toast = useToast();
  const items = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);
  const hasUnread = items.some((item) => item.seenAt === null);

  const onMarkAll = (): void => {
    markRead({ all: true })
      .unwrap()
      .catch((cause: unknown) => {
        if (!isAbortError(cause)) toast.show({ message: "No pudimos marcar tus notificaciones. Inténtalo de nuevo.", tone: "danger" });
      });
  };

  // Opening an entry marks it read (best effort; navigation never waits for it).
  const onOpen = (item: AppNotification): void => {
    if (item.seenAt !== null) return;
    markRead({ ids: [item.id] })
      .unwrap()
      .catch((cause: unknown) => {
        if (!isAbortError(cause)) reportUnexpected(cause);
      });
  };

  return (
    <div className={cx("cu-container", styles.page)}>
      <div className={styles.header}>
        <h1 className={styles.title}>Notificaciones</h1>
        {items.length > 0 ? (
          <Button variant="secondary" size="sm" disabled={!hasUnread} loading={markState.isLoading} onClick={onMarkAll}>
            Marcar todo como leído
          </Button>
        ) : null}
      </div>
      <Feed query={query} items={items} onOpen={onOpen} />
    </div>
  );
}

type FeedQuery = ReturnType<typeof useListNotificationsInfiniteQuery>;

function Feed({ query, items, onOpen }: { query: FeedQuery; items: AppNotification[]; onOpen: (item: AppNotification) => void }): ReactNode {
  const { data, isLoading, isError, error, refetch, hasNextPage, fetchNextPage, isFetchingNextPage } = query;
  const denial = useAccessDenial(error);
  const groups = useMemo(() => groupNotifications(items, new Date(), readerTimeZone()), [items]);

  if (isLoading) {
    return (
      <div className={styles.list} aria-busy="true">
        <span className="visually-hidden">Cargando notificaciones…</span>
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} shape="block" height="4.5rem" />
        ))}
      </div>
    );
  }
  if (isError && data === undefined) {
    if (isAbortError(error)) return null;
    if (denial !== null) {
      return <AccessDeniedState denial={denial} verifyTitle="Verifica tu correo para ver tus notificaciones" forbiddenTitle="No tienes acceso a las notificaciones" />;
    }
    return (
      <EmptyState
        icon="📡"
        title="No pudimos cargar tus notificaciones"
        description="Revisa tu conexión e inténtalo de nuevo."
        action={
          <Button variant="secondary" onClick={() => void refetch()}>
            Reintentar
          </Button>
        }
      />
    );
  }
  if (items.length === 0) {
    return (
      <EmptyState
        icon="🔔"
        title="No tienes notificaciones"
        description="Aquí verás cuando te etiqueten en una foto, comenten o les guste tus fotos, o te agreguen a un evento."
      />
    );
  }
  return (
    <>
      {groups.map((group) => (
        <section key={group.key} className={styles.group} aria-labelledby={`notificaciones-${group.key}`}>
          <h2 id={`notificaciones-${group.key}`} className={styles.groupTitle}>
            {group.label}
          </h2>
          <ul className={styles.list}>
            {group.items.map((item) => (
              <NotificationRow key={item.id} item={item} onOpen={() => onOpen(item)} />
            ))}
          </ul>
        </section>
      ))}
      {hasNextPage ? (
        <div className={styles.more}>
          <Button variant="secondary" loading={isFetchingNextPage} onClick={() => void fetchNextPage()}>
            Cargar más
          </Button>
        </div>
      ) : null}
    </>
  );
}

function NotificationRow({ item, onOpen }: { item: AppNotification; onOpen: () => void }): ReactNode {
  const unread = item.seenAt === null;
  const hint = notificationHint(item);
  const thumb = item.target.kind === "media" ? item.target.thumbUrl : null;
  const actorName = item.actor?.name ?? null;
  return (
    <li className={cx(styles.item, unread && styles.unread)}>
      <Link to={notificationHref(item)} className={styles.row} onClick={onOpen}>
        <span className={styles.visual}>
          {actorName !== null ? (
            <AvatarCircle name={actorName} src={item.actor?.avatarUrl ?? undefined} size="md" decorative />
          ) : (
            <span className={styles.icon} aria-hidden="true">
              {notificationIcon(item)}
            </span>
          )}
        </span>
        <span className={styles.body}>
          <span className={styles.text}>
            {unread ? <span className="visually-hidden">Sin leer: </span> : null}
            {notificationText(item)}
          </span>
          {hint !== null ? <span className={styles.hint}>{hint}</span> : null}
          <time className={styles.time} dateTime={item.createdAt}>
            {roomTimeLabel(item.createdAt, new Date(), readerTimeZone())}
          </time>
        </span>
        {thumb !== null ? <img className={styles.thumb} src={thumb} alt="" width={56} height={56} loading="lazy" decoding="async" /> : null}
        {unread ? <span className={styles.dot} aria-hidden="true" /> : null}
      </Link>
      {item.target.kind === "event" && item.target.canLeave ? <LeaveAction eventId={item.target.event.id} title={item.target.event.title} /> : null}
    </li>
  );
}

/** One-tap "Salir" of the consent notice: leaving retracts the entry server-side. */
function LeaveAction({ eventId, title }: { eventId: string; title: string }): ReactNode {
  const toast = useToast();
  const [leave, state] = useLeaveEventMutation();
  const onLeave = (): void => {
    leave({ id: eventId })
      .unwrap()
      .then(() => toast.show({ message: `Saliste de ${title}.`, tone: "success" }))
      .catch((cause: unknown) => {
        if (!isAbortError(cause)) toast.show({ message: eventErrorMessage(cause), tone: "danger" });
      });
  };
  return (
    <div className={styles.actions}>
      <Button variant="secondary" size="sm" loading={state.isLoading} onClick={onLeave} aria-label={`Salir de ${title}`}>
        Salir
      </Button>
    </div>
  );
}
