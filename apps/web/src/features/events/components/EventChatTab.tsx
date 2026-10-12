/**
 * The event's "Chat" tab (WP-5.4): for participants (admins included) the
 * chat feature's own conversation (history, live frames, composer, read
 * state) on `event.chatRoomId`, embedded in the page. Mounting it opens the
 * shared chat socket, like `/chat`; "Abrir en el chat" goes to the
 * full-screen conversation.
 *
 * An admin who is not a participant gets no live room (Security M1 on #54:
 * no chat-list entry, no frames, no sending) but the read-only, audited
 * {@link EventModerationChat} instead.
 */
import type { EventDetail } from "@cuencada/types";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Button } from "../../../shared/ui/Button";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { Spinner } from "../../../shared/ui/Spinner";
import { useGetRoomsQuery } from "../../chat/api";
import chatStyles from "../../chat/chat.module.css";
import { Conversation } from "../../chat/components/Conversation";
import type { ChatDenial } from "../../chat/lib/access";
import { readerTimeZone } from "../../chat/lib/format";
import { useChatConnection } from "../../chat/socket";
import { useAppSelector } from "../../../app/hooks";
import { selectIsAdmin } from "../../auth/authSlice";
import { EventModerationChat } from "./EventModerationChat";
import styles from "../events.module.css";

const CLOCK_TICK_MS = 60_000;

function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** Props for {@link EventChatTab}. */
export interface EventChatTabProps {
  event: EventDetail;
  /** "Me apunto" from the join prompt. */
  onJoin: () => void;
  joining: boolean;
}

/** What a member sees instead of the chat when they cannot open it. */
export function ChatUnavailable({ event, onJoin, joining }: EventChatTabProps): ReactNode {
  if (event.canJoin) {
    return (
      <EmptyState
        icon="💬"
        title="Apúntate para chatear"
        description="El chat del evento es para quienes participan."
        action={
          <Button loading={joining} onClick={onJoin}>
            Me apunto
          </Button>
        }
      />
    );
  }
  if (event.status === "draft") {
    return <EmptyState icon="📝" title="El chat se abre al publicar" description="Mientras el evento sea un borrador, no tiene chat." />;
  }
  return <EmptyState icon="🔒" title="El chat es solo para participantes" description="Quien organiza el evento puede agregarte." />;
}

/**
 * Whether the caller sees the moderation view instead of the live chat: an
 * admin with chat access who is not a participant.
 *
 * @param event - The event as loaded.
 * @param isAdmin - The caller's role.
 */
export function usesModerationView(event: Pick<EventDetail, "hasChat" | "chatRoomId" | "viewerRole">, isAdmin: boolean): boolean {
  return isAdmin && event.viewerRole === null && event.hasChat && event.chatRoomId !== null;
}

/** The embedded conversation, the moderation view, or why there is none. */
export function EventChatTab(props: EventChatTabProps): ReactNode {
  const { event } = props;
  const isAdmin = useAppSelector(selectIsAdmin);
  const roomId = event.hasChat ? event.chatRoomId : null;
  if (roomId === null) return <ChatUnavailable {...props} />;
  if (usesModerationView(event, isAdmin)) return <EventModerationChat roomId={roomId} title={event.title} />;
  return <EmbeddedChat roomId={roomId} />;
}

function EmbeddedChat({ roomId }: { roomId: string }): ReactNode {
  const rooms = useGetRoomsQuery();
  const [denial, setDenial] = useState<ChatDenial | null>(null);
  const { status, reconnect } = useChatConnection(rooms.isSuccess && denial === null);
  const [timeZone] = useState(readerTimeZone);
  const now = useMinuteClock();
  const onForbidden = useCallback((next: ChatDenial) => setDenial(next), []);
  const room = rooms.data?.find((entry) => entry.id === roomId);

  if (denial !== null || status === "unverified" || status === "forbidden") {
    return <EmptyState icon="🔒" title="No tienes acceso a este chat" description="Si crees que es un error, escríbele a quien organiza el evento." />;
  }
  if (rooms.isLoading) return <Spinner label="Cargando chat…" />;
  return (
    <div className={styles.chatTab}>
      <div className={chatStyles.embedded}>
        <Conversation key={roomId} embedded roomId={roomId} room={room} connection={status} timeZone={timeZone} now={now} onForbidden={onForbidden} onReconnect={reconnect} />
      </div>
      <Button to={`/chat/${roomId}`} variant="ghost" size="sm" icon="↗">
        Abrir en el chat
      </Button>
    </div>
  );
}
