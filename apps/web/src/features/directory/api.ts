import type { DirectoryEntry, DirectoryQueryRequest, Page } from "@cuencada/types";
import { baseApi } from "../../shared/api/baseApi";

/** Rows per directory page. */
export const DIRECTORY_PAGE_SIZE = 30;

/**
 * Seconds an unused directory result stays in memory. Kept short on purpose:
 * the directory is PII and lives only in the in-memory RTK Query cache (which
 * logout resets), never in web storage or a persistent cache.
 */
const DIRECTORY_CACHE_SECONDS = 30;

/**
 * Search and filters of the list. `city` is in T5-BE's `directoryQuerySchema`
 * (matched only on visible cities); TODO(T5-BE): drop the intersection once it is on main.
 */
export type DirectoryFilters = Pick<DirectoryQueryRequest, "q" | "familyBranch"> & { city?: string };

/**
 * Member directory endpoints (T5). Responses are `DirectoryEntry`s: contact
 * fields are absent unless the member chose to show them.
 */
export const directoryApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    /** `GET /directory`, one cache entry per search/filter, pages appended by cursor. */
    listDirectory: build.infiniteQuery<Page<DirectoryEntry>, DirectoryFilters, string | null>({
      infiniteQueryOptions: {
        initialPageParam: null,
        getNextPageParam: (lastPage) => lastPage.nextCursor
      },
      query: ({ queryArg, pageParam }) => ({
        url: "/directory",
        params: pageParam === null ? { ...queryArg, limit: DIRECTORY_PAGE_SIZE } : { ...queryArg, limit: DIRECTORY_PAGE_SIZE, cursor: pageParam }
      }),
      keepUnusedDataFor: DIRECTORY_CACHE_SECONDS,
      providesTags: [{ type: "Directory", id: "LIST" }]
    }),

    /** `GET /directory/:userId`. */
    getDirectoryEntry: build.query<DirectoryEntry, string>({
      query: (userId) => `/directory/${encodeURIComponent(userId)}`,
      keepUnusedDataFor: DIRECTORY_CACHE_SECONDS,
      providesTags: (_result, _error, userId) => [{ type: "Directory", id: userId }]
    })
  })
});

export const { useListDirectoryInfiniteQuery, useGetDirectoryEntryQuery } = directoryApi;
