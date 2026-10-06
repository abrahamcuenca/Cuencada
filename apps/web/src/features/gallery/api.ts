import {
  type AdminMediaItem,
  type AdminMediaQueryRequest,
  type CreateUploadRequest,
  type CreateUploadResponse,
  type CuencadaSummary,
  createUploadResponseSchema,
  type MediaItem,
  type MediaReport,
  type ModerateMediaRequest,
  type Page,
  type ReportMediaRequest
} from "@cuencada/types";
import { baseApi } from "../../shared/api/baseApi";

/**
 * Media gallery endpoints (T4). See docs/coordination/WP-T4-FE.md.
 *
 * Pagination uses RTK Query's `infiniteQuery` (one cache entry per year,
 * pages appended by cursor). A refetch, poll or tag invalidation re-runs every
 * loaded page from the first cursor, so fresh presigned URLs replace the old
 * ones everywhere and new uploads show up at the top.
 */

/** Items per gallery page. */
export const MEDIA_PAGE_SIZE = 30;
/** Items in the year-page preview strip. */
export const PREVIEW_SIZE = 6;
/** Admin queue page size. */
export const ADMIN_PAGE_SIZE = 20;
/** How many recent editions are probed when looking for the latest year with media. */
const DEFAULT_YEAR_PROBES = 5;

/** Admin queue filter without the cursor (the cursor is the page param). */
export type AdminMediaFilter = Omit<AdminMediaQueryRequest, "cursor" | "limit">;

/** Result of {@link galleryApi} `galleryYears`. */
export interface GalleryYears {
  /** Published editions, newest first. */
  years: number[];
  /** Newest edition that has visible media, else the newest past/current edition, else `null`. */
  defaultYear: number | null;
}

/** Tag id of the member list for one year. */
export function mediaListTag(year: number): { type: "Media"; id: string } {
  return { type: "Media", id: `LIST-${year}` };
}

const ADMIN_LIST_TAG = { type: "Media", id: "ADMIN-LIST" } as const;
const YEARS_TAG = { type: "Media", id: "YEARS" } as const;

/** Rejects a presigned upload that would leave the browser over plain HTTP in production [SEC]. */
function isAllowedUploadUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return import.meta.env.DEV && url.protocol === "http:";
}

/**
 * Validates the upload intent: it is the one response whose URL the browser
 * sends a file to, so its shape and scheme are checked, not trusted.
 */
function parseUploadIntent(raw: unknown): CreateUploadResponse {
  const parsed = createUploadResponseSchema.safeParse(raw);
  if (!parsed.success || !isAllowedUploadUrl(parsed.data.uploadUrl)) {
    // The message is generic on purpose: the URL never reaches a toast or a log.
    throw new Error("Respuesta de subida inválida.");
  }
  return parsed.data;
}

export const galleryApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    /** Member gallery for one year, newest first, by cursor. */
    listMedia: build.infiniteQuery<Page<MediaItem>, number, string | null>({
      infiniteQueryOptions: {
        initialPageParam: null,
        getNextPageParam: (lastPage) => lastPage.nextCursor
      },
      query: ({ queryArg: year, pageParam }) => ({
        url: `/cuencadas/${year}/media`,
        params: pageParam === null ? { limit: MEDIA_PAGE_SIZE } : { limit: MEDIA_PAGE_SIZE, cursor: pageParam }
      }),
      providesTags: (result, _error, year) => [
        mediaListTag(year),
        ...(result?.pages ?? []).flatMap((page) => page.items.map((item) => ({ type: "Media" as const, id: item.id })))
      ]
    }),

    /** First few items for {@link GalleryPreview}. */
    mediaPreview: build.query<Page<MediaItem>, number>({
      query: (year) => ({ url: `/cuencadas/${year}/media`, params: { limit: PREVIEW_SIZE } }),
      providesTags: (result, _error, year) => [mediaListTag(year), ...(result?.items ?? []).map((item) => ({ type: "Media" as const, id: item.id }))]
    }),

    /**
     * Editions for the year switcher plus the default year. There is no
     * "years with media" endpoint, so up to {@link DEFAULT_YEAR_PROBES} editions
     * are probed newest first with `limit=1` (see Requests in WP-T4-FE.md).
     */
    galleryYears: build.query<GalleryYears, void>({
      async queryFn(_arg, _api, _extra, baseQuery) {
        const list = await baseQuery({ url: "/cuencadas" });
        if (list.error) return { error: list.error };
        // contract: `GET /cuencadas` returns `CuencadaSummary[]`, newest first.
        const editions = (list.data ?? []) as CuencadaSummary[];
        const now = Date.now();
        const years = [...new Set(editions.map((e) => e.year))].sort((a, b) => b - a);
        const started = editions.filter((e) => Date.parse(e.startsAt) <= now).map((e) => e.year).sort((a, b) => b - a);

        for (const year of years.slice(0, DEFAULT_YEAR_PROBES)) {
          const probe = await baseQuery({ url: `/cuencadas/${year}/media`, params: { limit: 1 } });
          if (probe.error) return { error: probe.error };
          // contract: `GET /cuencadas/:year/media` returns `Page<MediaItem>`.
          const page = probe.data as Page<MediaItem>;
          if (page.items.length > 0) return { data: { years, defaultYear: year } };
        }
        return { data: { years, defaultYear: started[0] ?? years[0] ?? null } };
      },
      providesTags: [{ type: "Cuencada", id: "LIST" }, YEARS_TAG]
    }),

    /** Step 1 of an upload: the server returns a presigned PUT bound to type and length. */
    createUpload: build.mutation<CreateUploadResponse, { year: number; body: CreateUploadRequest }>({
      query: ({ year, body }) => ({ url: `/cuencadas/${year}/media/uploads`, method: "POST", body }),
      transformResponse: (raw: unknown) => parseUploadIntent(raw)
    }),

    /** Step 3: the server HEADs the object, checks magic bytes and starts processing. */
    confirmUpload: build.mutation<MediaItem, { mediaId: string; year: number }>({
      query: ({ mediaId }) => ({ url: `/media/${mediaId}/confirm`, method: "POST", body: {} }),
      invalidatesTags: (_result, error, { year }) => (error ? [] : [mediaListTag(year), YEARS_TAG, ADMIN_LIST_TAG])
    }),

    /** Uploader or admin edits the caption. */
    updateMediaCaption: build.mutation<MediaItem, { id: string; caption: string | null }>({
      query: ({ id, caption }) => ({ url: `/media/${id}`, method: "PATCH", body: { caption } }),
      invalidatesTags: (_result, error, { id }) => (error ? [] : [{ type: "Media", id }, ADMIN_LIST_TAG])
    }),

    /** Uploader or admin soft-deletes an item. */
    deleteMedia: build.mutation<void, { id: string; year: number }>({
      query: ({ id }) => ({ url: `/media/${id}`, method: "DELETE" }),
      invalidatesTags: (_result, error, { id, year }) => (error ? [] : [{ type: "Media", id }, mediaListTag(year), YEARS_TAG, ADMIN_LIST_TAG])
    }),

    /** Any member reports an item (once per item). */
    reportMedia: build.mutation<void, { id: string; body: ReportMediaRequest }>({
      query: ({ id, body }) => ({ url: `/media/${id}/report`, method: "POST", body }),
      invalidatesTags: (_result, error, { id }) => (error ? [] : [{ type: "MediaReport", id }, ADMIN_LIST_TAG])
    }),

    /** Admin moderation queue, by cursor. */
    listAdminMedia: build.infiniteQuery<Page<AdminMediaItem>, AdminMediaFilter, string | null>({
      infiniteQueryOptions: {
        initialPageParam: null,
        getNextPageParam: (lastPage) => lastPage.nextCursor
      },
      query: ({ queryArg, pageParam }) => ({
        url: "/admin/media",
        params: pageParam === null ? { ...queryArg, limit: ADMIN_PAGE_SIZE } : { ...queryArg, limit: ADMIN_PAGE_SIZE, cursor: pageParam }
      }),
      providesTags: (result) => [
        ADMIN_LIST_TAG,
        ...(result?.pages ?? []).flatMap((page) => page.items.map((item) => ({ type: "Media" as const, id: item.id })))
      ]
    }),

    /** Reports filed against one item (admin). */
    mediaReports: build.query<MediaReport[], string>({
      query: (id) => ({ url: `/admin/media/${id}/reports` }),
      providesTags: (_result, _error, id) => [{ type: "MediaReport", id }]
    }),

    /** Admin approve / hide / delete. Invalidates every gallery list. */
    moderateMedia: build.mutation<AdminMediaItem, { id: string; body: ModerateMediaRequest }>({
      query: ({ id, body }) => ({ url: `/admin/media/${id}/moderate`, method: "POST", body }),
      invalidatesTags: (_result, error, { id }) => (error ? [] : ["Media", { type: "MediaReport", id }])
    })
  })
});

export const {
  useListMediaInfiniteQuery,
  useMediaPreviewQuery,
  useGalleryYearsQuery,
  useUpdateMediaCaptionMutation,
  useDeleteMediaMutation,
  useReportMediaMutation,
  useListAdminMediaInfiniteQuery,
  useMediaReportsQuery,
  useModerateMediaMutation
} = galleryApi;

