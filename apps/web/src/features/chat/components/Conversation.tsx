import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { useAppDispatch, useAppSelector } from "../../../app/hooks";
import { getApiErrorMessage, isAbortError, isFetchBaseQueryError } from "../../../shared/api/errors";
import { cx } from "../../../shared/ui/cx";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { Button } from "../../../shared/ui/Button";
import { Spinner } from "../../../shared/ui/Spinner";
import { useToast } from "../../../shared/ui/Toast";
import { selectCurrentUser, selectIsAdmin } from "../../auth/authSlice";
import { discardChatMessage, loadOlderMessages, retryChatMessage, sendChatMessage } from "../actions";
import { conversationApi, useDeleteChatMessageMutation, useGetMessagesQuery, useMarkRoomReadMutation } from "../conversationApi";
import styles from "../chat.module.css";
import { sendChatFrame, setViewingRoom, subscribeChatEvents } from "../events";
import { buildConversation } from "../lib/format";
import type { ChatRoomView } from "../lib/rooms";
import { applyDeletedMessage, firstUnreadMessageId, lastServerMessage, type ThreadMessage } from "../lib/thread";
import type { ChatConnectionStatus } from "../socket";
import { Composer, enterSends } from "./Composer";
import { MessageList, type MessageListHandle } from "./MessageList";
import { MessageMenu } from "./MessageMenu";

/** At most this many messages are in the DOM; older ones come back with "Cargar anteriores". */
export const MAX_RENDERED_MESSAGES = 300;
/** How many more to reveal per "Cargar anteriores" before asking the server. */
const REVEAL_STEP = 50;
/** At most one `POST …/read` per this window (the last one is always sent). */
export const READ_THROTTLE_MS = 2000;
/** At most one `typing` frame per this window. */
export const TYPING_THROTTLE_MS = 3000;
/** A "está escribiendo…" line disappears this long after the last typing frame. */
export const TYPING_TTL_MS = 6000;

/** Props for {@link Conversation}. */
export interface ConversationProps {
  roomId: string;
  room: ChatRoomView | undefined;
  connection: ChatConnectionStatus;
  timeZone: string;
  now: Date;
  /** The messages request answered 403 (unverified). */
  onForbidden: () => void;
  /** Reopens the socket after it was taken over by another tab. */
  onReconnect: () => void;
}

const STATUS_TEXT: Partial<Record<ChatConnectionStatus, string>> = {
  connecting: "Conectando…",
  reconnecting: "Reconectando… Los mensajes se enviarán cuando vuelva la conexión.",
  paused: "Reconectando…",
  offline: "Sin conexión. Los mensajes se enviarán cuando vuelva la conexión.",
  evicted: "Se abrió el chat en otra pestaña.",
  failed: "No pudimos conectar el chat. Recarga la página."
};

function subscribeVisibility(listener: () => void): () => void {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

function useDocumentVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState !== "hidden",
    () => true
  );
}

/** Who is typing in a room (first names, without me), cleared after {@link TYPING_TTL_MS}. */
function useTypingNames(roomId: string, meId: string | null): string[] {
  const [typing, setTyping] = useState<ReadonlyMap<string, { name: string; until: number }>>(new Map());

  useEffect(() => {
    setTyping(new Map());
    return subscribeChatEvents((event) => {
      if (event.type !== "frame") return;
      const { frame } = event;
      if (frame.type === "typing" && frame.roomId === roomId && frame.userId !== meId) {
        const name = frame.displayName.split(/\s+/)[0] ?? frame.displayName;
        setTyping((current) => new Map(current).set(frame.userId, { name, until: Date.now() + TYPING_TTL_MS }));
      } else if (frame.type === "message" && frame.message.roomId === roomId && frame.message.sender !== null) {
        const senderId = frame.message.sender.userId;
        setTyping((current) => {
          if (!current.has(senderId)) return current;
          const next = new Map(current);
          next.delete(senderId);
          return next;
        });
      }
    });
  }, [roomId, meId]);

  useEffect(() => {
    if (typing.size === 0) return undefined;
    const soonest = Math.min(...[...typing.values()].map((entry) => entry.until));
    const timer = setTimeout(
      () => {
        const now = Date.now();
        setTyping((current) => new Map([...current].filter(([, entry]) => entry.until > now)));
      },
      Math.max(0, soonest - Date.now()) + 50
    );
    return () => clearTimeout(timer);
  }, [typing]);

  return [...typing.values()].map((entry) => entry.name);
}

/**
 * @param names - First names of the people typing.
 * @returns "Rosa está escribiendo…", "Rosa y Tomás están escribiendo…" or "Varias personas están escribiendo…".
 */
export function typingText(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} está escribiendo…`;
  if (names.length === 2) return `${names[0]} y ${names[1]} están escribiendo…`;
  return "Varias personas están escribiendo…";
}

function errorStatus(error: unknown): number | string | null {
  return isFetchBaseQueryError(error) ? error.status : null;
}

/**
 * The conversation (wireframes §8.2): app bar, connection banner, the
 * message log, the typing line and the composer pinned above the keyboard.
 */
export function Conversation({ roomId, room, connection, timeZone, now, onForbidden, onReconnect }: ConversationProps): ReactNode {
  const dispatch = useAppDispatch();
  const toast = useToast();
  const me = useAppSelector(selectCurrentUser);
  const isAdmin = useAppSelector(selectIsAdmin);
  const meId = me?.id ?? null;
  const { data: thread, error, isLoading, isError, refetch } = useGetMessagesQuery(roomId);
  const [markRead] = useMarkRoomReadMutation();
  const [deleteMessage, { isLoading: deleting }] = useDeleteChatMessageMutation();
  const visible = useDocumentVisible();
  const [atBottom, setAtBottom] = useState(true);
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [menuMessage, setMenuMessage] = useState<ThreadMessage | null>(null);
  const [firstUnreadId, setFirstUnreadId] = useState<string | null | undefined>(undefined);
  const listRef = useRef<MessageListHandle>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const lastTypingAt = useRef(0);
  const lastReadAt = useRef(0);
  const lastReadSent = useRef<string | null>(null);
  const typingNames = useTypingNames(roomId, meId);

  const status = errorStatus(error);
  useEffect(() => {
    if (status === 403) onForbidden();
  }, [status, onForbidden]);

  // Focus: the composer with a physical keyboard; the room title on touch (no keyboard pop-up).
  useEffect(() => {
    if (enterSends()) composerRef.current?.focus({ preventScroll: true });
    else titleRef.current?.focus({ preventScroll: true });
  }, []);

  // The "Nuevos mensajes" divider is decided once, when the room opens.
  useEffect(() => {
    if (thread !== undefined && firstUnreadId === undefined) setFirstUnreadId(firstUnreadMessageId(thread.messages, room, meId));
  }, [thread, room, meId, firstUnreadId]);

  // Render window: the last MAX_RENDERED_MESSAGES, or from a frozen anchor while reading history.
  const messages = thread?.messages ?? [];
  let start = anchorId === null ? -1 : messages.findIndex((message) => message.id === anchorId);
  if (start < 0) start = Math.max(0, messages.length - MAX_RENDERED_MESSAGES);
  const rendered = useMemo(() => messages.slice(start), [messages, start]);
  const items = useMemo(
    () => buildConversation(rendered, { meId, now, timeZone, firstUnreadId: firstUnreadId ?? null }),
    [rendered, meId, now, timeZone, firstUnreadId]
  );
  const canLoadOlder = start > 0 || (thread?.nextBefore ?? null) !== null;

  const onLoadOlder = useCallback(async (): Promise<void> => {
    if (loadingOlder) return;
    if (start > 0) {
      setAnchorId(messages[Math.max(0, start - REVEAL_STEP)]?.id ?? null);
      return;
    }
    setLoadingOlder(true);
    const result = await dispatch(loadOlderMessages(roomId));
    if (result.status === "loaded") {
      // Anchor the window on the new oldest message so the fetched page is rendered.
      setAnchorId(result.firstId);
    } else if (result.status === "error") {
      toast.show({ message: "No pudimos cargar los mensajes anteriores.", tone: "danger" });
    }
    setLoadingOlder(false);
  }, [loadingOlder, start, messages, dispatch, roomId, toast]);

  // Mark as read: the newest server message is on screen (tab visible, scrolled to the bottom).
  const latest = thread === undefined ? undefined : lastServerMessage(thread);
  const latestId = latest?.id ?? null;
  const alreadyRead = room !== undefined && room.unreadCount === 0 && room.lastReadMessageId === latestId;
  useEffect(() => {
    if (latestId === null || !atBottom || !visible || alreadyRead || latestId === lastReadSent.current) return undefined;
    const wait = Math.max(0, lastReadAt.current + READ_THROTTLE_MS - Date.now());
    const timer = setTimeout(() => {
      lastReadAt.current = Date.now();
      lastReadSent.current = latestId;
      void markRead({ roomId, messageId: latestId });
    }, wait);
    return () => clearTimeout(timer);
  }, [latestId, atBottom, visible, alreadyRead, roomId, markRead]);

  // While I'm reading this room at the bottom, its new messages don't count as unread.
  useEffect(() => {
    setViewingRoom(atBottom && visible ? { roomId } : null);
    return () => setViewingRoom(null);
  }, [atBottom, visible, roomId]);

  const onSend = useCallback(
    (body: string): string | null => {
      const result = dispatch(sendChatMessage(roomId, body));
      if (!result.ok) return result.error;
      setAnchorId(null);
      return null;
    },
    [dispatch, roomId]
  );

  const onTyping = useCallback((): void => {
    const nowMs = Date.now();
    if (nowMs - lastTypingAt.current < TYPING_THROTTLE_MS) return;
    if (sendChatFrame({ type: "typing", roomId })) lastTypingAt.current = nowMs;
  }, [roomId]);

  const onRetry = useCallback((clientMessageId: string) => dispatch(retryChatMessage(roomId, clientMessageId)), [dispatch, roomId]);
  const onDiscard = useCallback((clientMessageId: string) => dispatch(discardChatMessage(roomId, clientMessageId)), [dispatch, roomId]);

  const clipboard = typeof navigator !== "undefined" && navigator.clipboard !== undefined ? navigator.clipboard : null;
  const onOpenMenu = useCallback(
    (message: ThreadMessage) => {
      const mine = message.sender !== null && message.sender.userId === meId;
      if (clipboard === null && !mine && !isAdmin) return;
      setMenuMessage(message);
    },
    [clipboard, meId, isAdmin]
  );

  const onConfirmDelete = async (message: ThreadMessage): Promise<void> => {
    try {
      await deleteMessage({ roomId, messageId: message.id }).unwrap();
      setMenuMessage(null);
      toast.show({ message: "Mensaje eliminado.", tone: "success" });
      listRef.current?.focus();
    } catch (deleteError) {
      if (isAbortError(deleteError)) return;
      if (errorStatus(deleteError) === 404) {
        // Someone (or a moderator) already deleted it, or it is not ours to delete: it is gone either way.
        dispatch(conversationApi.util.updateQueryData("getMessages", roomId, (thread) => applyDeletedMessage(thread, message.id)));
        setMenuMessage(null);
        toast.show({ message: "Ese mensaje ya no existe.", tone: "info" });
        return;
      }
      toast.show({ message: getApiErrorMessage(deleteError), tone: "danger" });
    }
  };

  const menuMine = menuMessage?.sender !== null && menuMessage?.sender?.userId === meId;
  const title = room?.title ?? "Chat";
  const statusText = STATUS_TEXT[connection];

  let body: ReactNode;
  if (isLoading) {
    body = (
      <div className={styles.listWrap} aria-busy="true">
        <Spinner label="Cargando mensajes…" />
      </div>
    );
  } else if (isError && thread === undefined) {
    body =
      status === 404 ? (
        <EmptyState icon="🔍" title="No encontramos esa sala" description="Puede que ya no exista." action={<Button to="/chat">Ver salas</Button>} />
      ) : status === 403 ? null : (
        <EmptyState
          icon="📡"
          title="No pudimos cargar los mensajes"
          description="Revisa tu conexión e inténtalo de nuevo."
          action={
            <Button variant="secondary" onClick={() => void refetch()}>
              Reintentar
            </Button>
          }
        />
      );
  } else {
    body = (
      <MessageList
        ref={listRef}
        items={items}
        label={`Mensajes de ${title}`}
        timeZone={timeZone}
        isAdmin={isAdmin}
        canLoadOlder={canLoadOlder}
        loadingOlder={loadingOlder}
        busy={false}
        empty={messages.length === 0}
        onLoadOlder={() => void onLoadOlder()}
        onAtBottomChange={setAtBottom}
        onLeaveBottom={() => setAnchorId((current) => current ?? rendered[0]?.id ?? null)}
        onReturnBottom={() => setAnchorId((current) => (current !== null && messages.length - start > MAX_RENDERED_MESSAGES ? null : current))}
        onOpenMenu={onOpenMenu}
        onRetry={onRetry}
        onDiscard={onDiscard}
      />
    );
  }

  return (
    <>
      <header className={styles.header}>
        <Link to="/chat" className={styles.back} aria-label="Volver a las salas">
          <span aria-hidden="true">‹</span>
        </Link>
        <h2 ref={titleRef} className={styles.title} tabIndex={-1}>
          {title}
        </h2>
      </header>
      {statusText === undefined ? null : (
        <div className={cx(styles.status, (connection === "offline" || connection === "failed") && styles.statusOffline)}>
          <output>{statusText}</output>
          {connection === "evicted" ? (
            <button type="button" className={styles.linkButton} onClick={onReconnect}>
              Reconectar
            </button>
          ) : null}
        </div>
      )}
      {body}
      <p className={styles.typing} aria-hidden="true">
        {typingText(typingNames)}
      </p>
      <Composer ref={composerRef} onSend={onSend} onTyping={onTyping} disabled={isError && thread === undefined} />
      <MessageMenu
        message={menuMessage}
        canDelete={menuMine || isAdmin}
        deleting={deleting}
        onClose={() => setMenuMessage(null)}
        onCopy={
          clipboard === null
            ? null
            : (message) => {
                clipboard.writeText(message.body).then(
                  () => toast.show({ message: "Texto copiado.", tone: "success" }),
                  () => toast.show({ message: "No se pudo copiar el texto.", tone: "danger" })
                );
              }
        }
        onConfirmDelete={(message) => void onConfirmDelete(message)}
      />
    </>
  );
}
