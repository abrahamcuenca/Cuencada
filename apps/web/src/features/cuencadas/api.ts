import type { Announcement, CuencadaHome, CuencadaSummary, MemberCuencadaDetails, Page, PublicCuencada } from "@cuencada/types";
import { baseApi } from "../../shared/api/baseApi";

/**
 * Tags every Cuencada content read provides, so any admin edit (itinerary,
 * locations, announcements, daily messages) refreshes the public pages too.
 */
const CONTENT_LIST_TAGS = [
  { type: "Itinerary", id: "LIST" },
  { type: "Location", id: "LIST" },
  { type: "Announcement", id: "LIST" },
  { type: "DailyMessage", id: "LIST" }
] as const;

/**
 * Public and member Cuencada reads (T2). Admin endpoints live in
 * `admin/api.ts` so their code ships only with the admin chunk.
 *
 * - `GET /cuencadas/home` and `GET /cuencadas/:year` are public and are the
 *   responses the PWA (T9) caches for offline use.
 * - `GET /cuencadas/:year/members` needs a session; the page only asks for it
 *   when someone is logged in.
 */
export const cuencadasApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    getCuencadaHome: build.query<CuencadaHome, void>({
      query: () => "/cuencadas/home",
      providesTags: (result) => [
        { type: "CuencadaHome", id: "HOME" },
        { type: "Cuencada", id: "LIST" },
        ...(result?.featured ? [{ type: "Cuencada" as const, id: result.featured.id }] : []),
        ...CONTENT_LIST_TAGS
      ]
    }),
    listCuencadas: build.query<CuencadaSummary[], void>({
      query: () => "/cuencadas",
      providesTags: (result) => [
        { type: "Cuencada", id: "LIST" },
        ...(result ?? []).map((cuencada) => ({ type: "Cuencada" as const, id: cuencada.id }))
      ]
    }),
    getCuencada: build.query<PublicCuencada, number>({
      query: (year) => `/cuencadas/${year}`,
      providesTags: (result, _error, year) => [
        { type: "Cuencada", id: result?.id ?? `year:${year}` },
        ...CONTENT_LIST_TAGS
      ]
    }),
    getCuencadaMembers: build.query<MemberCuencadaDetails, number>({
      query: (year) => `/cuencadas/${year}/members`,
      providesTags: (result, _error, year) => [
        { type: "Cuencada", id: result?.cuencadaId ?? `year:${year}` },
        ...CONTENT_LIST_TAGS
      ]
    }),
    /** Portal-wide announcements visible to members (first page). */
    listMemberAnnouncements: build.query<Announcement[], void>({
      query: () => ({ url: "/announcements", params: { limit: 20 } }),
      transformResponse: (page: Page<Announcement>) => page.items,
      providesTags: [{ type: "Announcement", id: "LIST" }]
    })
  })
});

export const {
  useGetCuencadaHomeQuery,
  useListCuencadasQuery,
  useGetCuencadaQuery,
  useGetCuencadaMembersQuery,
  useListMemberAnnouncementsQuery
} = cuencadasApi;
