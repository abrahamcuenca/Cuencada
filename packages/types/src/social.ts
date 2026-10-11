/**
 * Photo social features (WP-6.0 contracts; WP-6.2 implements): people tags,
 * hearts ("Me gusta") and comments on a media item, plus the per-item detail
 * read the lightbox uses. Authorization: ADR 0001 §8 (binding).
 *
 * Every route here first loads the media item through the media scope
 * (`mediaScopeSql` + member visibility): a photo the caller cannot see is
 * 404 `NOT_FOUND` on every route, before any other check. Tags, likes and
 * comments therefore always inherit the photo's scope.
 *
 * Re-exported by `chat.ts` (the barrel is frozen).
 */
import { z } from "zod";
import {
  type Page,
  cursorSchema,
  dateTimeSchema,
  hasVisibleChars,
  idSchema,
  pageSchema,
  queryBooleanSchema,
  cursorQuerySchema,
  stripUnsafeChars
} from "./common.js";
import {
  type MediaItem,
  type MediaReport,
  mediaItemSchema,
  mediaReportSchema,
  reportMediaInputSchema
} from "./media.js";

/* -------------------------------------------------------------------------- */
/* Limits and codes                                                            */
/* -------------------------------------------------------------------------- */

/** Most people tagged in one item (409 `CONFLICT` + `TAG_LIMIT` beyond it). */
export const MEDIA_TAGS_MAX = 30;
/** Longest comment, after cleaning (DB CHECK `media_comments_body_check`). */
export const MEDIA_COMMENT_MAX_LENGTH = 1000;
/** Default and maximum comments per page. */
export const MEDIA_COMMENTS_PAGE_DEFAULT = 20;
export const MEDIA_COMMENTS_PAGE_MAX = 50;
/** Most results of the tag person picker. */
export const TAG_CANDIDATES_MAX = 20;

/**
 * Stable reasons on social errors (`error.details[0].code`, the open
 * detail-code channel of ADR 0001 §4; `ErrorCode` stays closed).
 */
export const SocialIssueCode = {
  /**
   * 400 `VALIDATION` (`path: "personId"`): the person cannot be tagged by the
   * caller. Deliberately generic: the same answer for a person that does not
   * exist and for a member linked to an **unlisted** or disabled account
   * tagged by someone else, so it reveals neither.
   */
  TagNotAllowed: "TAG_NOT_ALLOWED",
  /** 409 `CONFLICT`: the item already has {@link MEDIA_TAGS_MAX} tags. */
  TagLimit: "TAG_LIMIT",
  /**
   * 404 `NOT_FOUND`: the comment does not exist, is on a photo the caller
   * cannot see, or (on the member delete) is not the caller's own.
   */
  CommentNotFound: "COMMENT_NOT_FOUND"
} as const;
export type SocialIssueCode = (typeof SocialIssueCode)[keyof typeof SocialIssueCode];

/* -------------------------------------------------------------------------- */
/* Tags                                                                        */
/* -------------------------------------------------------------------------- */

/** A tag position, as a fraction of the displayed image (0 = left/top, 1 = right/bottom). */
const tagCoordinateSchema = z.number().min(0).max(1);

/** The tagged person, names only plus the photo under the unlisted/disabled rules. */
export interface MediaTagPerson {
  id: string;
  /** The person's full name. */
  name: string;
  /** Resolved photo (64 px) under the `Person.avatarUrl` rules, else `null`. */
  avatarUrl: string | null;
}

export const mediaTagPersonSchema = z.object({
  id: idSchema,
  name: z.string().max(200),
  avatarUrl: z.string().max(4096).nullable()
}) satisfies z.ZodType<MediaTagPerson>;

/** A person tagged in a media item. */
export interface MediaTag {
  id: string;
  person: MediaTagPerson;
  /** Position (both or neither); absent when the tag was not placed on the image. */
  x?: number;
  y?: number;
  /** The tagged person is the caller's own linked person ("Quitar mi etiqueta"). */
  isMe: boolean;
  /** Server-computed: the tagger, the uploader, the tagged person's linked user or an admin. */
  canRemove: boolean;
}

export const mediaTagSchema = z.object({
  id: idSchema,
  person: mediaTagPersonSchema,
  x: tagCoordinateSchema.exactOptional(),
  y: tagCoordinateSchema.exactOptional(),
  isMe: z.boolean(),
  canRemove: z.boolean()
}) satisfies z.ZodType<MediaTag>;

/**
 * `POST /api/media/:id/tags`. Tagging a person already tagged in the item
 * answers the existing tag (idempotent, nothing re-notified).
 */
export const createMediaTagInputSchema = z
  .strictObject({
    personId: idSchema,
    x: tagCoordinateSchema.exactOptional(),
    y: tagCoordinateSchema.exactOptional()
  })
  .refine((value) => (value.x === undefined) === (value.y === undefined), {
    error: "Indica ambas coordenadas o ninguna.",
    path: ["y"]
  });
export type CreateMediaTagInput = z.infer<typeof createMediaTagInputSchema>;
export type CreateMediaTagRequest = z.input<typeof createMediaTagInputSchema>;

/** `DELETE /api/media/:id/tags/:tagId` params. */
export const mediaTagParamsSchema = z.object({ id: idSchema, tagId: idSchema });
export type MediaTagParams = z.infer<typeof mediaTagParamsSchema>;

/**
 * A person the caller may tag (`GET /api/media/:id/tag-candidates`). Members
 * linked to an unlisted or disabled account are never candidates for others.
 */
export interface TagCandidate {
  id: string;
  name: string;
  nickname: string | null;
  avatarUrl: string | null;
  /** The caller's own linked person. */
  isMe: boolean;
}

export const tagCandidateSchema = z.object({
  id: idSchema,
  name: z.string().max(200),
  nickname: z.string().max(80).nullable(),
  avatarUrl: z.string().max(4096).nullable(),
  isMe: z.boolean()
}) satisfies z.ZodType<TagCandidate>;

/** `GET /api/media/:id/tag-candidates` query: a name search. */
export const tagCandidatesQuerySchema = z.object({
  q: z.string().trim().min(1).max(100),
  limit: z.coerce.number<number | string>().int().min(1).max(TAG_CANDIDATES_MAX).default(10)
});
export type TagCandidatesQuery = z.infer<typeof tagCandidatesQuerySchema>;
export type TagCandidatesQueryRequest = z.input<typeof tagCandidatesQuerySchema>;

export const tagCandidateListSchema = z.object({
  items: z.array(tagCandidateSchema).max(TAG_CANDIDATES_MAX)
});
export type TagCandidateList = z.infer<typeof tagCandidateListSchema>;

/* -------------------------------------------------------------------------- */
/* Likes                                                                       */
/* -------------------------------------------------------------------------- */

/** Hearts on an item; `PUT|DELETE /api/media/:id/like` answer it (both idempotent, no body). */
export interface MediaLikeState {
  likeCount: number;
  likedByMe: boolean;
}

export const mediaLikeStateSchema = z.object({
  likeCount: z.number().int().min(0),
  likedByMe: z.boolean()
}) satisfies z.ZodType<MediaLikeState>;

/* -------------------------------------------------------------------------- */
/* Comments                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Comment body: NFC, bidi controls and invisible marks stripped (ZWJ kept for
 * emoji), trimmed, 1–1000 characters with at least one visible character.
 * Line breaks are allowed. Same rule as chat bodies.
 */
export const mediaCommentBodySchema = z
  .string()
  .max(MEDIA_COMMENT_MAX_LENGTH * 2, { error: `Máximo ${MEDIA_COMMENT_MAX_LENGTH} caracteres.` })
  .transform((value) => stripUnsafeChars(value.normalize("NFC")).replace(/\r\n?/g, "\n").trim())
  .pipe(
    z
      .string()
      .min(1, { error: "El comentario está vacío." })
      .max(MEDIA_COMMENT_MAX_LENGTH, { error: `Máximo ${MEDIA_COMMENT_MAX_LENGTH} caracteres.` })
      .refine(hasVisibleChars, { error: "El comentario está vacío." })
  );

/** Who wrote a comment: no account id; the avatar under the unlisted/disabled rules. */
export interface MediaCommentAuthor {
  name: string;
  avatarUrl: string | null;
  isMe: boolean;
}

export const mediaCommentAuthorSchema = z.object({
  name: z.string().max(80),
  avatarUrl: z.string().max(4096).nullable(),
  isMe: z.boolean()
}) satisfies z.ZodType<MediaCommentAuthor>;

/**
 * A comment. A deleted one keeps its slot as a tombstone ("Comentario
 * eliminado"): `deleted: true`, `body: ""` and `author: null`; the server
 * scrubs the stored body on delete, so it can never be returned.
 */
export interface MediaComment {
  id: string;
  mediaId: string;
  /** `null` for tombstones and once the author's account is removed. */
  author: MediaCommentAuthor | null;
  body: string;
  deleted: boolean;
  createdAt: string;
  /** Author only (`DELETE /api/media/comments/:id`). */
  canDelete: boolean;
  /** Admins (`DELETE /api/admin/media/comments/:id`, audited). */
  canModerate: boolean;
}

export const mediaCommentSchema = z
  .object({
    id: idSchema,
    mediaId: idSchema,
    author: mediaCommentAuthorSchema.nullable(),
    body: z.string().max(MEDIA_COMMENT_MAX_LENGTH),
    deleted: z.boolean(),
    createdAt: dateTimeSchema,
    canDelete: z.boolean(),
    canModerate: z.boolean()
  })
  .refine((value) => !value.deleted || (value.body === "" && value.author === null), {
    error: "Un comentario eliminado no lleva texto ni autor.",
    path: ["body"]
  }) satisfies z.ZodType<MediaComment>;

/**
 * `POST /api/media/:id/comments`. `clientCommentId` makes retries idempotent:
 * the same author sending the same id gets the stored comment back (200, not
 * a duplicate).
 */
export const createMediaCommentInputSchema = z.strictObject({
  body: mediaCommentBodySchema,
  clientCommentId: idSchema.exactOptional()
});
export type CreateMediaCommentInput = z.infer<typeof createMediaCommentInputSchema>;
export type CreateMediaCommentRequest = z.input<typeof createMediaCommentInputSchema>;

/** `GET /api/media/:id/comments` query: oldest first (keyset on `created_at, id`). */
export const mediaCommentsQuerySchema = z.object({
  cursor: cursorSchema.exactOptional(),
  limit: z.coerce
    .number<number | string>()
    .int()
    .min(1)
    .max(MEDIA_COMMENTS_PAGE_MAX)
    .default(MEDIA_COMMENTS_PAGE_DEFAULT)
});
export type MediaCommentsQuery = z.infer<typeof mediaCommentsQuerySchema>;
export type MediaCommentsQueryRequest = z.input<typeof mediaCommentsQuerySchema>;

export const mediaCommentPageSchema = pageSchema(mediaCommentSchema);

/** `:id` of `/api/media/comments/:id…` and `/api/admin/media/comments/:id`. */
export const mediaCommentParamsSchema = z.object({ id: idSchema });
export type MediaCommentParams = z.infer<typeof mediaCommentParamsSchema>;

/** `POST /api/media/comments/:id/report` body: the media report shape (one report per user per comment). */
export const reportMediaCommentInputSchema = reportMediaInputSchema;
export type ReportMediaCommentInput = z.infer<typeof reportMediaCommentInputSchema>;
export type ReportMediaCommentRequest = z.input<typeof reportMediaCommentInputSchema>;

/* -------------------------------------------------------------------------- */
/* Per-item detail                                                             */
/* -------------------------------------------------------------------------- */

/**
 * `GET /api/media/:id/detail`: everything the lightbox shows for one item
 * (also the lazy load behind the `?foto=<id>` deep link).
 */
export interface MediaDetail {
  item: MediaItem;
  /** Ordered by creation. */
  tags: MediaTag[];
  likes: MediaLikeState;
  /** Live comments only. */
  commentCount: number;
  /** The first (oldest) page of comments. */
  comments: Page<MediaComment>;
  /** The caller may add tags (any viewer, while under {@link MEDIA_TAGS_MAX}). */
  canTag: boolean;
}

export const mediaDetailSchema = z.object({
  item: mediaItemSchema,
  tags: z.array(mediaTagSchema).max(MEDIA_TAGS_MAX),
  likes: mediaLikeStateSchema,
  commentCount: z.number().int().min(0),
  comments: mediaCommentPageSchema,
  canTag: z.boolean()
}) satisfies z.ZodType<MediaDetail>;

/* -------------------------------------------------------------------------- */
/* Admin: comment reports                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A reported comment in the admin queue (`GET /api/admin/media/comment-reports`).
 * Admins see the body of live comments; a deleted one shows `body: ""`.
 */
export interface AdminReportedComment {
  id: string;
  mediaId: string;
  body: string;
  authorName: string | null;
  authorUserId: string | null;
  createdAt: string;
  deletedAt: string | null;
  reportCount: number;
  /** Newest first, at most 20. */
  reports: MediaReport[];
}

export const adminReportedCommentSchema = z.object({
  id: idSchema,
  mediaId: idSchema,
  body: z.string().max(MEDIA_COMMENT_MAX_LENGTH),
  authorName: z.string().max(80).nullable(),
  authorUserId: idSchema.nullable(),
  createdAt: dateTimeSchema,
  deletedAt: dateTimeSchema.nullable(),
  reportCount: z.number().int().min(0),
  reports: z.array(mediaReportSchema).max(20)
}) satisfies z.ZodType<AdminReportedComment>;

/** `GET /api/admin/media/comment-reports` query (newest report first). */
export const adminCommentReportsQuerySchema = cursorQuerySchema.extend({
  /** `"true"`: also list comments already deleted. */
  includeDeleted: queryBooleanSchema.exactOptional()
});
export type AdminCommentReportsQuery = z.infer<typeof adminCommentReportsQuerySchema>;
export type AdminCommentReportsQueryRequest = z.input<typeof adminCommentReportsQuerySchema>;

export const adminReportedCommentPageSchema = pageSchema(adminReportedCommentSchema);
