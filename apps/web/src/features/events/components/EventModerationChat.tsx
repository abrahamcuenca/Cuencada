/**
 * "Vista de moderación" of an event chat (WP-5.4, after Security M1 on #54):
 * an admin who is **not** a participant gets no live room (no chat-list
 * entry, no socket frames, no sending). They read the history through the
 * audited REST endpoint (`GET /chat/rooms/:id/messages`, logged as
 * `event.admin_viewed` on `participants` events) and may delete messages for
 * moderation. Read-only: no composer, no socket, no read receipts.
 */
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { useAppDispatch } from "../../../app/hooks";
import { getApiErrorMessage, isAbortError, isFetchBaseQueryError } from "../../../shared/api/errors";
import { Button } from "../../../shared/ui/Button";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { Spinner } from "../../../shared/ui/Spinner";
import { useToast } from "../../../shared/ui/Toast";
import { loadOlderMessages } from "../../chat/actions";
import chatStyles from "../../chat/chat.module.css";
import { MessageList } from "../../chat/components/MessageList";
import { MessageMenu } from "../../chat/components/MessageMenu";
import { conversationApi, useDeleteChatMessageMutation, useGetMessagesQuery } from "../../chat/conversationApi";
import { buildConversation, readerTimeZone } from "../../chat/lib/format";
import { applyDeletedMessage, type ThreadMessage } from "../../chat/lib/thread";
import styles from "../events.module.css";

/** Title and note of the moderation view. */
export const MODERATION_TITLE = "Vista de moderación";
export const MODERATION_NOTE = "No participas en este evento: ves el chat solo para moderarlo y no puedes escribir. Esta consulta queda registrada.";

function noop(): void {}

/** Props for {@link EventModerationChat}. */
export interface EventModerationChatProps {
  roomId: string;
  title: string;
}

/** The read-only, audited history of an event room, with delete. */
export function EventModerationChat({ roomId, title }: EventModerationChatProps): ReactNode {
  const dispatch = useAppDispatch();
  const toast = useToast();
  const { data: thread, error, isLoading, isError, refetch } = useGetMessagesQuery(roomId);
  const [deleteMessage, { isLoading: deleting }] = useDeleteChatMessageMutation();
  const [menuMessage, setMenuMessage] = useState<ThreadMessage | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [timeZone] = useState(readerTimeZone);
  const [now] = useState(() => new Date());
  const messages = thread?.messages ?? [];
  const items = useMemo(() => buildConversation(messages, { meId: null, now, timeZone, firstUnreadId: null }), [messages, now, timeZone]);

  const onLoadOlder = useCallback(async (): Promise<void> => {
    if (loadingOlder) return;
    setLoadingOlder(true);
    const result = await dispatch(loadOlderMessages(roomId));
    if (result.status === "error") toast.show({ message: "No pudimos cargar los mensajes anteriores.", tone: "danger" });
    setLoadingOlder(false);
  }, [dispatch, loadingOlder, roomId, toast]);

  const onConfirmDelete = (message: ThreadMessage): void => {
    deleteMessage({ roomId, messageId: message.id })
      .unwrap()
      .then(() => {
        setMenuMessage(null);
        toast.show({ message: "Mensaje eliminado.", tone: "success" });
      })
      .catch((cause: unknown) => {
        if (isAbortError(cause)) return;
        if (isFetchBaseQueryError(cause) && cause.status === 404) {
          dispatch(conversationApi.util.updateQueryData("getMessages", roomId, (current) => applyDeletedMessage(current, message.id)));
          setMenuMessage(null);
          toast.show({ message: "Ese mensaje ya no existe.", tone: "info" });
          return;
        }
        toast.show({ message: getApiErrorMessage(cause), tone: "danger" });
      });
  };

  let body: ReactNode;
  if (isLoading) {
    body = <Spinner label="Cargando mensajes…" />;
  } else if (isError && thread === undefined) {
    body = isAbortError(error) ? null : (
      <EmptyState
        icon="📡"
        title="No pudimos cargar el chat"
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
        items={items}
        label={`Mensajes de ${title} (moderación)`}
        timeZone={timeZone}
        isAdmin
        canLoadOlder={(thread?.nextBefore ?? null) !== null}
        loadingOlder={loadingOlder}
        busy={false}
        empty={messages.length === 0}
        onLoadOlder={() => void onLoadOlder()}
        onAtBottomChange={noop}
        onLeaveBottom={noop}
        onReturnBottom={noop}
        onOpenMenu={setMenuMessage}
        onRetry={noop}
        onDiscard={noop}
      />
    );
  }

  return (
    <div className={styles.chatTab}>
      <section className={styles.moderationNote} aria-labelledby="evento-moderacion">
        <h2 id="evento-moderacion" className={styles.blockTitle}>
          <span aria-hidden="true">🛡️ </span>
          {MODERATION_TITLE}
        </h2>
        <p className={styles.muted}>{MODERATION_NOTE}</p>
      </section>
      <div className={chatStyles.embedded}>
        {body}
        <div className={styles.moderationFooter}>
          <Button variant="ghost" size="sm" icon="↻" onClick={() => void refetch()}>
            Actualizar
          </Button>
        </div>
      </div>
      <MessageMenu
        message={menuMessage}
        canDelete
        deleting={deleting}
        onClose={() => setMenuMessage(null)}
        onCopy={null}
        onConfirmDelete={onConfirmDelete}
      />
    </div>
  );
}
