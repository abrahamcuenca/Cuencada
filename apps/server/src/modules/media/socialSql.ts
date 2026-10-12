/**
 * Social SQL shared by the media lists and the social module (WP-6.2,
 * ADR 0001 §8). Lives in the media module so `service.ts` can fill the
 * `MediaItem` counts without importing the social module (no cycle).
 *
 * **Tag visibility** [SEC] (one predicate everywhere: detail, counts,
 * "Fotos de {persona}", delete rights):
 * - admins: every tag;
 * - everyone else: `approved` tags, plus a `pending` tag only for its
 *   tagger and for the tagged person's linked user.
 *
 * The tagger's own pending tag is therefore visible to them and counted for
 * them exactly like an approved one; the social mappers also hide its status
 * (security residual of WP-6.2: the tagger must not learn whether the tagged
 * person has an account). Nobody else ever sees a pending tag.
 */
import type { UserRole } from "@cuencada/types";
import { type SQL, sql } from "drizzle-orm";
import { mediaComments, mediaItems, mediaLikes, mediaTags, people } from "../../db/schema/index.js";

/** Who is asking (a subset of the media `Viewer`). */
export interface SocialViewer {
  id: string;
  role: UserRole;
}

/**
 * SQL: the `media_tags` row (joined as `media_tags`, with `people` joined on
 * `people.id = media_tags.person_id`) is visible to `viewer`.
 */
export function tagVisibleSql(viewer: SocialViewer): SQL {
  if (viewer.role === "admin") return sql`true`;
  return sql`(${mediaTags.status} = 'approved' or ${mediaTags.taggedByUserId} = ${viewer.id} or ${people.userId} = ${viewer.id})`;
}

/**
 * SQL: the same rule as {@link tagVisibleSql} for a correlated subquery over
 * `media_tags vt` joined to `people vp` (aliases fixed here, never input).
 */
function aliasedTagVisibleSql(viewer: SocialViewer): SQL {
  if (viewer.role === "admin") return sql`true`;
  return sql`(vt.status = 'approved' or vt.tagged_by_user_id = ${viewer.id} or vp.user_id = ${viewer.id})`;
}

/**
 * Per-item social columns for a select over `media_items` (scalar
 * subqueries: one statement for the whole page, no N+1). They only ever
 * describe rows that already passed the caller's scope filter.
 */
export function socialCountColumns(viewer: SocialViewer): {
  likeCount: SQL<number>;
  likedByMe: SQL<boolean>;
  commentCount: SQL<number>;
  tagCount: SQL<number>;
} {
  return {
    likeCount: sql<number>`(select count(*)::int from ${mediaLikes} where ${mediaLikes.mediaId} = ${mediaItems.id})`,
    likedByMe: sql<boolean>`exists (select 1 from ${mediaLikes} where ${mediaLikes.mediaId} = ${mediaItems.id} and ${mediaLikes.userId} = ${viewer.id})`,
    commentCount: sql<number>`(select count(*)::int from ${mediaComments} where ${mediaComments.mediaId} = ${mediaItems.id} and ${mediaComments.deletedAt} is null)`,
    tagCount: sql<number>`(select count(*)::int from ${mediaTags} vt inner join ${people} vp on vp.id = vt.person_id where vt.media_id = ${mediaItems.id} and ${aliasedTagVisibleSql(viewer)})`
  };
}

/**
 * SQL: the media row has a tag of `personId` visible to `viewer` ("Fotos de
 * {persona}", ADR 0001 §8 requirement 5a).
 */
export function taggedPersonSql(viewer: SocialViewer, personId: string): SQL {
  return sql`exists (select 1 from ${mediaTags} vt inner join ${people} vp on vp.id = vt.person_id
    where vt.media_id = ${mediaItems.id} and vt.person_id = ${personId} and ${aliasedTagVisibleSql(viewer)})`;
}
