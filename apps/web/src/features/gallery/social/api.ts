import type {
  AdminReportedComment,
  CreateMediaTagRequest,
  MediaComment,
  MediaDetail,
  MediaItem,
  MediaLiker,
  MediaLikeState,
  MediaTag,
  Page,
  ReportMediaCommentRequest,
  TagCandidateList
} from "@cuencada/types";
import { baseApi } from "../../../shared/api/baseApi";
import { patchLoadedMedia } from "../api";

/**
 * Photo social endpoints (WP-6.2): the per-item detail behind the lightbox
 * and the `?foto=<id>` deep link, tags, hearts, likers, comments, the admin
 * comment-report queue and "Fotos de {persona}". ADR 0001 §8.
 *
 * Cache tags reuse the frozen tag types: `Media` (`DETAIL-`, `COMMENTS-`,
 * `LIKERS-` + media id), `Person` (`PHOTOS-` + person id) and
 * `MediaReport` (`COMMENTS`, the admin queue). Mutations patch the detail and
 * the loaded list copy in place instead of refetching (a refetched detail
 * would also re-sign the photo URL and reload the image).
 */

/** Comments per page in the drawer. */
export const COMMENTS_PAGE_SIZE = 20;
/** Likers per page in the sheet. */
export const LIKERS_PAGE_SIZE = 30;
/** Person photos per page ("Fotos" tab). */
export const PERSON_PHOTOS_PAGE_SIZE = 30;
/** Admin comment reports per page. */
export const COMMENT_REPORTS_PAGE_SIZE = 20;

/** The item a social mutation is about: its id plus where its list copy lives. */
export type SocialItem = Pick<MediaItem, "id" | "year" | "album">;

/** Tag of one item's detail. */
export function detailTag(mediaId: string): { type: "Media"; id: string } {
  return { type: "Media", id: `DETAIL-${mediaId}` };
}

/** Tag of one item's comment pages. */
export function commentsTag(mediaId: string): { type: "Media"; id: string } {
  return { type: "Media", id: `COMMENTS-${mediaId}` };
}

/** Tag of one item's likers. */
export function likersTag(mediaId: string): { type: "Media"; id: string } {
  return { type: "Media", id: `LIKERS-${mediaId}` };
}

/** Tag of a person's photos. */
export function personPhotosTag(personId: string): { type: "Person"; id: string } {
  return { type: "Person", id: `PHOTOS-${personId}` };
}

const COMMENT_REPORTS_TAG = { type: "MediaReport", id: "COMMENTS" } as const;
/** Every "Fotos de {persona}" list (a tag change can add or remove a photo from any of them). */
const PERSON_PHOTOS_ANY = { type: "Person", id: "PHOTOS" } as const;

/** Args of `tagCandidates`. */
export interface TagCandidatesArgs {
  mediaId: string;
  q: string;
}

/** Args of `adminCommentReports` (without the cursor). */
export interface CommentReportsFilter {
  includeDeleted: boolean;
}

function cursorParams(limit: number, cursor: string | null): Record<string, string | number> {
  return cursor === null ? { limit } : { limit, cursor };
}

const detailApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    /** Everything the lightbox shows for one item; also the lazy load of a `?foto=` deep link. 404 = not found or not visible. */
    mediaDetail: build.query<MediaDetail, string>({
      query: (id) => ({ url: `/media/${encodeURIComponent(id)}/detail` }),
      providesTags: (_result, _error, id) => [detailTag(id)]
    }),

    /** Comments, oldest first, by cursor. */
    mediaComments: build.infiniteQuery<Page<MediaComment>, string, string | null>({
      infiniteQueryOptions: { initialPageParam: null, getNextPageParam: (last) => last.nextCursor },
      query: ({ queryArg, pageParam }) => ({
        url: `/media/${encodeURIComponent(queryArg)}/comments`,
        params: cursorParams(COMMENTS_PAGE_SIZE, pageParam)
      }),
      providesTags: (_result, _error, id) => [commentsTag(id)]
    })
  })
});

type DetailPatch = ReturnType<typeof detailApi.util.updateQueryData>;

function patchDetail(mediaId: string, change: (draft: MediaDetail) => void): DetailPatch {
  return detailApi.util.updateQueryData("mediaDetail", mediaId, change);
}

export const socialApi = detailApi.injectEndpoints({
  endpoints: (build) => ({
    /** The tag picker: whatever the server returns (no client-side people list) [SEC]. */
    tagCandidates: build.query<TagCandidateList, TagCandidatesArgs>({
      query: ({ mediaId, q }) => ({ url: `/media/${encodeURIComponent(mediaId)}/tag-candidates`, params: { q, limit: 10 } }),
      keepUnusedDataFor: 30
    }),

    /** Tag a person (idempotent: an existing tag comes back). */
    addMediaTag: build.mutation<MediaTag, { item: SocialItem; body: CreateMediaTagRequest }>({
      query: ({ item, body }) => ({ url: `/media/${encodeURIComponent(item.id)}/tags`, method: "POST", body }),
      async onQueryStarted({ item }, { dispatch, queryFulfilled }) {
        try {
          const { data: tag } = await queryFulfilled;
          let count: number | null = null;
          dispatch(
            patchDetail(item.id, (draft) => {
              if (!draft.tags.some((existing) => existing.id === tag.id)) draft.tags.push(tag);
              count = draft.tags.length;
            })
          );
          const listPatch = patchLoadedMedia(item, (cached) => {
            if (count !== null) cached.tagCount = count;
          });
          if (listPatch !== null) dispatch(listPatch);
        } catch {
          // The caller shows the error.
        }
      },
      invalidatesTags: (_result, error) => (error ? [] : [PERSON_PHOTOS_ANY])
    }),

    /** The tagged user approves their pending tag. */
    approveMediaTag: build.mutation<MediaTag, { item: SocialItem; tagId: string }>({
      query: ({ tagId }) => ({ url: `/media/tags/${encodeURIComponent(tagId)}/approve`, method: "POST" }),
      async onQueryStarted({ item, tagId }, { dispatch, queryFulfilled }) {
        try {
          const { data: tag } = await queryFulfilled;
          dispatch(
            patchDetail(item.id, (draft) => {
              draft.tags = draft.tags.map((existing) => (existing.id === tagId ? tag : existing));
            })
          );
        } catch {
          // The caller shows the error.
        }
      },
      invalidatesTags: (_result, error) => (error ? [] : [PERSON_PHOTOS_ANY])
    }),

    /** Remove a tag, or decline a pending one (the tagged user). */
    removeMediaTag: build.mutation<void, { item: SocialItem; tagId: string }>({
      query: ({ item, tagId }) => ({ url: `/media/${encodeURIComponent(item.id)}/tags/${encodeURIComponent(tagId)}`, method: "DELETE" }),
      async onQueryStarted({ item, tagId }, { dispatch, queryFulfilled }) {
        try {
          await queryFulfilled;
          let count: number | null = null;
          dispatch(
            patchDetail(item.id, (draft) => {
              draft.tags = draft.tags.filter((existing) => existing.id !== tagId);
              count = draft.tags.length;
            })
          );
          const listPatch = patchLoadedMedia(item, (cached) => {
            if (count !== null) cached.tagCount = count;
          });
          if (listPatch !== null) dispatch(listPatch);
        } catch {
          // The caller shows the error.
        }
      },
      invalidatesTags: (_result, error) => (error ? [] : [PERSON_PHOTOS_ANY])
    }),

    /** Give or take back a heart (optimistic; the server's state wins). */
    setMediaLike: build.mutation<MediaLikeState, { item: SocialItem; liked: boolean }>({
      query: ({ item, liked }) => ({ url: `/media/${encodeURIComponent(item.id)}/like`, method: liked ? "PUT" : "DELETE" }),
      async onQueryStarted({ item, liked }, { dispatch, queryFulfilled }) {
        const apply = (state: MediaLikeState | null) => (cached: Pick<MediaItem, "likeCount" | "likedByMe">) => {
          if (state !== null) {
            cached.likeCount = state.likeCount;
            cached.likedByMe = state.likedByMe;
          } else if ((cached.likedByMe ?? false) !== liked) {
            cached.likeCount = Math.max(0, (cached.likeCount ?? 0) + (liked ? 1 : -1));
            cached.likedByMe = liked;
          }
        };
        const optimisticDetail = dispatch(patchDetail(item.id, (draft) => apply(null)(draft.likes)));
        const listPatch = patchLoadedMedia(item, apply(null));
        const optimisticList = listPatch === null ? null : dispatch(listPatch);
        try {
          const { data } = await queryFulfilled;
          dispatch(patchDetail(item.id, (draft) => apply(data)(draft.likes)));
          const settled = patchLoadedMedia(item, apply(data));
          if (settled !== null) dispatch(settled);
        } catch {
          optimisticDetail.undo();
          optimisticList?.undo();
        }
      },
      invalidatesTags: (_result, error, { item }) => (error ? [] : [likersTag(item.id)])
    }),

    /** Who gave a heart, newest first. */
    mediaLikers: build.infiniteQuery<Page<MediaLiker>, string, string | null>({
      infiniteQueryOptions: { initialPageParam: null, getNextPageParam: (last) => last.nextCursor },
      query: ({ queryArg, pageParam }) => ({
        url: `/media/${encodeURIComponent(queryArg)}/likes`,
        params: cursorParams(LIKERS_PAGE_SIZE, pageParam)
      }),
      providesTags: (_result, _error, id) => [likersTag(id)]
    }),

    /** Post a comment; `clientCommentId` makes a retry return the same comment. */
    addMediaComment: build.mutation<MediaComment, { item: SocialItem; body: string; clientCommentId: string }>({
      query: ({ item, body, clientCommentId }) => ({
        url: `/media/${encodeURIComponent(item.id)}/comments`,
        method: "POST",
        body: { body, clientCommentId }
      }),
      async onQueryStarted({ item }, { dispatch, getState, queryFulfilled }) {
        try {
          const { data: comment } = await queryFulfilled;
          // A replay (same client id) returns a comment the caches may already count.
          const loaded = detailApi.endpoints.mediaComments.select(item.id)(getState());
          const known = loaded.data?.pages.some((page) => page.items.some((existing) => existing.id === comment.id)) ?? false;
          if (known) return;
          dispatch(
            detailApi.util.updateQueryData("mediaComments", item.id, (draft) => {
              const last = draft.pages[draft.pages.length - 1];
              if (last && last.nextCursor === null) last.items.push(comment);
            })
          );
          dispatch(
            patchDetail(item.id, (draft) => {
              draft.commentCount += 1;
            })
          );
          const listPatch = patchLoadedMedia(item, (cached) => {
            cached.commentCount = (cached.commentCount ?? 0) + 1;
          });
          if (listPatch !== null) dispatch(listPatch);
        } catch {
          // The composer keeps the text and the client id for a retry.
        }
      }
    }),

    /** The author deletes their comment; it stays as a tombstone. */
    deleteMediaComment: build.mutation<void, { item: SocialItem; commentId: string }>({
      query: ({ commentId }) => ({ url: `/media/comments/${encodeURIComponent(commentId)}`, method: "DELETE" }),
      async onQueryStarted({ item, commentId }, { dispatch, queryFulfilled }) {
        try {
          await queryFulfilled;
          dispatch(
            detailApi.util.updateQueryData("mediaComments", item.id, (draft) => {
              for (const page of draft.pages) {
                for (const comment of page.items) {
                  if (comment.id === commentId) Object.assign(comment, { deleted: true, body: "", author: null, canDelete: false, canModerate: false });
                }
              }
            })
          );
          dispatch(
            patchDetail(item.id, (draft) => {
              draft.commentCount = Math.max(0, draft.commentCount - 1);
            })
          );
          const listPatch = patchLoadedMedia(item, (cached) => {
            cached.commentCount = Math.max(0, (cached.commentCount ?? 0) - 1);
          });
          if (listPatch !== null) dispatch(listPatch);
        } catch {
          // The caller shows the error.
        }
      }
    }),

    /** Report someone else's comment (once). */
    reportMediaComment: build.mutation<void, { commentId: string; body: ReportMediaCommentRequest }>({
      query: ({ commentId, body }) => ({ url: `/media/comments/${encodeURIComponent(commentId)}/report`, method: "POST", body }),
      invalidatesTags: (_result, error) => (error ? [] : [COMMENT_REPORTS_TAG])
    }),

    /** Admin: reported comments, newest report first. */
    adminCommentReports: build.infiniteQuery<Page<AdminReportedComment>, CommentReportsFilter, string | null>({
      infiniteQueryOptions: { initialPageParam: null, getNextPageParam: (last) => last.nextCursor },
      query: ({ queryArg, pageParam }) => ({
        url: "/admin/media/comment-reports",
        params: { ...cursorParams(COMMENT_REPORTS_PAGE_SIZE, pageParam), ...(queryArg.includeDeleted ? { includeDeleted: "true" } : {}) }
      }),
      providesTags: [COMMENT_REPORTS_TAG]
    }),

    /** Admin: delete (moderate) a comment; audited on the server. */
    adminDeleteMediaComment: build.mutation<void, { commentId: string; mediaId: string }>({
      query: ({ commentId }) => ({ url: `/admin/media/comments/${encodeURIComponent(commentId)}`, method: "DELETE" }),
      invalidatesTags: (_result, error, { mediaId }) => (error ? [] : [COMMENT_REPORTS_TAG, commentsTag(mediaId), detailTag(mediaId)])
    }),

    /** "Fotos de {persona}": photos the caller can see where the person is tagged. */
    personPhotos: build.infiniteQuery<Page<MediaItem>, string, string | null>({
      infiniteQueryOptions: { initialPageParam: null, getNextPageParam: (last) => last.nextCursor },
      query: ({ queryArg, pageParam }) => ({
        url: `/family/people/${encodeURIComponent(queryArg)}/photos`,
        params: cursorParams(PERSON_PHOTOS_PAGE_SIZE, pageParam)
      }),
      providesTags: (_result, _error, personId) => [personPhotosTag(personId), PERSON_PHOTOS_ANY]
    })
  })
});

export const {
  useMediaDetailQuery,
  useMediaCommentsInfiniteQuery,
  useTagCandidatesQuery,
  useAddMediaTagMutation,
  useApproveMediaTagMutation,
  useRemoveMediaTagMutation,
  useSetMediaLikeMutation,
  useMediaLikersInfiniteQuery,
  useAddMediaCommentMutation,
  useDeleteMediaCommentMutation,
  useReportMediaCommentMutation,
  useAdminCommentReportsInfiniteQuery,
  useAdminDeleteMediaCommentMutation,
  usePersonPhotosInfiniteQuery
} = socialApi;
