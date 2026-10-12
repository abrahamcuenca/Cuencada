import { useEffect, useRef } from "react";
import { subscribeChatEvents } from "../events";

/**
 * Toast after `room_removed` (WP-5.4): the member was removed from the event,
 * left it elsewhere, or the event was hidden, deleted or made participants-only.
 *
 * @param title - The event's (or room's) title.
 */
export function roomRemovedMessage(title: string): string {
  return `Ya no participas en ${title}.`;
}

/**
 * Calls `onRemoved` for every `room_removed` frame the chat socket delivers.
 * The room list and the room's cached history are already cleaned up by the
 * RTK Query cache entries (`api.ts`, `conversationApi.ts`); pages use this to
 * close an open conversation and tell the member.
 *
 * @param onRemoved - Receives the removed room id. Need not be stable.
 */
export function useRoomRemoved(onRemoved: (roomId: string) => void): void {
  const handler = useRef(onRemoved);
  useEffect(() => {
    handler.current = onRemoved;
  });
  useEffect(
    () =>
      subscribeChatEvents((event) => {
        if (event.type === "frame" && event.frame.type === "room_removed") handler.current(event.frame.roomId);
      }),
    []
  );
}
