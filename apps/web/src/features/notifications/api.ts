/**
 * The bell's unread count (WP-6.1), in the initial chunk on purpose: no zod,
 * no socket code. The feed and "marcar como leído" live in the lazy
 * `feedApi.ts` (the `/notificaciones` chunk).
 *
 * Kept fresh by polling while the window is focused and, whenever the chat
 * socket is open (the chat pages and `/notificaciones`), by the
 * `notification` frame's `unreadCount` (the frame was validated by the
 * socket against the contract before it reached the `events.ts` hub).
 */
import { NOTIFICATION_UNREAD_COUNT_MAX } from "@cuencada/types";
import { baseApi } from "../../shared/api/baseApi";
import { type ChatHubEvent, subscribeChatEventsOnceLoaded } from "../chat/events";

/** The feed page. */
export const NOTIFICATIONS_PATH = "/notificaciones";
/** How often the badge refreshes (paused while the window is unfocused). */
export const UNREAD_POLL_MS = 60_000;

/** Cache tags: the feed pages and the badge. */
export const FEED_TAG = { type: "Notification", id: "FEED" } as const;
export const UNREAD_TAG = { type: "Notification", id: "UNREAD" } as const;

/**
 * Reads `GET /notifications/unread-count` defensively (no zod in the initial
 * chunk): anything but an integer in range counts as 0.
 *
 * @param raw - The response body.
 * @returns The unread count, 0..{@link NOTIFICATION_UNREAD_COUNT_MAX}.
 */
export function parseUnreadCount(raw: unknown): number {
  if (typeof raw !== "object" || raw === null || !("count" in raw)) return 0;
  const { count } = raw;
  return typeof count === "number" && Number.isInteger(count) && count >= 0 && count <= NOTIFICATION_UNREAD_COUNT_MAX ? count : 0;
}

export const notificationsApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    /** `GET /notifications/unread-count`, also set by every `notification` frame. */
    getUnreadNotificationCount: build.query<number, void>({
      query: () => "/notifications/unread-count",
      transformResponse: (raw: unknown) => parseUnreadCount(raw),
      providesTags: [UNREAD_TAG],
      async onCacheEntryAdded(_arg, { cacheDataLoaded, cacheEntryRemoved, updateCachedData, dispatch }) {
        const unsubscribe = await subscribeChatEventsOnceLoaded(cacheDataLoaded, (event: ChatHubEvent) => {
          // After a reconnect frames may have been missed: ask again.
          if (event.type === "open" && event.resumed) {
            dispatch(notificationsApi.util.invalidateTags([UNREAD_TAG]));
            return;
          }
          if (event.type === "frame" && event.frame.type === "notification") {
            const next = event.frame.unreadCount;
            updateCachedData(() => next);
          }
        });
        if (unsubscribe === null) return;
        await cacheEntryRemoved;
        unsubscribe();
      }
    })
  })
});

export const { useGetUnreadNotificationCountQuery } = notificationsApi;
