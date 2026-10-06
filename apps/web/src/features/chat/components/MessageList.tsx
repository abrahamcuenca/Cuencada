import { type ReactNode, type Ref, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../../../shared/ui/Button";
import { cx } from "../../../shared/ui/cx";
import styles from "../chat.module.css";
import type { ConversationItem } from "../lib/format";
import { decideScroll, isNearBottom, type ListEdges, NEAR_TOP_PX } from "../lib/scroll";
import type { ThreadMessage } from "../lib/thread";
import { MessageRow } from "./MessageRow";

/** Imperative handle of {@link MessageList}. */
export interface MessageListHandle {
  scrollToBottom: () => void;
  focus: () => void;
}

/** Props for {@link MessageList}. */
export interface MessageListProps {
  items: readonly ConversationItem[];
  /** Accessible name of the log, e.g. "Mensajes de Toda la familia". */
  label: string;
  timeZone: string;
  isAdmin: boolean;
  /** Older messages exist (hidden in the window or on the server). */
  canLoadOlder: boolean;
  loadingOlder: boolean;
  /** Initial load or a history page in flight: suppresses live announcements. */
  busy: boolean;
  empty: boolean;
  onLoadOlder: () => void;
  /** Called when "at the bottom" changes (drives mark-as-read). */
  onAtBottomChange: (atBottom: boolean) => void;
  /** The user scrolled away from the newest messages: freeze the render window. */
  onLeaveBottom: () => void;
  /** Scrolled back to the newest messages after a jump: the window may shrink again. */
  onReturnBottom: () => void;
  onOpenMenu: (message: ThreadMessage) => void;
  onRetry: (clientMessageId: string) => void;
  onDiscard: (clientMessageId: string) => void;
  ref?: Ref<MessageListHandle>;
}

function edgesOf(items: readonly ConversationItem[]): ListEdges & { newest: ConversationItem | undefined } {
  const messages = items.filter((item) => item.kind === "message");
  const first = messages[0];
  const last = messages[messages.length - 1];
  return {
    firstId: first?.kind === "message" ? first.key : null,
    lastId: last?.kind === "message" ? last.key : null,
    count: messages.length,
    newest: last
  };
}

/**
 * The scrolling message log (`role="log"`, polite). Sticks to the bottom
 * only when the reader is already there (or just sent a message); otherwise
 * shows a "Nuevos mensajes ↓" pill. Older pages are prepended without moving
 * what the reader is looking at, while `aria-busy` keeps them from being
 * announced as new.
 */
export function MessageList({
  items,
  label,
  timeZone,
  isAdmin,
  canLoadOlder,
  loadingOlder,
  busy,
  empty,
  onLoadOlder,
  onAtBottomChange,
  onLeaveBottom,
  onReturnBottom,
  onOpenMenu,
  onRetry,
  onDiscard,
  ref
}: MessageListProps): ReactNode {
  const listRef = useRef<HTMLDivElement | null>(null);
  const nearBottom = useRef(true);
  const previous = useRef<ListEdges>({ firstId: null, lastId: null, count: 0 });
  const previousHeight = useRef(0);
  const [showPill, setShowPill] = useState(false);

  const setNearBottom = (next: boolean): void => {
    if (nearBottom.current === next) return;
    nearBottom.current = next;
    onAtBottomChange(next);
    if (next) {
      setShowPill(false);
      onReturnBottom();
    } else {
      onLeaveBottom();
    }
  };

  const scrollToBottom = (): void => {
    const list = listRef.current;
    if (list === null) return;
    list.scrollTop = list.scrollHeight;
    setShowPill(false);
    setNearBottom(true);
  };

  useImperativeHandle(ref, () => ({ scrollToBottom, focus: () => listRef.current?.focus({ preventScroll: true }) }));

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after every change of the rendered rows only.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const next = edgesOf(items);
    const newest = next.newest;
    const decision = decideScroll({
      previous: previous.current,
      next,
      wasNearBottom: nearBottom.current,
      newestIsMine: newest?.kind === "message" && newest.mine && newest.message.status !== "sent"
    });
    if (decision === "bottom") {
      list.scrollTop = list.scrollHeight;
      setShowPill(false);
      setNearBottom(true);
    } else if (decision === "preserve") {
      list.scrollTop += list.scrollHeight - previousHeight.current;
    } else if (decision === "pill") {
      setShowPill(true);
    }
    previous.current = next;
    previousHeight.current = list.scrollHeight;
  }, [items]);

  // The keyboard opening (or the composer growing) shrinks the list: stay on the newest message.
  useEffect(() => {
    const list = listRef.current;
    if (list === null || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      if (nearBottom.current) list.scrollTop = list.scrollHeight;
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  const onScroll = (): void => {
    const list = listRef.current;
    if (list === null) return;
    setNearBottom(isNearBottom(list));
    previousHeight.current = list.scrollHeight;
    if (list.scrollTop <= NEAR_TOP_PX && canLoadOlder && !loadingOlder && !busy) onLoadOlder();
  };

  return (
    <div className={styles.listWrap}>
      <div
        ref={listRef}
        className={styles.list}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-busy={busy || loadingOlder ? true : undefined}
        aria-label={label}
        tabIndex={-1}
        onScroll={onScroll}
      >
        {canLoadOlder ? (
          <div className={styles.older}>
            <Button size="sm" variant="ghost" loading={loadingOlder} onClick={onLoadOlder}>
              Cargar anteriores
            </Button>
          </div>
        ) : null}
        {empty ? <p className={styles.empty}>💬 Aún no hay mensajes. ¡Saluda a la familia!</p> : null}
        {items.map((item) => {
          if (item.kind === "day") {
            return (
              <p key={item.key} className={styles.day}>
                {item.label}
              </p>
            );
          }
          if (item.kind === "unread") {
            return (
              <p key={item.key} className={cx(styles.day, styles.unreadMarker)}>
                Nuevos mensajes
              </p>
            );
          }
          return (
            <MessageRow
              key={item.key}
              message={item.message}
              mine={item.mine}
              groupStart={item.groupStart}
              groupEnd={item.groupEnd}
              timeZone={timeZone}
              canDelete={item.mine || isAdmin}
              onOpenMenu={onOpenMenu}
              onRetry={onRetry}
              onDiscard={onDiscard}
            />
          );
        })}
      </div>
      {showPill ? (
        <button type="button" className={styles.pill} onClick={scrollToBottom}>
          Nuevos mensajes ↓
        </button>
      ) : null}
    </div>
  );
}
