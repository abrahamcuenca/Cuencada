/**
 * Helpers shared by the social routes (WP-6.2, ADR 0001 §8): the locked
 * scope check every write starts with, member avatars under the
 * unlisted/disabled rules, rate limits and messages.
 */
import { SocialIssueCode } from "@cuencada/types";
import { type AnyColumn, and, eq, type SQL, sql } from "drizzle-orm";
import { mediaItems } from "../../db/schema/index.js";
import type { DbOrTx } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { viewableSql, type Viewer } from "../media/service.js";
import { type AvatarUrlDeps, AvatarSize, avatarUrlFor } from "../profile/index.js";

export const MEDIA_NOT_FOUND_MESSAGE = "No encontramos esa foto o video.";
export const COMMENT_NOT_FOUND_MESSAGE = "No encontramos ese comentario.";

/** Per-user rate limits (ADR 0001 §8 requirement 8). */
export const SocialRateLimit = {
  tags: { max: 60, timeWindow: "1 hour" },
  tagConsent: { max: 120, timeWindow: "1 hour" },
  tagCandidates: { max: 120, timeWindow: "1 hour" },
  likes: { max: 300, timeWindow: "1 hour" },
  likers: { max: 300, timeWindow: "1 hour" },
  comments: { max: 30, timeWindow: "1 hour" },
  commentReports: { max: 20, timeWindow: "1 day" }
} as const;

/** 404 for a photo the caller cannot see (or that does not exist): identical either way. */
export function mediaNotFound(): AppError {
  return new AppError("NOT_FOUND", MEDIA_NOT_FOUND_MESSAGE);
}

/** 404 `COMMENT_NOT_FOUND`: missing, on an invisible photo, or (member delete) not the caller's. */
export function commentNotFound(): AppError {
  return new AppError("NOT_FOUND", COMMENT_NOT_FOUND_MESSAGE, {
    details: [{ path: "id", message: COMMENT_NOT_FOUND_MESSAGE, code: SocialIssueCode.CommentNotFound }]
  });
}

/** The locked media row a social write acts on. */
export interface LockedMedia {
  id: string;
  uploadedByUserId: string | null;
}

/**
 * [SEC] Load and lock the photo under the viewer's scope **in one
 * statement** (`viewableSql`, ADR 0001 §8 requirement 1). `update` for tag
 * writes (the cap is counted under it), `share` for likes and comments.
 *
 * @throws AppError 404 when the viewer cannot see the photo.
 */
export async function lockViewableMedia(
  tx: DbOrTx,
  mediaId: string,
  viewer: Viewer,
  mode: "update" | "share"
): Promise<LockedMedia> {
  const query = tx
    .select({ id: mediaItems.id, uploadedByUserId: mediaItems.uploadedByUserId })
    .from(mediaItems)
    .where(and(eq(mediaItems.id, mediaId), viewableSql(viewer)))
    .limit(1);
  const [row] = await (mode === "update" ? query.for("update") : query.for("share"));
  if (row === undefined) throw mediaNotFound();
  return row;
}

/** What a member avatar decision needs: the account's directory listing and status. */
export interface MemberAvatarRow {
  userId: string | null;
  avatarKey: string | null;
  listedInDirectory: boolean | null;
  userStatus: string | null;
}

/**
 * [SEC] The avatar key `viewer` may see for a member (comment authors,
 * likers): their own always; others only while listed in the directory and
 * active (a missing profile counts as unlisted: fail closed). Never an id.
 */
export function visibleAvatarKey(row: MemberAvatarRow, viewer: Viewer): string | null {
  if (row.userId === null || row.avatarKey === null) return null;
  if (row.userId === viewer.id) return row.avatarKey;
  return row.listedInDirectory === true && row.userStatus === "active" ? row.avatarKey : null;
}

/**
 * Presign each distinct visible avatar key once (64 px).
 *
 * @returns `avatar_key → URL | null`.
 */
export async function presignMemberAvatars(
  deps: AvatarUrlDeps,
  keys: Iterable<string | null>
): Promise<Map<string, string | null>> {
  const distinct = [...new Set([...keys].filter((key): key is string => key !== null))];
  const urls = await Promise.all(distinct.map((key) => avatarUrlFor(deps, key, AvatarSize.Small)));
  return new Map(distinct.map((key, index) => [key, urls[index] ?? null]));
}

/** SQL: epoch microseconds of a timestamp column, for keyset cursors. */
export function micros(column: AnyColumn): SQL<string> {
  return sql<string>`(extract(epoch from ${column}) * 1000000)::bigint::text`;
}
