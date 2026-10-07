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
import { env } from "../../shared/lib/env";
import { isAllowedUploadUrl } from "./lib/uploadOrigin";

/**
 * Media gallery endpoints (T4). See docs/coordination/WP-T4-FE.md.
 *
 * The member list is an `infiniteQuery` (one cache entry per year, pages
 * appended by cursor). A full refetch re-runs every loaded page, so it is kept
 * for the rare cases that need it (expired presigned URLs, moderation).
 * Everything frequent stays cheap:
 * - polling for processing items fetches only the first page (`mediaHead`)
 *   and patches the fresh items into the list;
 * - confirm inserts the new item at the top; caption edits are optimistic;
 *   deletes remove the item locally.
 */

/** Items per gallery page (and per `mediaHead` poll). */
export const MEDIA_PAGE_SIZE = 30;
/** Items in the year-page preview strip. */
export const PREVIEW_SIZE = 6;
/** Admin queue page size. */
export const ADMIN_PAGE_SIZE = 20;

/** Admin queue filter without the cursor (the cursor is the page param). */
export type AdminMediaFilter = Omit<AdminMediaQueryRequest, "cursor" | "limit">;

/** Result of {@link galleryApi} `galleryYears`. */
export interface GalleryYears {
  /** Published editions, newest first. */
  years: number[];
  /** Newest edition that has visible media, else the newest past/current edition, else `null`. */
  defaultYear: number | null;
}

/** Args of `mediaHead`: the first page of a year. */
export interface MediaHeadArgs {
  year: number;
  limit: number;
}

/**
 * Year switcher + default year from the editions list (pure, for tests).
 *
 * @param editions - `GET /cuencadas` (any order).
 * @param now - Current time in ms.
 * @returns Years newest first and the default year.
 */
export function galleryYearsFrom(editions: readonly CuencadaSummary[], now: number): GalleryYears {
  const newestFirst = [...editions].sort((a, b) => b.year - a.year);
  const years = [...new Set(newestFirst.map((e) => e.year))];
  const withMedia = newestFirst.find((e) => e.hasMedia);
  // An announced edition (no dates yet) has not started, so it is never the default.
  const started = newestFirst.find((e) => e.startsAt !== null && Date.parse(e.startsAt) <= now);
  return { years, defaultYear: withMedia?.year ?? started?.year ?? years[0] ?? null };
}

/** Tag of the full (infinite) member list for one year. */
export function mediaListTag(year: number): { type: "Media"; id: string } {
  return { type: "Media", id: `LIST-${year}` };
}

/** Tag of the first-page queries (preview, processing poll) for one year. */
export function mediaHeadTag(year: number): { type: "Media"; id: string } {
  return { type: "Media", id: `HEAD-${year}` };
}

const ADMIN_LIST_TAG = { type: "Media", id: "ADMIN-LIST" } as const;
const YEARS_TAG = { type: "Media", id: "YEARS" } as const;

/**
 * Validates the upload intent: it is the one response whose URL the browser
 * sends a file to, so its shape and its origin (the configured bucket) are
 * checked, not trusted [SEC].
 */
function parseUploadIntent(raw: unknown): CreateUploadResponse {
  const parsed = createUploadResponseSchema.safeParse(raw);
  if (!parsed.success || !isAllowedUploadUrl(parsed.data.uploadUrl, env.mediaUploadOrigin)) {
    // The message is generic on purpose: the URL never reaches a toast or a log.
    throw new Error("Respuesta de subida inválida.");
  }
  return parsed.data;
}

/** The infinite list on its own, so the other endpoints can patch its cache with typed `updateQueryData`. */
const galleryListApi = baseApi.injectEndpoints({
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
      // No per-item tags: an item change must not reload every scrolled page.
      providesTags: (_result, _error, year) => [mediaListTag(year)]
    })
  })
});

/**
 * Replaces loaded items with fresh copies (new URLs, statuses, captions) and
 * puts items the list doesn't have yet at the top of the first page.
 */
function upsertIntoList(year: number, fresh: readonly MediaItem[]): ReturnType<typeof galleryListApi.util.updateQueryData> {
  return galleryListApi.util.updateQueryData("listMedia", year, (draft) => {
    const byId = new Map(fresh.map((item) => [item.id, item]));
    const seen = new Set<string>();
    for (const page of draft.pages) {
      page.items = page.items.map((item) => {
        seen.add(item.id);
        return byId.get(item.id) ?? item;
      });
    }
    const added = fresh.filter((item) => !seen.has(item.id));
    const first = draft.pages[0];
    if (first && added.length > 0) first.items.unshift(...added);
  });
}

/** Applies `change` to the loaded copy of one item. */
function patchListItem(year: number, id: string, change: (item: MediaItem) => void): ReturnType<typeof galleryListApi.util.updateQueryData> {
  return galleryListApi.util.updateQueryData("listMedia", year, (draft) => {
    for (const page of draft.pages) {
      const item = page.items.find((candidate) => candidate.id === id);
      if (item) change(item);
    }
  });
}

export const galleryApi = galleryListApi.injectEndpoints({
  endpoints: (build) => ({
    /**
     * First page of a year: the preview strip (`limit` 6) and the processing
     * poll (`limit` {@link MEDIA_PAGE_SIZE}). Fresh items are patched into the
     * infinite list, so polling never reloads the scrolled pages.
     */
    mediaHead: build.query<Page<MediaItem>, MediaHeadArgs>({
      query: ({ year, limit }) => ({ url: `/cuencadas/${year}/media`, params: { limit } }),
      providesTags: (_result, _error, { year }) => [mediaHeadTag(year)],
      async onQueryStarted({ year }, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;
          dispatch(upsertIntoList(year, data.items));
        } catch {
          // The query's own error state reports the failure; there is nothing to patch.
        }
      }
    }),

    /**
     * Editions for the year switcher plus the default year, from one
     * `GET /cuencadas`: the newest edition whose `CuencadaSummary.hasMedia` is
     * true (server-computed: ready + approved + not deleted), else the newest
     * one that has started, else the newest. No per-year probes.
     */
    galleryYears: build.query<GalleryYears, void>({
      query: () => ({ url: "/cuencadas" }),
      // contract: `GET /cuencadas` returns `CuencadaSummary[]`.
      transformResponse: (raw: unknown) => galleryYearsFrom((raw ?? []) as CuencadaSummary[], Date.now()),
      providesTags: [{ type: "Cuencada", id: "LIST" }, YEARS_TAG]
    }),

    /** Step 1 of an upload: the server returns a presigned PUT bound to type and length. */
    createUpload: build.mutation<CreateUploadResponse, { year: number; body: CreateUploadRequest }>({
      query: ({ year, body }) => ({ url: `/cuencadas/${year}/media/uploads`, method: "POST", body }),
      transformResponse: (raw: unknown) => parseUploadIntent(raw)
    }),

    /** Step 3: the server HEADs the object, checks magic bytes and starts processing. The item goes to the top of the list. */
    confirmUpload: build.mutation<MediaItem, { mediaId: string; year: number }>({
      query: ({ mediaId }) => ({ url: `/media/${mediaId}/confirm`, method: "POST", body: {} }),
      async onQueryStarted({ year }, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;
          dispatch(upsertIntoList(year, [data]));
        } catch {
          // The upload manager reports the failure on the row.
        }
      },
      invalidatesTags: (_result, error, { year }) => (error ? [] : [mediaHeadTag(year), YEARS_TAG, ADMIN_LIST_TAG])
    }),

    /** Uploader or admin edits the caption (optimistic; rolled back on failure). */
    updateMediaCaption: build.mutation<MediaItem, { id: string; year: number; caption: string | null }>({
      query: ({ id, caption }) => ({ url: `/media/${id}`, method: "PATCH", body: { caption } }),
      async onQueryStarted({ id, year, caption }, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          patchListItem(year, id, (item) => {
            item.caption = caption;
          })
        );
        try {
          const { data } = await queryFulfilled;
          dispatch(upsertIntoList(year, [data]));
        } catch {
          patch.undo();
        }
      },
      invalidatesTags: (_result, error, { year }) => (error ? [] : [mediaHeadTag(year), ADMIN_LIST_TAG])
    }),

    /** Uploader or admin soft-deletes an item; it is removed from the loaded list. */
    deleteMedia: build.mutation<void, { id: string; year: number }>({
      query: ({ id }) => ({ url: `/media/${id}`, method: "DELETE" }),
      async onQueryStarted({ id, year }, { dispatch, queryFulfilled }) {
        try {
          await queryFulfilled;
          dispatch(
            galleryListApi.util.updateQueryData("listMedia", year, (draft) => {
              for (const page of draft.pages) page.items = page.items.filter((item) => item.id !== id);
            })
          );
        } catch {
          // The caller shows the error.
        }
      },
      invalidatesTags: (_result, error, { year }) => (error ? [] : [mediaHeadTag(year), YEARS_TAG, ADMIN_LIST_TAG])
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
      providesTags: [ADMIN_LIST_TAG]
    }),

    /** Reports filed against one item (admin). */
    mediaReports: build.query<MediaReport[], string>({
      query: (id) => ({ url: `/admin/media/${id}/reports` }),
      providesTags: (_result, _error, id) => [{ type: "MediaReport", id }]
    }),

    /** Admin approve / hide / delete. Invalidates every gallery list (rare, admin only). */
    moderateMedia: build.mutation<AdminMediaItem, { id: string; body: ModerateMediaRequest }>({
      query: ({ id, body }) => ({ url: `/admin/media/${id}/moderate`, method: "POST", body }),
      invalidatesTags: (_result, error, { id }) => (error ? [] : ["Media", { type: "MediaReport", id }])
    })
  })
});

export const {
  useListMediaInfiniteQuery,
  useMediaHeadQuery,
  useGalleryYearsQuery,
  useUpdateMediaCaptionMutation,
  useDeleteMediaMutation,
  useReportMediaMutation,
  useListAdminMediaInfiniteQuery,
  useMediaReportsQuery,
  useModerateMediaMutation
} = galleryApi;
