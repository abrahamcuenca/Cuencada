/**
 * Events endpoints (WP-5.4) against the WP-5.2 contracts (routes:
 * `docs/coordination/WP-5.2.md`). Injected by the lazy events chunks only.
 *
 * Cache: one `Event` tag. Lists provide `LIST` (member list and Home strip)
 * or `ADMIN-LIST`; a detail provides its event id. Every write invalidates
 * the lists and that event (a changed `year/slug` is followed by navigating
 * to the URL in the response); participation and visibility changes also
 * refresh the chat room list (the event room appears or goes away).
 */
import type {
  AddEventParticipantsRequest,
  AdminCreateEventRequest,
  AdminEventListQueryRequest,
  AdminEventSummary,
  AdminUpdateEventRequest,
  CreateEventAlbumRequest,
  CreateEventRequest,
  EventAlbum,
  EventCoverUploadRequest,
  EventCoverUploadResponse,
  EventDetail,
  EventListWhen,
  EventRole,
  EventSummary,
  Page,
  UpdateEventAlbumRequest,
  UpdateEventRequest
} from "@cuencada/types";
import { baseApi } from "../../shared/api/baseApi";

/** Cards per `/eventos` page. */
export const EVENTS_PAGE_SIZE = 12;
/** Cards in Home's "Próximos eventos" strip. */
export const UPCOMING_STRIP_SIZE = 3;
/** Rows per admin page. */
export const ADMIN_EVENTS_PAGE_SIZE = 20;

/** `/eventos` filters (the cursor is the page param). */
export interface EventListFilter {
  when: EventListWhen;
  year?: number;
  mine?: boolean;
}

/** Admin list filters. */
export type AdminEventFilter = Omit<AdminEventListQueryRequest, "cursor" | "limit">;

/** `:year/:slug` of an event. */
export interface EventPath {
  year: number;
  slug: string;
}

/** An event id plus a body. */
export interface EventWrite<TBody> {
  id: string;
  body: TBody;
}

const LIST_TAG = { type: "Event", id: "LIST" } as const;
const ADMIN_LIST_TAG = { type: "Event", id: "ADMIN-LIST" } as const;
const CHAT_ROOMS_TAG = { type: "ChatRoom", id: "LIST" } as const;

function eventPath(id: string): string {
  return `/events/${encodeURIComponent(id)}`;
}

function listParams(filter: EventListFilter, cursor: string | null, limit: number): Record<string, string | number> {
  const params: Record<string, string | number> = { when: filter.when, limit };
  if (filter.year !== undefined) params.year = filter.year;
  if (filter.mine === true) params.mine = "true";
  if (cursor !== null) params.cursor = cursor;
  return params;
}

/** Tags every write that changes an event invalidates (the detail itself is upserted). */
function writeTags(id: string): Array<{ type: "Event" | "ChatRoom"; id: string }> {
  return [LIST_TAG, ADMIN_LIST_TAG, { type: "Event", id }];
}

export const eventsApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    /** `GET /events`: the cards the caller may see, keyset paged. */
    listEvents: build.infiniteQuery<Page<EventSummary>, EventListFilter, string | null>({
      infiniteQueryOptions: {
        initialPageParam: null,
        getNextPageParam: (lastPage) => lastPage.nextCursor
      },
      query: ({ queryArg, pageParam }) => ({ url: "/events", params: listParams(queryArg, pageParam, EVENTS_PAGE_SIZE) }),
      providesTags: [LIST_TAG]
    }),

    /** Home strip: the next {@link UPCOMING_STRIP_SIZE} upcoming events. */
    upcomingEvents: build.query<EventSummary[], void>({
      query: () => ({ url: "/events", params: listParams({ when: "upcoming" }, null, UPCOMING_STRIP_SIZE) }),
      transformResponse: (page: Page<EventSummary>) => page.items.slice(0, UPCOMING_STRIP_SIZE),
      providesTags: [LIST_TAG]
    }),

    /** `GET /events/:year/:slug`. A missing and an invisible event are the same 404. */
    getEvent: build.query<EventDetail, EventPath>({
      query: ({ year, slug }) => `/events/${year}/${encodeURIComponent(slug)}`,
      providesTags: (result) => (result ? [{ type: "Event", id: result.id }] : [])
    }),

    /** `POST /events` (any member; becomes organizer). */
    createEvent: build.mutation<EventDetail, CreateEventRequest>({
      query: (body) => ({ url: "/events", method: "POST", body }),
      invalidatesTags: (result) => (result ? [...writeTags(result.id), CHAT_ROOMS_TAG] : [])
    }),

    /** `POST /admin/events` (admins; may type a slug). */
    adminCreateEvent: build.mutation<EventDetail, AdminCreateEventRequest>({
      query: (body) => ({ url: "/admin/events", method: "POST", body }),
      invalidatesTags: (result) => (result ? [...writeTags(result.id), CHAT_ROOMS_TAG] : [])
    }),

    /** `PATCH /events/:id` (organizers and admins; `hidden` is admin-only). */
    updateEvent: build.mutation<EventDetail, EventWrite<UpdateEventRequest>>({
      query: ({ id, body }) => ({ url: eventPath(id), method: "PATCH", body }),
      // Publishing creates the room; hiding or tightening visibility removes it for some members.
      invalidatesTags: (result, _error, { id }) => (result ? [...writeTags(id), CHAT_ROOMS_TAG] : [])
    }),

    /** `PATCH /admin/events/:id` (admins; may change the slug). */
    adminUpdateEvent: build.mutation<EventDetail, EventWrite<AdminUpdateEventRequest>>({
      query: ({ id, body }) => ({ url: `/admin${eventPath(id)}`, method: "PATCH", body }),
      invalidatesTags: (result, _error, { id }) => (result ? [...writeTags(id), CHAT_ROOMS_TAG] : [])
    }),

    /** `DELETE /events/:id` (admins; organizers only for a media-free draft). */
    deleteEvent: build.mutation<void, { id: string }>({
      query: ({ id }) => ({ url: eventPath(id), method: "DELETE" }),
      invalidatesTags: (_result, error) => (error ? [] : [LIST_TAG, ADMIN_LIST_TAG, CHAT_ROOMS_TAG])
    }),

    /** "Me apunto": `POST /events/:id/join` (published `members` events). */
    joinEvent: build.mutation<EventDetail, { id: string }>({
      query: ({ id }) => ({ url: `${eventPath(id)}/join`, method: "POST", body: {} }),
      invalidatesTags: (result, _error, { id }) => (result ? [...writeTags(id), CHAT_ROOMS_TAG] : [])
    }),

    /** "Salir del evento": `DELETE /events/:id/participants/me`. */
    leaveEvent: build.mutation<void, { id: string }>({
      query: ({ id }) => ({ url: `${eventPath(id)}/participants/me`, method: "DELETE" }),
      invalidatesTags: (_result, error, { id }) => (error ? [] : [...writeTags(id), CHAT_ROOMS_TAG])
    }),

    /** Organizers/admins add members (from the directory). */
    addParticipants: build.mutation<EventDetail, EventWrite<AddEventParticipantsRequest>>({
      query: ({ id, body }) => ({ url: `${eventPath(id)}/participants`, method: "POST", body }),
      invalidatesTags: (result, _error, { id }) => (result ? writeTags(id) : [])
    }),

    /** Promote or demote. */
    updateParticipant: build.mutation<EventDetail, { id: string; userId: string; role: EventRole }>({
      query: ({ id, userId, role }) => ({ url: `${eventPath(id)}/participants/${encodeURIComponent(userId)}`, method: "PATCH", body: { role } }),
      invalidatesTags: (result, _error, { id }) => (result ? writeTags(id) : [])
    }),

    /** Remove someone (the server sends them `room_removed`). */
    removeParticipant: build.mutation<EventDetail, { id: string; userId: string }>({
      query: ({ id, userId }) => ({ url: `${eventPath(id)}/participants/${encodeURIComponent(userId)}`, method: "DELETE" }),
      invalidatesTags: (result, _error, { id }) => (result ? writeTags(id) : [])
    }),

    /** New album (≤ 20 per event). */
    createAlbum: build.mutation<EventAlbum, EventWrite<CreateEventAlbumRequest>>({
      query: ({ id, body }) => ({ url: `${eventPath(id)}/albums`, method: "POST", body }),
      invalidatesTags: (result, _error, { id }) => (result ? [{ type: "Event", id }] : [])
    }),

    /** Rename (or reorder) an album. */
    updateAlbum: build.mutation<EventAlbum, { id: string; albumId: string; body: UpdateEventAlbumRequest }>({
      query: ({ id, albumId, body }) => ({ url: `${eventPath(id)}/albums/${encodeURIComponent(albumId)}`, method: "PATCH", body }),
      invalidatesTags: (result, _error, { id }) => (result ? [{ type: "Event", id }] : [])
    }),

    /** Delete an empty album (409 `EVENT_ALBUM_NOT_EMPTY` otherwise). */
    deleteAlbum: build.mutation<void, { id: string; albumId: string }>({
      query: ({ id, albumId }) => ({ url: `${eventPath(id)}/albums/${encodeURIComponent(albumId)}`, method: "DELETE" }),
      invalidatesTags: (_result, error, { id }) => (error ? [] : [{ type: "Event", id }])
    }),

    /** Cover step 1: the avatar-style upload intent (validated by `usePhotoUpload` [SEC]). */
    createCoverUpload: build.mutation<EventCoverUploadResponse, EventWrite<EventCoverUploadRequest>>({
      query: ({ id, body }) => ({ url: `${eventPath(id)}/cover/uploads`, method: "POST", body })
    }),

    /** Cover step 3: the web crops 16:9 itself, so no `crop` is sent. */
    confirmCover: build.mutation<EventDetail, { id: string; uploadId: string }>({
      query: ({ id, uploadId }) => ({ url: `${eventPath(id)}/cover/uploads/${encodeURIComponent(uploadId)}/confirm`, method: "POST", body: {} }),
      invalidatesTags: (result, _error, { id }) => (result ? writeTags(id) : [])
    }),

    /** Remove the cover (back to the gradient). */
    deleteCover: build.mutation<EventDetail, { id: string }>({
      query: ({ id }) => ({ url: `${eventPath(id)}/cover`, method: "DELETE" }),
      invalidatesTags: (result, _error, { id }) => (result ? writeTags(id) : [])
    }),

    /** `GET /admin/events`: every event, hidden and drafts included. */
    listAdminEvents: build.infiniteQuery<Page<AdminEventSummary>, AdminEventFilter, string | null>({
      infiniteQueryOptions: {
        initialPageParam: null,
        getNextPageParam: (lastPage) => lastPage.nextCursor
      },
      query: ({ queryArg, pageParam }) => ({
        url: "/admin/events",
        params: pageParam === null ? { ...queryArg, limit: ADMIN_EVENTS_PAGE_SIZE } : { ...queryArg, limit: ADMIN_EVENTS_PAGE_SIZE, cursor: pageParam }
      }),
      providesTags: [ADMIN_LIST_TAG]
    })
  })
});

export const {
  useListEventsInfiniteQuery,
  useUpcomingEventsQuery,
  useGetEventQuery,
  useCreateEventMutation,
  useAdminCreateEventMutation,
  useUpdateEventMutation,
  useAdminUpdateEventMutation,
  useDeleteEventMutation,
  useJoinEventMutation,
  useLeaveEventMutation,
  useAddParticipantsMutation,
  useUpdateParticipantMutation,
  useRemoveParticipantMutation,
  useCreateAlbumMutation,
  useUpdateAlbumMutation,
  useDeleteAlbumMutation,
  useCreateCoverUploadMutation,
  useConfirmCoverMutation,
  useDeleteCoverMutation,
  useListAdminEventsInfiniteQuery
} = eventsApi;
