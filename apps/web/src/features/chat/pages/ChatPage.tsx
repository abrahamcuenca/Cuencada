import { idSchema } from "@cuencada/types";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useMatch } from "react-router-dom";
import { useAppSelector } from "../../../app/hooks";
import { Button } from "../../../shared/ui/Button";
import { cx } from "../../../shared/ui/cx";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { selectCurrentUser } from "../../auth/authSlice";
import { useGetRoomsQuery } from "../api";
import styles from "../chat.module.css";
import { Conversation } from "../components/Conversation";
import { RoomList } from "../components/RoomList";
import { type ChatDenial, chatDenial } from "../lib/access";
import { readerTimeZone } from "../lib/format";
import { useChatViewport } from "../lib/useChatViewport";
import { useChatConnection } from "../socket";

/** Relative times ("ayer", "9:41") are recomputed this often. */
const CLOCK_TICK_MS = 60_000;

/** Shown when the server refuses chat to an unverified account (403 `EMAIL_UNVERIFIED`). */
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

/** Shown for any other 403 on chat (never "verify your email"). */
export function ChatNoAccess(): ReactNode {
  return (
    <div className={styles.forbidden}>
      <EmptyState
        tone="lock"
        icon="🔒"
        title="No tienes acceso al chat"
        description="Si crees que es un error, escríbele a quien administra la página de la familia."
        action={<Button to="/">Ir al inicio</Button>}
      />
    </div>
  );
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
  const [messagesDenial, setMessagesDenial] = useState<ChatDenial | null>(null);
  const roomsDenial = chatDenial(rooms.error, me?.emailVerified);
  const forbidden = roomsDenial !== null || messagesDenial !== null;
  // Connect only once the server let us list the rooms (an unverified account gets a 403 there first).
  const { status: connection, reconnect } = useChatConnection(rooms.isSuccess && !forbidden);
  const layoutRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  const now = useMinuteClock();
  const [timeZone] = useState(readerTimeZone);
  useChatViewport(layoutRef, markerRef);
  const onForbidden = useCallback((denial: ChatDenial) => setMessagesDenial(denial), []);

  const denial = roomsDenial ?? messagesDenial ?? (connection === "unverified" || connection === "forbidden" ? connection : null);
  if (denial === "unverified") return <ChatForbidden />;
  if (denial === "forbidden") return <ChatNoAccess />;

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
