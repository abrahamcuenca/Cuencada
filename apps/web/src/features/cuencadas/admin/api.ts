import type {
  AdminAnnouncementQueryRequest,
  AdminCuencada,
  AdminCuencadaDetail,
  Announcement,
  CreateAnnouncementRequest,
  CreateCuencadaRequest,
  CreateItineraryItemRequest,
  CreateLocationRequest,
  DailyMessage,
  DailyMessagesImportRequest,
  DailyMessagesImportResult,
  ItineraryItem,
  LocationItem,
  UpdateAnnouncementRequest,
  UpdateCuencadaRequest,
  UpdateItineraryItemRequest,
  UpdateLocationRequest
} from "@cuencada/types";
import type { ApiTagType } from "../../../shared/api/baseApi";
import { baseApi } from "../../../shared/api/baseApi";

type Tag = { type: ApiTagType; id: string };

const HOME: Tag = { type: "CuencadaHome", id: "HOME" };
const CUENCADA_LIST: Tag = { type: "Cuencada", id: "LIST" };
const ITINERARY_LIST: Tag = { type: "Itinerary", id: "LIST" };
const LOCATION_LIST: Tag = { type: "Location", id: "LIST" };
const MESSAGE_LIST: Tag = { type: "DailyMessage", id: "LIST" };
const ANNOUNCEMENT_LIST: Tag = { type: "Announcement", id: "LIST" };

/** `PATCH /admin/cuencadas/:id` args. */
export interface UpdateCuencadaArgs {
  id: string;
  patch: UpdateCuencadaRequest;
}

/** Args of the child-collection mutations of one Cuencada. */
export interface CuencadaChildArgs<TBody> {
  cuencadaId: string;
  body: TBody;
}

/** `PATCH` of an item by id. */
export interface PatchArgs<TBody> {
  id: string;
  patch: TBody;
}

/** `PUT …/order` args: every id of the list, in the new order. */
export interface ReorderArgs {
  cuencadaId: string;
  ids: string[];
}

/**
 * Admin content endpoints (T2), injected only when an admin screen loads.
 * Every mutation invalidates the public reads too (home, `/cuencada/:year`),
 * so an admin sees the change right away on the public pages.
 */
export const cuencadasAdminApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    listAdminCuencadas: build.query<AdminCuencada[], void>({
      query: () => "/admin/cuencadas",
      providesTags: (result) => [CUENCADA_LIST, ...(result ?? []).map((cuencada) => ({ type: "Cuencada" as const, id: cuencada.id }))]
    }),
    getAdminCuencada: build.query<AdminCuencadaDetail, string>({
      query: (id) => `/admin/cuencadas/${encodeURIComponent(id)}`,
      providesTags: (_result, _error, id) => [{ type: "Cuencada", id }, ITINERARY_LIST, LOCATION_LIST, ANNOUNCEMENT_LIST, MESSAGE_LIST]
    }),
    createCuencada: build.mutation<AdminCuencada, CreateCuencadaRequest>({
      query: (body) => ({ url: "/admin/cuencadas", method: "POST", body }),
      invalidatesTags: [CUENCADA_LIST, HOME]
    }),
    updateCuencada: build.mutation<AdminCuencada, UpdateCuencadaArgs>({
      query: ({ id, patch }) => ({ url: `/admin/cuencadas/${encodeURIComponent(id)}`, method: "PATCH", body: patch }),
      invalidatesTags: (_result, _error, { id }) => [{ type: "Cuencada", id }, CUENCADA_LIST, HOME]
    }),
    deleteCuencada: build.mutation<void, string>({
      query: (id) => ({ url: `/admin/cuencadas/${encodeURIComponent(id)}`, method: "DELETE" }),
      invalidatesTags: (_result, _error, id) => [{ type: "Cuencada", id }, CUENCADA_LIST, HOME]
    }),

    createItineraryItem: build.mutation<ItineraryItem, CuencadaChildArgs<CreateItineraryItemRequest>>({
      query: ({ cuencadaId, body }) => ({ url: `/admin/cuencadas/${encodeURIComponent(cuencadaId)}/itinerary`, method: "POST", body }),
      invalidatesTags: [ITINERARY_LIST, HOME]
    }),
    updateItineraryItem: build.mutation<ItineraryItem, PatchArgs<UpdateItineraryItemRequest>>({
      query: ({ id, patch }) => ({ url: `/admin/itinerary/${encodeURIComponent(id)}`, method: "PATCH", body: patch }),
      invalidatesTags: [ITINERARY_LIST, HOME]
    }),
    deleteItineraryItem: build.mutation<void, string>({
      query: (id) => ({ url: `/admin/itinerary/${encodeURIComponent(id)}`, method: "DELETE" }),
      invalidatesTags: [ITINERARY_LIST, HOME]
    }),
    reorderItinerary: build.mutation<ItineraryItem[], ReorderArgs>({
      query: ({ cuencadaId, ids }) => ({ url: `/admin/cuencadas/${encodeURIComponent(cuencadaId)}/itinerary/order`, method: "PUT", body: { ids } }),
      // Optimistic: move the rows at once on the phone, roll back if the server refuses.
      async onQueryStarted({ cuencadaId, ids }, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          cuencadasAdminApi.util.updateQueryData("getAdminCuencada", cuencadaId, (draft) => {
            draft.itinerary = reorderById(draft.itinerary, ids);
          })
        );
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      },
      invalidatesTags: [ITINERARY_LIST, HOME]
    }),

    createLocation: build.mutation<LocationItem, CuencadaChildArgs<CreateLocationRequest>>({
      query: ({ cuencadaId, body }) => ({ url: `/admin/cuencadas/${encodeURIComponent(cuencadaId)}/locations`, method: "POST", body }),
      invalidatesTags: [LOCATION_LIST, HOME]
    }),
    updateLocation: build.mutation<LocationItem, PatchArgs<UpdateLocationRequest>>({
      query: ({ id, patch }) => ({ url: `/admin/locations/${encodeURIComponent(id)}`, method: "PATCH", body: patch }),
      // Itinerary rows show their location's name.
      invalidatesTags: [LOCATION_LIST, ITINERARY_LIST, HOME]
    }),
    deleteLocation: build.mutation<void, string>({
      query: (id) => ({ url: `/admin/locations/${encodeURIComponent(id)}`, method: "DELETE" }),
      invalidatesTags: [LOCATION_LIST, ITINERARY_LIST, HOME]
    }),
    reorderLocations: build.mutation<LocationItem[], ReorderArgs>({
      query: ({ cuencadaId, ids }) => ({ url: `/admin/cuencadas/${encodeURIComponent(cuencadaId)}/locations/order`, method: "PUT", body: { ids } }),
      async onQueryStarted({ cuencadaId, ids }, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          cuencadasAdminApi.util.updateQueryData("getAdminCuencada", cuencadaId, (draft) => {
            draft.locations = reorderById(draft.locations, ids);
          })
        );
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      },
      invalidatesTags: [LOCATION_LIST, HOME]
    }),

    listDailyMessages: build.query<DailyMessage[], string>({
      query: (cuencadaId) => `/admin/cuencadas/${encodeURIComponent(cuencadaId)}/daily-messages`,
      providesTags: [MESSAGE_LIST]
    }),
    importDailyMessages: build.mutation<DailyMessagesImportResult, CuencadaChildArgs<DailyMessagesImportRequest>>({
      query: ({ cuencadaId, body }) => ({ url: `/admin/cuencadas/${encodeURIComponent(cuencadaId)}/daily-messages/import`, method: "POST", body }),
      invalidatesTags: [MESSAGE_LIST, HOME, { type: "Cuencada", id: "LIST" }]
    }),
    deleteDailyMessage: build.mutation<void, { cuencadaId: string; date: string }>({
      query: ({ cuencadaId, date }) => ({
        url: `/admin/cuencadas/${encodeURIComponent(cuencadaId)}/daily-messages/${encodeURIComponent(date)}`,
        method: "DELETE"
      }),
      invalidatesTags: [MESSAGE_LIST, HOME]
    }),

    listAdminAnnouncements: build.query<Announcement[], AdminAnnouncementQueryRequest>({
      query: (params) => ({ url: "/admin/announcements", params }),
      providesTags: [ANNOUNCEMENT_LIST]
    }),
    createAnnouncement: build.mutation<Announcement, CreateAnnouncementRequest>({
      query: (body) => ({ url: "/admin/announcements", method: "POST", body }),
      invalidatesTags: [ANNOUNCEMENT_LIST, HOME]
    }),
    updateAnnouncement: build.mutation<Announcement, PatchArgs<UpdateAnnouncementRequest>>({
      query: ({ id, patch }) => ({ url: `/admin/announcements/${encodeURIComponent(id)}`, method: "PATCH", body: patch }),
      invalidatesTags: [ANNOUNCEMENT_LIST, HOME]
    }),
    deleteAnnouncement: build.mutation<void, string>({
      query: (id) => ({ url: `/admin/announcements/${encodeURIComponent(id)}`, method: "DELETE" }),
      invalidatesTags: [ANNOUNCEMENT_LIST, HOME]
    })
  })
});

/**
 * Reorders `items` to follow `ids`, renumbering `sortOrder`. Items missing
 * from `ids` keep their relative order at the end.
 *
 * @param items - The current list.
 * @param ids - The requested order.
 * @returns A new array in the requested order.
 */
export function reorderById<TItem extends { id: string; sortOrder: number }>(items: readonly TItem[], ids: readonly string[]): TItem[] {
  const position = new Map(ids.map((id, index) => [id, index]));
  return [...items]
    .sort((a, b) => (position.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (position.get(b.id) ?? Number.MAX_SAFE_INTEGER))
    .map((item, index) => ({ ...item, sortOrder: index }));
}

export const {
  useListAdminCuencadasQuery,
  useGetAdminCuencadaQuery,
  useCreateCuencadaMutation,
  useUpdateCuencadaMutation,
  useDeleteCuencadaMutation,
  useCreateItineraryItemMutation,
  useUpdateItineraryItemMutation,
  useDeleteItineraryItemMutation,
  useReorderItineraryMutation,
  useCreateLocationMutation,
  useUpdateLocationMutation,
  useDeleteLocationMutation,
  useReorderLocationsMutation,
  useListDailyMessagesQuery,
  useImportDailyMessagesMutation,
  useDeleteDailyMessageMutation,
  useListAdminAnnouncementsQuery,
  useCreateAnnouncementMutation,
  useUpdateAnnouncementMutation,
  useDeleteAnnouncementMutation
} = cuencadasAdminApi;
