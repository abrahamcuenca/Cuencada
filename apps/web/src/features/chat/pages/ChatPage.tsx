import { idSchema } from "@cuencada/types";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useMatch } from "react-router-dom";
import { useAppSelector } from "../../../app/hooks";
import { isFetchBaseQueryError } from "../../../shared/api/errors";
import { Button } from "../../../shared/ui/Button";
import { cx } from "../../../shared/ui/cx";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { selectCurrentUser } from "../../auth/authSlice";
import { useGetRoomsQuery } from "../api";
import styles from "../chat.module.css";
import { Conversation } from "../components/Conversation";
import { RoomList } from "../components/RoomList";
import { readerTimeZone } from "../lib/format";
import { useChatViewport } from "../lib/useChatViewport";
import { useChatConnection } from "../socket";

/** Relative times ("ayer", "9:41") are recomputed this often. */
const CLOCK_TICK_MS = 60_000;

/** Shown when the server refuses chat to an unverified account (403). */
export function ChatForbidden(): ReactNode {
  return (
    <div className={styles.forbidden}>
      <EmptyState
        tone="lock"
        icon="✉️"
        title="Verifica tu correo para usar el chat"
        description="Para cuidar la privacidad de la familia, el chat se activa cuando confirmas tu correo. Busca el enlace que te enviamos o pide uno nuevo desde el aviso de arriba."
        action={<Button to="/perfil">Ir a mi perfil</Button>}
      />
    </div>
  );
}

function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function is403(error: unknown): boolean {
  return isFetchBaseQueryError(error) && error.status === 403;
}

/**
 * `/chat` and `/chat/:roomId` (members). Phones: the room list, or a
 * full-screen conversation without the BottomNav. ≥900px: both panes.
 * Mounting this page opens the shared chat socket; leaving closes it.
 */
export function ChatPage(): ReactNode {
  // The page is the parent route; the room id lives on the child (`/chat/:roomId`).
  const roomId = useMatch("/chat/:roomId")?.params.roomId ?? null;
  const validRoomId = roomId !== null && idSchema.safeParse(roomId).success;
  const me = useAppSelector(selectCurrentUser);
  const rooms = useGetRoomsQuery();
  const [messagesForbidden, setMessagesForbidden] = useState(false);
  const forbidden = is403(rooms.error) || messagesForbidden;
  // Connect only once the server let us list the rooms (an unverified account gets a 403 there first).
  const { status: connection, reconnect } = useChatConnection(rooms.isSuccess && !forbidden);
  const layoutRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  const now = useMinuteClock();
  const [timeZone] = useState(readerTimeZone);
  useChatViewport(layoutRef, markerRef);
  const onForbidden = useCallback(() => setMessagesForbidden(true), []);

  if (forbidden || connection === "forbidden") return <ChatForbidden />;

  const room = rooms.data?.find((entry) => entry.id === roomId);

  return (
    <>
      <div ref={markerRef} className={styles.marker} />
      <div ref={layoutRef} className={cx(styles.layout, roomId !== null && styles.hasRoom)}>
        <section className={styles.listPane} aria-label="Salas de chat">
          <RoomList
            rooms={rooms.data}
            loading={rooms.isLoading}
            error={rooms.isError}
            onRetry={() => void rooms.refetch()}
            activeRoomId={roomId}
            meId={me?.id ?? null}
            now={now}
            timeZone={timeZone}
          />
        </section>
        <section className={styles.conversationPane} aria-label="Conversación">
          {roomId === null ? (
            <div className={styles.placeholder}>
              <EmptyState icon="💬" title="Elige una sala" description="Tus conversaciones con la familia aparecen a la izquierda." />
            </div>
          ) : validRoomId ? (
            <Conversation key={roomId} roomId={roomId} room={room} connection={connection} timeZone={timeZone} now={now} onForbidden={onForbidden} onReconnect={reconnect} />
          ) : (
            <EmptyState icon="🔍" title="No encontramos esa sala" description="Revisa el enlace o elige otra sala." action={<Button to="/chat">Ver salas</Button>} />
          )}
        </section>
      </div>
    </>
  );
}
