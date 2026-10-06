import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Badge } from "../../../shared/ui/Badge";
import { cx } from "../../../shared/ui/cx";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { Skeleton } from "../../../shared/ui/Skeleton";
import styles from "../chat.module.css";
import { roomTimeLabel } from "../lib/format";
import type { ChatRoomView, RoomPreview } from "../lib/rooms";
import { unreadCountText, unreadLabel } from "../unread";

/** Props for {@link RoomList}. */
export interface RoomListProps {
  rooms: readonly ChatRoomView[] | undefined;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  activeRoomId: string | null;
  meId: string | null;
  now: Date;
  timeZone: string;
}

/** Decorative icon of a room. */
export function roomIcon(room: Pick<ChatRoomView, "kind">): string {
  return room.kind === "global" ? "👨‍👩‍👧‍👦" : "🌴";
}

function previewText(preview: RoomPreview | null, meId: string | null): string {
  if (preview === null) return "";
  if (preview.deleted) return "🚫 Mensaje eliminado";
  const who = preview.senderId !== null && preview.senderId === meId ? "Tú" : (preview.senderName?.split(/\s+/)[0] ?? "");
  const line = preview.body.replace(/\s+/g, " ").trim();
  return who === "" ? line : `${who}: ${line}`;
}

/**
 * The room list (wireframes §8.1): the global "Familia" room first, then one
 * room per edition, each with the last message (when known), its time and an
 * unread badge.
 */
export function RoomList({ rooms, loading, error, onRetry, activeRoomId, meId, now, timeZone }: RoomListProps): ReactNode {
  return (
    <>
      <h1 className={styles.listTitle}>Chat</h1>
      {loading && rooms === undefined ? (
        <Skeleton shape="block" height="12rem" />
      ) : error && rooms === undefined ? (
        <EmptyState
          icon="📡"
          title="No pudimos cargar las salas"
          description="Revisa tu conexión e inténtalo de nuevo."
          action={
            <button type="button" className={styles.linkButton} onClick={onRetry}>
              Reintentar
            </button>
          }
        />
      ) : rooms === undefined || rooms.length === 0 ? (
        <EmptyState icon="💬" title="Aún no hay salas" description="La sala de la familia aparecerá aquí muy pronto." />
      ) : (
        <ul className={styles.rooms} aria-label="Salas">
          {rooms.map((room) => {
            const preview = previewText(room.preview, meId);
            const unread = room.unreadCount > 0;
            return (
              <li key={room.id}>
                <Link
                  to={`/chat/${room.id}`}
                  className={cx(styles.roomLink, unread && styles.roomUnread)}
                  aria-current={room.id === activeRoomId ? "page" : undefined}
                >
                  <span className={styles.roomIcon} aria-hidden="true">
                    {roomIcon(room)}
                  </span>
                  <span className={styles.roomText}>
                    <span className={styles.roomTitle}>{room.title}</span>
                    {preview === "" ? null : <span className={styles.roomPreview}>{preview}</span>}
                  </span>
                  <span className={styles.roomMeta}>
                    {room.lastMessageAt === null ? null : <span>{roomTimeLabel(room.lastMessageAt, now, timeZone)}</span>}
                    {unread ? (
                      <Badge tone="festive" shape="count" srLabel={unreadLabel(room.unreadCount)}>
                        {unreadCountText(room.unreadCount)}
                      </Badge>
                    ) : null}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
