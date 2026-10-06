/**
 * Chat thunks: optimistic send, retry, discard and older-history loading.
 * Loaded with the chat pages (lazy chunk).
 */
import { chatBodySchema } from "@cuencada/types";
import type { AppDispatch, RootState } from "../../app/store";
import { chatApi } from "./api";
import { sendChatFrame } from "./events";
import { appendPendingMessage, prependOlderPage, removeLocalMessage, setLocalStatus, type ThreadMessage } from "./lib/thread";
import { createClientMessageId } from "./lib/uuid";

/** A thunk for this store. */
export type ChatThunk<TResult> = (dispatch: AppDispatch, getState: () => RootState) => TResult;

/** Result of {@link sendChatMessage}. */
export type SendResult = { ok: true; clientMessageId: string } | { ok: false; error: string };

/** Result of {@link loadOlderMessages}: `loaded` carries the new oldest cached message id. */
export type LoadOlderResult = { status: "loaded"; firstId: string | null } | { status: "end" } | { status: "error" };

/**
 * Sends a message optimistically: it appears at once as `pending`, goes out
 * on the socket if it is open (or on the next `open`), turns `sent` when the
 * echo with the same `clientMessageId` arrives, and `failed` on an error
 * frame or after the echo timeout.
 *
 * @param roomId - The room.
 * @param rawBody - What the user typed.
 * @returns The thunk.
 */
export function sendChatMessage(roomId: string, rawBody: string): ChatThunk<SendResult> {
  return (dispatch, getState) => {
    const parsed = chatBodySchema.safeParse(rawBody);
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "El mensaje no es válido." };
    const user = getState().auth.user;
    if (user === null) return { ok: false, error: "Inicia sesión para escribir." };
    const clientMessageId = createClientMessageId();
    const message: ThreadMessage = {
      id: clientMessageId,
      roomId,
      sender: { userId: user.id, displayName: user.displayName, avatarUrl: user.avatarUrl },
      body: parsed.data,
      createdAt: new Date().toISOString(),
      deletedAt: null,
      clientMessageId,
      status: "pending"
    };
    dispatch(chatApi.util.updateQueryData("getMessages", roomId, (thread) => appendPendingMessage(thread, message)));
    sendChatFrame({ type: "send", roomId, body: message.body, clientMessageId });
    return { ok: true, clientMessageId };
  };
}

/**
 * Retries a failed message with the same `clientMessageId`, so the server
 * and the echo dedupe it if the first attempt did arrive.
 *
 * @param roomId - The room.
 * @param clientMessageId - The failed message.
 * @returns The thunk.
 */
export function retryChatMessage(roomId: string, clientMessageId: string): ChatThunk<void> {
  return (dispatch, getState) => {
    const thread = chatApi.endpoints.getMessages.select(roomId)(getState()).data;
    const message = thread?.messages.find((entry) => entry.status !== "sent" && entry.clientMessageId === clientMessageId);
    if (message === undefined) return;
    dispatch(chatApi.util.updateQueryData("getMessages", roomId, (draft) => setLocalStatus(draft, clientMessageId, "pending")));
    sendChatFrame({ type: "send", roomId, body: message.body, clientMessageId });
  };
}

/**
 * Drops a failed message from the screen.
 *
 * @param roomId - The room.
 * @param clientMessageId - The failed message.
 * @returns The thunk.
 */
export function discardChatMessage(roomId: string, clientMessageId: string): ChatThunk<void> {
  return (dispatch) => {
    dispatch(chatApi.util.updateQueryData("getMessages", roomId, (thread) => removeLocalMessage(thread, clientMessageId)));
  };
}

/**
 * Fetches the page before the oldest cached message and prepends it.
 *
 * @param roomId - The room.
 * @returns The thunk; resolves to `end` when there is nothing older.
 */
export function loadOlderMessages(roomId: string): ChatThunk<Promise<LoadOlderResult>> {
  return async (dispatch, getState) => {
    const before = chatApi.endpoints.getMessages.select(roomId)(getState()).data?.nextBefore ?? null;
    if (before === null) return { status: "end" };
    try {
      const page = await dispatch(
        chatApi.endpoints.getMessagesBefore.initiate({ roomId, before }, { subscribe: false, forceRefetch: true })
      ).unwrap();
      // Only apply it if nothing else moved the cursor meanwhile (a double tap, a gap refetch).
      dispatch(chatApi.util.updateQueryData("getMessages", roomId, (thread) => (thread.nextBefore === before ? prependOlderPage(thread, page) : thread)));
      const firstId = chatApi.endpoints.getMessages.select(roomId)(getState()).data?.messages[0]?.id ?? null;
      return { status: "loaded", firstId };
    } catch {
      return { status: "error" };
    }
  };
}
