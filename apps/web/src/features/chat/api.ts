import type { ChatRoom } from "@cuencada/types";
import { baseApi } from "../../shared/api/baseApi";
import type { WithAuthState } from "../auth/authSlice";
import { type ChatHubEvent, getViewingRoom, subscribeChatEventsOnceLoaded } from "./events";
import { applyDeletedToRooms, applyMessageToRooms, type ChatRoomView, mergeRoomLists, roomsFromResponse } from "./lib/rooms";

function currentUserId(state: unknown): string | null {
  // RTK Query types lifecycle `getState()` as its own RootState; the store's state always has `auth` (store.ts).
  return (state as WithAuthState).auth.user?.id ?? null;
}

/**
 * Chat endpoints needed outside the chat pages (T7): only the room list,
 * which feeds the "Chat" tab badge. The conversation endpoints live in
 * `conversationApi.ts`, injected by the lazy chat chunk.
 *
 * Live updates arrive through `onCacheEntryAdded`: the socket (`socket.ts`,
 * loaded with the chat pages) validates every frame and emits it on the
 * `events.ts` hub, and each cache entry merges what concerns it. Outside the
 * chat routes there is no socket, so the badge relies on polling instead.
 */
export const chatApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    /** `GET /chat/rooms`, kept live by `message`/`message_deleted` frames. */
    getRooms: build.query<ChatRoomView[], void>({
      query: () => "/chat/rooms",
      transformResponse: (rooms: ChatRoom[]) => roomsFromResponse(rooms),
      // A refetch keeps a newer preview learnt from a frame.
      merge: (current, incoming) => mergeRoomLists(current, incoming),
      providesTags: [{ type: "ChatRoom", id: "LIST" }],
      async onCacheEntryAdded(_arg, { cacheDataLoaded, cacheEntryRemoved, updateCachedData, getState, dispatch }) {
        // Subscribed before the first load resolves: frames that arrive meanwhile are buffered, not lost.
        const unsubscribe = await subscribeChatEventsOnceLoaded(cacheDataLoaded, (event: ChatHubEvent) => {
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
        if (unsubscribe === null) return;
        await cacheEntryRemoved;
        unsubscribe();
      }
    })
  })
});

export const { useGetRoomsQuery } = chatApi;
