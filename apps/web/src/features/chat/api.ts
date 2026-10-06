import { CHAT_HISTORY_LIMIT_MAX, type ChatHistoryPage, type ChatRoom, type ChatTicketResponse } from "@cuencada/types";
import type { WithAuthState } from "../auth/authSlice";
import { baseApi } from "../../shared/api/baseApi";
import { type ChatHubEvent, getViewingRoom, sendChatFrame, subscribeChatEvents } from "./events";
import {
  applyDeletedMessage,
  applyDeletedToRooms,
  applyHistoryPreview,
  applyIncomingMessage,
  applyMessageToRooms,
  applyReadToRooms,
  type ChatRoomView,
  type ChatThread,
  lastServerMessage,
  mergeLatestPage,
  mergeRoomLists,
  roomsFromResponse,
  setLocalStatus,
  threadFromPage
} from "./lib/thread";

/** Messages per history page (the contract's maximum). */
export const CHAT_PAGE_SIZE = CHAT_HISTORY_LIMIT_MAX;

/** Args of `getMessagesBefore`. */
export interface OlderMessagesArgs {
  roomId: string;
  before: string;
}

/** Args of `markRoomRead`. */
export interface MarkRoomReadArgs {
  roomId: string;
  messageId: string;
}

/** Args of `deleteChatMessage`. */
export interface DeleteChatMessageArgs {
  roomId: string;
  messageId: string;
}

function roomPath(roomId: string): string {
  return `/chat/rooms/${encodeURIComponent(roomId)}`;
}

function currentUserId(state: unknown): string | null {
  // RTK Query types lifecycle `getState()` as its own RootState; the store's state always has `auth` (store.ts).
  return (state as WithAuthState).auth.user?.id ?? null;
}

/**
 * Chat endpoints (T7). Live updates arrive through `onCacheEntryAdded`: the
 * socket (`socket.ts`, loaded with the chat pages) validates every frame and
 * emits it on the `events.ts` hub, and each cache entry merges what concerns
 * it. Outside the chat routes there is no socket, so the room list (and the
 * BottomNav badge) relies on polling instead.
 */
export const chatApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    /** `GET /chat/rooms`, kept live by `message`/`message_deleted` frames. */
    getRooms: build.query<ChatRoomView[], void>({
      query: () => "/chat/rooms",
      // `merge` keeps previews we learnt from frames when the list is refetched.
      transformResponse: (rooms: ChatRoom[]) => roomsFromResponse(rooms),
      merge: (current, incoming) => mergeRoomLists(current, incoming),
      providesTags: [{ type: "ChatRoom", id: "LIST" }],
      async onCacheEntryAdded(_arg, { cacheDataLoaded, cacheEntryRemoved, updateCachedData, getState, dispatch }) {
        try {
          await cacheDataLoaded;
        } catch {
          return;
        }
        const unsubscribe = subscribeChatEvents((event: ChatHubEvent) => {
          if (event.type === "open" && event.resumed) {
            dispatch(chatApi.util.invalidateTags([{ type: "ChatRoom", id: "LIST" }]));
            return;
          }
          if (event.type !== "frame") return;
          const { frame } = event;
          if (frame.type === "message") {
            let found = true;
            updateCachedData((rooms) => {
              const result = applyMessageToRooms(rooms, frame.message, {
                meId: currentUserId(getState()),
                viewingRoomId: getViewingRoom()?.roomId ?? null
              });
              found = result.found;
              return result.rooms;
            });
            // A brand-new edition room: fetch the list again to learn its title.
            if (!found) dispatch(chatApi.util.invalidateTags([{ type: "ChatRoom", id: "LIST" }]));
          } else if (frame.type === "message_deleted") {
            updateCachedData((rooms) => applyDeletedToRooms(rooms, frame.roomId, frame.messageId));
          }
        });
        await cacheEntryRemoved;
        unsubscribe();
      }
    }),

    /**
     * `GET /chat/rooms/:id/messages`, the latest page. Live frames are merged
     * in; older pages are prepended by `loadOlderMessages`.
     */
    getMessages: build.query<ChatThread, string>({
      query: (roomId) => ({ url: `${roomPath(roomId)}/messages`, params: { limit: CHAT_PAGE_SIZE } }),
      transformResponse: (page: ChatHistoryPage) => threadFromPage(page),
      // A refetch (after a reconnect) merges instead of replacing, keeping older pages and pending messages.
      merge: (current, incoming) => mergeLatestPage(current, incoming),
      providesTags: (_result, _error, roomId) => [{ type: "ChatMessage", id: roomId }],
      keepUnusedDataFor: 300,
      async onQueryStarted(roomId, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;
          const newest = lastServerMessage(data);
          if (newest !== undefined) {
            dispatch(chatApi.util.updateQueryData("getRooms", undefined, (rooms) => applyHistoryPreview(rooms, roomId, newest)));
          }
        } catch {
          // The page renders the error state.
        }
      },
      async onCacheEntryAdded(roomId, { cacheDataLoaded, cacheEntryRemoved, updateCachedData, getCacheEntry, dispatch }) {
        try {
          await cacheDataLoaded;
        } catch {
          return;
        }
        const unsubscribe = subscribeChatEvents((event: ChatHubEvent) => {
          if (event.type === "open") {
            // Resend what is still pending (the server dedupes by clientMessageId).
            for (const message of getCacheEntry().data?.messages ?? []) {
              if (message.status === "pending" && message.clientMessageId !== null) {
                sendChatFrame({ type: "send", roomId, body: message.body, clientMessageId: message.clientMessageId });
              }
            }
            if (event.resumed) dispatch(chatApi.util.invalidateTags([{ type: "ChatMessage", id: roomId }]));
            return;
          }
          if (event.type === "send_failed") {
            updateCachedData((thread) => setLocalStatus(thread, event.clientMessageId, "failed"));
            return;
          }
          const { frame } = event;
          if (frame.type === "message" && frame.message.roomId === roomId) {
            updateCachedData((thread) => applyIncomingMessage(thread, frame.message, frame.clientMessageId));
          } else if (frame.type === "message_deleted" && frame.roomId === roomId) {
            updateCachedData((thread) => applyDeletedMessage(thread, frame.messageId));
          } else if (frame.type === "error" && frame.clientMessageId !== null) {
            const failedId = frame.clientMessageId;
            updateCachedData((thread) => setLocalStatus(thread, failedId, "failed"));
          }
        });
        await cacheEntryRemoved;
        unsubscribe();
      }
    }),

    /** One older history page (`before` cursor). Not cached: `loadOlderMessages` prepends it to `getMessages`. */
    getMessagesBefore: build.query<ChatHistoryPage, OlderMessagesArgs>({
      query: ({ roomId, before }) => ({ url: `${roomPath(roomId)}/messages`, params: { before, limit: CHAT_PAGE_SIZE } }),
      keepUnusedDataFor: 0
    }),

    /** `POST /chat/rooms/:id/read`. Clears the room's unread count optimistically. */
    markRoomRead: build.mutation<void, MarkRoomReadArgs>({
      query: ({ roomId, messageId }) => ({ url: `${roomPath(roomId)}/read`, method: "POST", body: { messageId } }),
      onQueryStarted({ roomId, messageId }, { dispatch }) {
        dispatch(chatApi.util.updateQueryData("getRooms", undefined, (rooms) => applyReadToRooms(rooms, roomId, messageId)));
      }
    }),

    /** `POST /chat/ticket`: a single-use, 30 s WebSocket ticket. Call with `track: false`. */
    createChatTicket: build.mutation<ChatTicketResponse, void>({
      query: () => ({ url: "/chat/ticket", method: "POST" })
    }),

    /** `DELETE /chat/messages/:id` (mine, or any as admin). Tombstones the cached copy on success. */
    deleteChatMessage: build.mutation<void, DeleteChatMessageArgs>({
      query: ({ messageId }) => ({ url: `/chat/messages/${encodeURIComponent(messageId)}`, method: "DELETE" }),
      async onQueryStarted({ roomId, messageId }, { dispatch, queryFulfilled }) {
        try {
          await queryFulfilled;
        } catch {
          return;
        }
        dispatch(chatApi.util.updateQueryData("getMessages", roomId, (thread) => applyDeletedMessage(thread, messageId)));
        dispatch(chatApi.util.updateQueryData("getRooms", undefined, (rooms) => applyDeletedToRooms(rooms, roomId, messageId)));
      }
    })
  })
});

export const {
  useGetRoomsQuery,
  useGetMessagesQuery,
  useMarkRoomReadMutation,
  useDeleteChatMessageMutation
} = chatApi;
