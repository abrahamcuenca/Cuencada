/**
 * Consent notices endpoints (WP-5.3 contract, see `contract.ts`). Kept
 * apart from the rest of the events API on purpose: WP-6 replaces this with
 * a general notifications bell.
 */
import { baseApi } from "../../../shared/api/baseApi";
import { type EventNotice, parseEventNoticeList } from "./contract";

/** Cache tag of the notice list (the leave mutation invalidates it too). */
export const NOTICES_TAG = { type: "Event", id: "NOTICES" } as const;

export const eventNoticesApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    /** `GET /events/notices`: validated; malformed items are dropped. */
    listEventNotices: build.query<EventNotice[], void>({
      query: () => "/events/notices",
      transformResponse: (raw: unknown) => parseEventNoticeList(raw).items,
      providesTags: [NOTICES_TAG]
    }),

    /** "Entendido": `DELETE /events/:id/notice` (204, idempotent). Removed from the cache at once. */
    dismissEventNotice: build.mutation<void, { eventId: string }>({
      query: ({ eventId }) => ({ url: `/events/${encodeURIComponent(eventId)}/notice`, method: "DELETE" }),
      async onQueryStarted({ eventId }, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          eventNoticesApi.util.updateQueryData("listEventNotices", undefined, (notices) => notices.filter((notice) => notice.event.id !== eventId))
        );
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      }
    })
  })
});

export const { useListEventNoticesQuery, useDismissEventNoticeMutation } = eventNoticesApi;
