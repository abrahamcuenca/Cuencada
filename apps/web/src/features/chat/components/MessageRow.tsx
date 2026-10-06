import { memo, type PointerEvent, type ReactNode, useRef } from "react";
import { AvatarCircle } from "../../../shared/ui/AvatarCircle";
import { cx } from "../../../shared/ui/cx";
import { IconButton } from "../../../shared/ui/IconButton";
import styles from "../chat.module.css";
import { messageTime } from "../lib/format";
import type { ThreadMessage } from "../lib/thread";
import { LinkifiedText } from "./LinkifiedText";

/** Hold this long on a touch screen to open the message menu. */
export const LONG_PRESS_MS = 500;
/** A finger that moves more than this is scrolling, not long-pressing. */
const LONG_PRESS_SLOP_PX = 10;

/** Name shown for a message whose sender's account was removed. */
export const REMOVED_SENDER = "Cuenta eliminada";

/** Props for {@link MessageRow}. */
export interface MessageRowProps {
  message: ThreadMessage;
  mine: boolean;
  groupStart: boolean;
  groupEnd: boolean;
  timeZone: string;
  /** Whether the ⋯ menu offers "Eliminar" (my message, or I am an admin). */
  canDelete: boolean;
  onOpenMenu: (message: ThreadMessage) => void;
  onRetry: (clientMessageId: string) => void;
  onDiscard: (clientMessageId: string) => void;
}

function senderName(message: ThreadMessage): string {
  return message.sender?.displayName ?? REMOVED_SENDER;
}

function statusText(message: ThreadMessage, mine: boolean, timeZone: string): string {
  if (message.status === "pending") return "Enviando…";
  if (message.status === "failed") return "No enviado";
  const time = messageTime(message.createdAt, timeZone);
  return mine ? `${time} ✓` : time;
}

/**
 * One chat bubble: avatar and name at the start of a group, the body as
 * linkified plain text (or a tombstone), the time at the end of a group, and
 * the failed-send actions. Long-press (touch) or right-click opens the menu;
 * the ⋯ button does the same for keyboards and screen readers.
 */
export const MessageRow = memo(function MessageRow({
  message,
  mine,
  groupStart,
  groupEnd,
  timeZone,
  canDelete,
  onOpenMenu,
  onRetry,
  onDiscard
}: MessageRowProps): ReactNode {
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const deleted = message.deletedAt !== null;
  const local = message.status !== "sent";
  const hasMenu = !deleted && !local;
  const name = mine ? "Tú" : senderName(message);

  const cancelPress = (): void => {
    if (press.current !== null) clearTimeout(press.current.timer);
    press.current = null;
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (!hasMenu || event.pointerType !== "touch") return;
    cancelPress();
    press.current = {
      x: event.clientX,
      y: event.clientY,
      timer: setTimeout(() => {
        press.current = null;
        onOpenMenu(message);
      }, LONG_PRESS_MS)
    };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const start = press.current;
    if (start !== null && Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_SLOP_PX) cancelPress();
  };

  return (
    <div
      className={cx(
        styles.row,
        mine && styles.mine,
        groupStart && styles.groupStart,
        groupEnd && styles.groupEnd,
        message.status === "pending" && styles.pending,
        message.status === "failed" && styles.failed
      )}
      data-message-id={message.id}
    >
      {mine ? null : (
        <span className={styles.avatarSlot}>
          {groupStart ? <AvatarCircle name={senderName(message)} src={message.sender?.avatarUrl ?? undefined} size="sm" decorative /> : null}
        </span>
      )}
      <div className={styles.bubbleWrap}>
        {groupStart && !mine ? <p className={styles.sender}>{name}</p> : null}
        <div className={styles.bubbleLine}>
          <div
            className={styles.bubble}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={cancelPress}
            onPointerCancel={cancelPress}
            onPointerLeave={cancelPress}
            onContextMenu={(event) => {
              if (!hasMenu) return;
              event.preventDefault();
              cancelPress();
              onOpenMenu(message);
            }}
          >
            {/* Screen readers hear who wrote each message, even inside a group. */}
            {groupStart && !mine ? null : <span className="visually-hidden">{`${name}: `}</span>}
            {deleted ? <span className={styles.tombstone}>🚫 Mensaje eliminado</span> : <LinkifiedText text={message.body} />}
            {groupEnd || local ? <span className={styles.meta}>{statusText(message, mine, timeZone)}</span> : null}
          </div>
          {hasMenu && canDelete ? (
            <IconButton className={styles.more} variant="plain" icon="⋯" label={`Opciones del mensaje de ${name}`} onClick={() => onOpenMenu(message)} />
          ) : null}
        </div>
        {message.status === "failed" && message.clientMessageId !== null ? (
          <FailedActions clientMessageId={message.clientMessageId} onRetry={onRetry} onDiscard={onDiscard} />
        ) : null}
      </div>
    </div>
  );
});

function FailedActions({
  clientMessageId,
  onRetry,
  onDiscard
}: {
  clientMessageId: string;
  onRetry: (id: string) => void;
  onDiscard: (id: string) => void;
}): ReactNode {
  return (
    <div className={styles.failure}>
      <span>⚠️ No se envió</span>
      <button type="button" className={styles.linkButton} onClick={() => onRetry(clientMessageId)}>
        Reintentar
      </button>
      <button type="button" className={styles.linkButton} onClick={() => onDiscard(clientMessageId)}>
        Descartar
      </button>
    </div>
  );
}
