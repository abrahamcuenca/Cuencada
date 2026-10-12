/**
 * Memory Box endpoints (WP-6.3, "Baúl de recuerdos") against the WP-6.0
 * contracts (`packages/types/src/memories.ts`; routes in
 * `docs/coordination/WP-6.0.md`). Injected by the lazy memories chunks only.
 *
 * Cache: one `MemoryAlbum` tag. The member list provides `LIST` (the page
 * and Home's strip), the panel `ADMIN-LIST`, a box page its id. Every admin
 * write invalidates both lists and that box; the box's media live in the
 * gallery's `listMemoryMedia` (gallery `api.ts`), whose uploads and deletes
 * invalidate the box's tags in turn.
 */
import type {
  AdminMemoryAlbum,
  AdminMemoryAlbumList,
  CreateMemoryAlbumRequest,
  MemoryAlbumDetail,
  MemoryAlbumList,
  UpdateMemoryAlbumRequest
} from "@cuencada/types";
import { baseApi } from "../../shared/api/baseApi";

const LIST_TAG = { type: "MemoryAlbum", id: "LIST" } as const;
const ADMIN_LIST_TAG = { type: "MemoryAlbum", id: "ADMIN-LIST" } as const;

function boxTag(id: string): { type: "MemoryAlbum"; id: string } {
  return { type: "MemoryAlbum", id };
}

function boxPath(id: string): string {
  return `/memories/${encodeURIComponent(id)}`;
}

function adminPath(id: string): string {
  return `/admin/memory-albums/${encodeURIComponent(id)}`;
}

export const memoriesApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    /** Published boxes, in the admins' order. */
    listMemories: build.query<MemoryAlbumList, void>({
      query: () => ({ url: "/memories" }),
      providesTags: [LIST_TAG]
    }),

    /** One box (404 for a draft or hidden box, the same as a missing one). */
    memoryAlbum: build.query<MemoryAlbumDetail, string>({
      query: (id) => ({ url: boxPath(id) }),
      providesTags: (_result, _error, id) => [boxTag(id)]
    }),

    /** Admin panel: every box, every status. */
    listAdminMemories: build.query<AdminMemoryAlbumList, void>({
      query: () => ({ url: "/admin/memory-albums" }),
      providesTags: [ADMIN_LIST_TAG]
    }),

    /** Admin: create (draft unless `status` says otherwise). */
    createMemoryAlbum: build.mutation<AdminMemoryAlbum, CreateMemoryAlbumRequest>({
      query: (body) => ({ url: "/admin/memory-albums", method: "POST", body }),
      invalidatesTags: (_result, error) => (error ? [] : [LIST_TAG, ADMIN_LIST_TAG])
    }),

    /** Admin: edit, cover, publish / hide / draft. */
    updateMemoryAlbum: build.mutation<AdminMemoryAlbum, { id: string; body: UpdateMemoryAlbumRequest }>({
      query: ({ id, body }) => ({ url: adminPath(id), method: "PATCH", body }),
      invalidatesTags: (_result, error, { id }) => (error ? [] : [LIST_TAG, ADMIN_LIST_TAG, boxTag(id)])
    }),

    /** Admin: delete an empty box (409 `MEMORY_ALBUM_NOT_EMPTY` otherwise). */
    deleteMemoryAlbum: build.mutation<void, string>({
      query: (id) => ({ url: adminPath(id), method: "DELETE" }),
      invalidatesTags: (_result, error, id) => (error ? [] : [LIST_TAG, ADMIN_LIST_TAG, boxTag(id)])
    }),

    /**
     * Admin: the new order (every box id). Optimistic: the panel list is
     * reordered at once and rolled back on failure (409 when the set changed).
     */
    reorderMemoryAlbums: build.mutation<AdminMemoryAlbumList, string[]>({
      query: (ids) => ({ url: "/admin/memory-albums/order", method: "PUT", body: { ids } }),
      async onQueryStarted(ids, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          memoriesApi.util.updateQueryData("listAdminMemories", undefined, (draft) => {
            const byId = new Map(draft.items.map((item) => [item.id, item]));
            const reordered = ids.flatMap((id, index) => {
              const item = byId.get(id);
              return item === undefined ? [] : [{ ...item, sortOrder: index }];
            });
            if (reordered.length === draft.items.length) draft.items = reordered;
          })
        );
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      },
      invalidatesTags: (_result, error) => (error ? [ADMIN_LIST_TAG] : [LIST_TAG, ADMIN_LIST_TAG])
    })
  })
});

export const {
  useListMemoriesQuery,
  useMemoryAlbumQuery,
  useListAdminMemoriesQuery,
  useCreateMemoryAlbumMutation,
  useUpdateMemoryAlbumMutation,
  useDeleteMemoryAlbumMutation,
  useReorderMemoryAlbumsMutation
} = memoriesApi;
