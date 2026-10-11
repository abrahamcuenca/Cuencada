/**
 * Consent notices endpoints (WP-5.3 contract: `EventNotice`,
 * `eventNoticeSchema`, `EVENT_NOTICES_MAX` in `@cuencada/types`):
 * - `GET /api/events/notices`: undismissed "someone else added you" notices,
 *   only for events the caller can see, newest first;
 * - `DELETE /api/events/:id/notice`: "Entendido" (204, idempotent);
 * - "Salir" is `DELETE /api/events/:id/participants/me`.
 *
 * Kept apart from the rest of the events API on purpose: WP-6 replaces this
 * with a general notifications bell.
 */
import { EVENT_NOTICES_MAX, type EventNotice, eventNoticeSchema } from "@cuencada/types";
import { baseApi } from "../../../shared/api/baseApi";

/** Cache tag of the notice list (the leave mutation invalidates it too). */
export const NOTICES_TAG = { type: "Event", id: "NOTICES" } as const;

/**
 * Validates the list item by item with the contract's `eventNoticeSchema`:
 * a malformed notice is dropped (never rendered) without hiding the others;
 * at most {@link EVENT_NOTICES_MAX}.
 *
 * @param raw - The `GET /events/notices` body.
 * @returns The valid notices.
 */
export function parseEventNotices(raw: unknown): EventNotice[] {
  if (typeof raw !== "object" || raw === null || !("items" in raw) || !Array.isArray(raw.items)) return [];
  const items: unknown[] = raw.items;
  return items.slice(0, EVENT_NOTICES_MAX).flatMap((item) => {
    const parsed = eventNoticeSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

export const eventNoticesApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    /** `GET /events/notices`: validated; malformed items are dropped. */
    listEventNotices: build.query<EventNotice[], void>({
      query: () => "/events/notices",
      transformResponse: (raw: unknown) => parseEventNotices(raw),
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
