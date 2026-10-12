/**
 * Photo social features (WP-6.0 contracts; WP-6.2 implements): people tags,
 * hearts ("Me gusta") and comments on a media item, plus the per-item detail
 * read the lightbox uses. Authorization: ADR 0001 §8 (binding).
 *
 * Every route here first loads the media item through the media scope
 * (`mediaScopeSql` + member visibility): a photo the caller cannot see is
 * 404 `NOT_FOUND` on every route, before any other check. Tags, likes and
 * comments therefore always inherit the photo's scope (Memory Box photos
 * become social exactly when WP-6.3 opens the published-box branch).
 *
 * Tag consent (owner decision, Security L1 of PR #56): a tag of a person
 * linked to an account is **pending** until that person approves it; only
 * the tagger, the tagged user and admins see a pending tag. Tags of people
 * without accounts (and self-tags) are approved at once. Counts and "Fotos de
 * {persona}" use approved tags only.
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
/** Default and maximum likers per page (`GET /api/media/:id/likes`). */
export const MEDIA_LIKERS_PAGE_DEFAULT = 20;
export const MEDIA_LIKERS_PAGE_MAX = 50;

/**
 * Stable reasons on social errors (`error.details[0].code`, the open
 * detail-code channel of ADR 0001 §4; `ErrorCode` stays closed).
 */
export const SocialIssueCode = {
  /**
   * 400 `VALIDATION` (`path: "personId"`): the person does not exist (or was
   * deleted). Every existing person is taggable, unlisted members included
   * (their tag stays pending until they approve it), so this code reveals
   * nothing about accounts.
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

/**
 * `pending`: the tagged person is linked to an account and has not approved
 * yet (visible only to the tagger, that user and admins). `approved`: shown
 * to every viewer of the photo (DB CHECK `media_tags_status_check`).
 */
export const MediaTagStatus = {
  Pending: "pending",
  Approved: "approved"
} as const;
export type MediaTagStatus = (typeof MediaTagStatus)[keyof typeof MediaTagStatus];
export const mediaTagStatusSchema = z.enum(MediaTagStatus);

/** A tag position, as a fraction of the displayed image (0 = left/top, 1 = right/bottom). */
const tagCoordinateSchema = z.number().min(0).max(1);

/** The tagged person: the name, plus the photo under the unlisted/disabled rules. */
export interface MediaTagPerson {
  id: string;
  /** The person's full name. */
  name: string;
  /**
   * Resolved photo (64 px) under the `Person.avatarUrl` rules; always `null`
   * for a member hidden from the directory (unlisted) or disabled, whose tag
   * shows the name only.
   */
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
  status: MediaTagStatus;
  /** The tagged person is the caller's own linked person ("Quitar mi etiqueta"). */
  isMe: boolean;
  /** Server-computed: the tagger, the uploader, the tagged person's linked user or an admin. */
  canRemove: boolean;
  /** Server-computed: a pending tag of the caller's own linked person ("Aprobar"). */
  canApprove: boolean;
}

export const mediaTagSchema = z.object({
  id: idSchema,
  person: mediaTagPersonSchema,
  x: tagCoordinateSchema.exactOptional(),
  y: tagCoordinateSchema.exactOptional(),
  status: mediaTagStatusSchema,
  isMe: z.boolean(),
  canRemove: z.boolean(),
  canApprove: z.boolean()
}) satisfies z.ZodType<MediaTag>;

/**
 * `POST /api/media/:id/tags`. The new tag is `approved` for a person without
 * an account and for a self-tag, else `pending` (the tagged user gets a
 * `photo_tag_request` notification). Tagging a person already tagged in the
 * item answers the existing tag (idempotent, nothing re-notified); after a
 * decline (which deletes the tag) the person can be tagged again.
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

/**
 * `DELETE /api/media/:id/tags/:tagId` params: remove a tag, or **decline** a
 * pending one (the tagged user), which deletes it.
 */
export const mediaTagParamsSchema = z.object({ id: idSchema, tagId: idSchema });
export type MediaTagParams = z.infer<typeof mediaTagParamsSchema>;

/**
 * `POST /api/media/tags/:id/approve` params (no body): the tagged person's
 * linked user approves a pending tag; answers the approved `MediaTag`
 * (idempotent on an approved one). Anyone else: 404.
 */
export const mediaTagIdParamsSchema = z.object({ id: idSchema });
export type MediaTagIdParams = z.infer<typeof mediaTagIdParamsSchema>;

/**
 * A person the caller may tag (`GET /api/media/:id/tag-candidates`): any
 * person in the tree. `avatarUrl` is `null` for unlisted or disabled members
 * (name only).
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

/**
 * Hearts on an item; `PUT|DELETE /api/media/:id/like` answer it (both
 * idempotent, no body). Who liked: `GET /api/media/:id/likes`.
 */
export interface MediaLikeState {
  likeCount: number;
  likedByMe: boolean;
}

export const mediaLikeStateSchema = z.object({
  likeCount: z.number().int().min(0),
  likedByMe: z.boolean()
}) satisfies z.ZodType<MediaLikeState>;

/**
 * Who gave a heart (`GET /api/media/:id/likes`, newest first, Instagram
 * style). Name only, no account id; the avatar only for members listed in
 * the directory and active.
 */
export interface MediaLiker {
  name: string;
  avatarUrl: string | null;
  isMe: boolean;
}

export const mediaLikerSchema = z.object({
  name: z.string().max(80),
  avatarUrl: z.string().max(4096).nullable(),
  isMe: z.boolean()
}) satisfies z.ZodType<MediaLiker>;

/** `GET /api/media/:id/likes` query (keyset on `created_at desc, user_id`). */
export const mediaLikersQuerySchema = z.object({
  cursor: cursorSchema.exactOptional(),
  limit: z.coerce
    .number<number | string>()
    .int()
    .min(1)
    .max(MEDIA_LIKERS_PAGE_MAX)
    .default(MEDIA_LIKERS_PAGE_DEFAULT)
});
export type MediaLikersQuery = z.infer<typeof mediaLikersQuerySchema>;
export type MediaLikersQueryRequest = z.input<typeof mediaLikersQuerySchema>;

export const mediaLikerPageSchema = pageSchema(mediaLikerSchema);

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
  /** Ordered by creation; pending tags only for the tagger, the tagged user and admins. */
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
