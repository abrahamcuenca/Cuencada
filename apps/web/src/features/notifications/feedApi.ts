/**
 * Feed endpoints (WP-6.1), injected by the lazy `/notificaciones` chunk:
 * - `GET /notifications` (keyset pages, newest first): every item is
 *   validated with the contract's `notificationSchema`; a malformed one is
 *   dropped without hiding the others;
 * - `POST /notifications/read` (`{ ids }` or `{ all: true }`): optimistic in
 *   the feed, and its answer is the new unread count for the bell.
 *
 * A `notification` frame (chat socket, validated) puts the entry on top of
 * the first page, replacing an older copy of the same row (coalescing).
 */
import {
  type MarkNotificationsReadRequest,
  type Notification as AppNotification,
  notificationSchema,
  type Page
} from "@cuencada/types";
import { baseApi } from "../../shared/api/baseApi";
import { type ChatHubEvent, subscribeChatEventsOnceLoaded } from "../chat/events";
import { FEED_TAG, notificationsApi, parseUnreadCount } from "./api";

/** Entries per page. */
export const NOTIFICATIONS_PAGE_SIZE = 30;

/**
 * Validates a page item by item.
 *
 * @param raw - The `GET /notifications` body.
 * @returns The valid entries and the next cursor.
 */
export function parseNotificationPage(raw: unknown): Page<AppNotification> {
  if (typeof raw !== "object" || raw === null || !("items" in raw) || !Array.isArray(raw.items)) return { items: [], nextCursor: null };
  const items: unknown[] = raw.items;
  const nextCursor = "nextCursor" in raw && typeof raw.nextCursor === "string" ? raw.nextCursor : null;
  return {
    items: items.flatMap((item) => {
      const parsed = notificationSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }),
    nextCursor
  };
}

/** The infinite-query cache shape. */
interface FeedPages {
  pages: Array<Page<AppNotification>>;
  pageParams: Array<string | null>;
}

/** Puts `notification` on top, dropping any older copy of the same row from every page. */
export function upsertIntoFeed(feed: FeedPages, notification: AppNotification): void {
  for (const page of feed.pages) page.items = page.items.filter((item) => item.id !== notification.id);
  const first = feed.pages[0];
  if (first === undefined) feed.pages.push({ items: [notification], nextCursor: null });
  else first.items.unshift(notification);
}

/** Marks entries read in place (`"all"` or a set of ids). */
export function markReadInFeed(feed: FeedPages, ids: ReadonlySet<string> | "all", seenAt: string): void {
  for (const page of feed.pages) {
    for (const item of page.items) {
      if (item.seenAt === null && (ids === "all" || ids.has(item.id))) item.seenAt = seenAt;
    }
  }
}

export const feedApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    /** `GET /notifications`, newest first. */
    listNotifications: build.infiniteQuery<Page<AppNotification>, void, string | null>({
      infiniteQueryOptions: {
        initialPageParam: null,
        getNextPageParam: (lastPage) => lastPage.nextCursor
      },
      query: ({ pageParam }) => ({
        url: "/notifications",
        params: pageParam === null ? { limit: NOTIFICATIONS_PAGE_SIZE } : { limit: NOTIFICATIONS_PAGE_SIZE, cursor: pageParam }
      }),
      transformResponse: (raw: unknown) => parseNotificationPage(raw),
      providesTags: [FEED_TAG],
      async onCacheEntryAdded(_arg, { cacheDataLoaded, cacheEntryRemoved, updateCachedData, dispatch }) {
        const unsubscribe = await subscribeChatEventsOnceLoaded(cacheDataLoaded, (event: ChatHubEvent) => {
          if (event.type === "open" && event.resumed) {
            dispatch(feedApi.util.invalidateTags([FEED_TAG]));
            return;
          }
          if (event.type === "frame" && event.frame.type === "notification") {
            const { notification } = event.frame;
            updateCachedData((feed) => upsertIntoFeed(feed, notification));
          }
        });
        if (unsubscribe === null) return;
        await cacheEntryRemoved;
        unsubscribe();
      }
    }),

    /** `POST /notifications/read`: answers the new unread count (set on the bell). */
    markNotificationsRead: build.mutation<number, MarkNotificationsReadRequest>({
      query: (body) => ({ url: "/notifications/read", method: "POST", body }),
      transformResponse: (raw: unknown) => parseUnreadCount(raw),
      async onQueryStarted(body, { dispatch, queryFulfilled }) {
        const ids = "all" in body ? "all" : new Set(body.ids);
        const patch = dispatch(
          feedApi.util.updateQueryData("listNotifications", undefined, (feed) => markReadInFeed(feed, ids, new Date().toISOString()))
        );
        try {
          const { data: count } = await queryFulfilled;
          dispatch(notificationsApi.util.updateQueryData("getUnreadNotificationCount", undefined, () => count));
        } catch {
          patch.undo();
        }
      }
    })
  })
});

export const { useListNotificationsInfiniteQuery, useMarkNotificationsReadMutation } = feedApi;
