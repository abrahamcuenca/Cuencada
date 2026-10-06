/**
 * Tiny in-tab event hub between the chat socket (`socket.ts`, lazy chunk) and
 * the RTK Query cache lifecycles in `api.ts` (initial chunk, via the unread
 * badge). It has no zod and no WebSocket code, so importing it costs almost
 * nothing.
 *
 * Only frames that already passed `wsServerMessageSchema` are emitted here.
 */
import type { WsClientMessageRequest, WsServerMessage } from "@cuencada/types";
import { reportUnexpected } from "../../shared/lib/reportUnexpected";

/** Something the chat cache entries react to. */
export type ChatHubEvent =
  /** A validated server → client frame. */
  | { type: "frame"; frame: WsServerMessage }
  /** The socket opened. `resumed` is true after a reconnect (frames may have been missed). */
  | { type: "open"; resumed: boolean }
  /** No echo arrived in time for a `send` frame. */
  | { type: "send_failed"; clientMessageId: string };

/** Listener registered with {@link subscribeChatEvents}. */
export type ChatHubListener = (event: ChatHubEvent) => void;

/** Sends a client frame on the open socket. Returns false when not connected. */
export type ChatTransport = (frame: WsClientMessageRequest) => boolean;

/** The room the user is reading right now (visible tab, scrolled to the bottom). */
export interface ViewingRoom {
  roomId: string;
}

const listeners = new Set<ChatHubListener>();
let transport: ChatTransport | null = null;
let viewing: ViewingRoom | null = null;

/**
 * Subscribes to chat events.
 *
 * @param listener - Called for every event.
 * @returns An unsubscribe function.
 */
export function subscribeChatEvents(listener: ChatHubListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Delivers an event to every listener. A throwing listener never stops the others.
 *
 * @param event - The event to deliver.
 */
export function emitChatEvent(event: ChatHubEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (error) {
      // A cache updater bug must not break the socket loop.
      reportUnexpected(error);
    }
  }
}

/**
 * Registers (or clears) the function that writes frames to the open socket.
 *
 * @param next - The socket's sender, or `null` when there is no socket.
 */
export function setChatTransport(next: ChatTransport | null): void {
  transport = next;
}

/**
 * Sends a frame if a socket is open.
 *
 * @param frame - A client → server frame.
 * @returns Whether it was written to an open socket.
 */
export function sendChatFrame(frame: WsClientMessageRequest): boolean {
  return transport === null ? false : transport(frame);
}

/**
 * Marks the room being read (or none). Incoming messages for it do not bump
 * the unread counter, because the conversation marks them read.
 *
 * @param next - The room in view, or `null`.
 */
export function setViewingRoom(next: ViewingRoom | null): void {
  viewing = next;
}

/** @returns The room currently in view, or `null`. */
export function getViewingRoom(): ViewingRoom | null {
  return viewing;
}

/** Test helper: forgets every listener, the transport and the viewing room. */
export function resetChatEventsForTests(): void {
  listeners.clear();
  transport = null;
  viewing = null;
}
