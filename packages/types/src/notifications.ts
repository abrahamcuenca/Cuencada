/**
 * In-app notifications (WP-6.0 contracts; WP-6.1 implements): the bell, its
 * unread badge and the `/notificaciones` feed. They replace the WP-5.3
 * one-off event notice. No emails. Authorization: ADR 0001 §8 (binding).
 *
 * Rows live in `notifications` (migration 0010). A notification is only ever
 * shown, counted or pushed while its target is still visible to the
 * recipient (filtered at read time), and never about the recipient's own
 * action (no self-notifications; DB CHECK).
 *
 * Re-exported by `chat.ts` (the barrel is frozen), which also carries the
 * WebSocket `notification` frame.
 */
import { z } from "zod";
import { cursorQuerySchema, dateTimeSchema, idSchema, pageSchema, queryBooleanSchema } from "./common.js";
import { type EventRef, eventRefSchema } from "./eventRefs.js";

/** What happened (DB CHECK `notifications_kind_check`). */
export const NotificationKind = {
  /**
   * Someone tagged the recipient's linked person in a photo; the tag is
   * pending until the recipient approves it ("Aprobar" / "Rechazar"). One
   * kind for the request (not `photo_tagged` + a flag): approving marks it
   * seen, declining or removing the tag deletes it.
   */
  PhotoTagRequest: "photo_tag_request",
  /** Someone commented on a photo the recipient uploaded (coalesced per photo). */
  PhotoCommented: "photo_commented",
  /** Someone gave a heart to a photo the recipient uploaded (coalesced per photo). */
  PhotoLiked: "photo_liked",
  /** Someone else added the recipient to an event (the WP-5.3 consent notice). */
  EventAdded: "event_added",
  /** An admin approved or rejected the recipient's tree-link proposal. */
  TreeProposalResolved: "tree_proposal_resolved"
} as const;
export type NotificationKind = (typeof NotificationKind)[keyof typeof NotificationKind];
export const notificationKindSchema = z.enum(NotificationKind);

/** Kinds whose target is a media item. */
export const MEDIA_NOTIFICATION_KINDS = [
  NotificationKind.PhotoTagRequest,
  NotificationKind.PhotoCommented,
  NotificationKind.PhotoLiked
] as const satisfies readonly NotificationKind[];

/** Rows older than this are deleted by the cleanup job (WP-6.1). */
export const NOTIFICATION_RETENTION_DAYS = 180;
/**
 * Unread counts stop here (the badge shows "999+"). WP-6.1 raised it from
 * 99 (owner brief: a "999+" cap); the count query stops at this many rows.
 */
export const NOTIFICATION_UNREAD_COUNT_MAX = 999;
/**
 * Most rows kept per recipient: writing beyond it deletes that recipient's
 * oldest rows in the same transaction (seen ones first).
 */
export const NOTIFICATIONS_PER_USER_MAX = 500;
/** Most ids in one `POST /api/notifications/read`. */
export const NOTIFICATION_READ_IDS_MAX = 100;
/** Longest `notifications.dedupe_key` (DB CHECK). */
export const NOTIFICATION_DEDUPE_KEY_MAX_LENGTH = 200;

/**
 * Dedupe keys: one row per recipient and key (partial unique index). A new
 * event with the same key updates the row instead of adding one: likes and
 * comments coalesce per photo ("Ana y 2 más"), a re-tag or re-add refreshes
 * the existing row. Only server code builds them; never from input.
 */
export const notificationDedupeKey = {
  tag: (mediaId: string): string => `tag:${mediaId}`,
  comment: (mediaId: string): string => `comment:${mediaId}`,
  like: (mediaId: string): string => `like:${mediaId}`,
  event: (eventId: string): string => `event:${eventId}`,
  proposal: (proposalId: string): string => `proposal:${proposalId}`
} as const;

/**
 * Who caused it: no account id. Resolved at **read time** from the current
 * account, so the avatar follows the unlisted/disabled rules as they are now
 * (an actor who became unlisted after liking shows the name only).
 */
export interface NotificationActor {
  /** Display name; `null` once the account is removed. */
  name: string | null;
  avatarUrl: string | null;
}

export const notificationActorSchema = z.object({
  name: z.string().max(80).nullable(),
  avatarUrl: z.string().max(4096).nullable()
}) satisfies z.ZodType<NotificationActor>;

/** What the notification links to. */
export const NotificationTargetKind = {
  /** Opens the lightbox (`?foto=<mediaId>`). */
  Media: "media",
  /** Opens `/eventos/{year}/{slug}`. */
  Event: "event",
  /** Opens the caller's proposal. */
  Proposal: "proposal"
} as const;
export type NotificationTargetKind = (typeof NotificationTargetKind)[keyof typeof NotificationTargetKind];

/**
 * Where a photo lives, so the client can open it on its own page (WP-6.1):
 * the edition gallery, the event's photos tab or the Memory Box. Only sent
 * with a photo the recipient can see, so its event (or box) is visible too.
 */
export type NotificationMediaPlace =
  | { kind: "edition"; year: number }
  | { kind: "album"; event: EventRef }
  | { kind: "memory"; memoryAlbumId: string };

export const notificationMediaPlaceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("edition"), year: z.number().int() }),
  z.object({ kind: z.literal("album"), event: eventRefSchema }),
  z.object({ kind: z.literal("memory"), memoryAlbumId: idSchema })
]) satisfies z.ZodType<NotificationMediaPlace>;

/** A photo the recipient can see (re-checked at read time). */
export interface NotificationMediaTarget {
  kind: "media";
  mediaId: string;
  /** Presigned 400 px thumbnail, `null` until processed (or for some videos). */
  thumbUrl: string | null;
  /** Where to open it (WP-6.1). */
  place: NotificationMediaPlace;
}

/** An event the recipient can see (re-checked at read time). */
export interface NotificationEventTarget {
  kind: "event";
  event: EventRef;
  /**
   * WP-6.1: the recipient takes part and may leave ("Salir"); false once
   * they left, or while they are its last organizer.
   */
  canLeave: boolean;
}

/** The recipient's own tree-link proposal. */
export interface NotificationProposalTarget {
  kind: "proposal";
  proposalId: string;
  status: "approved" | "rejected";
}

export type NotificationTarget = NotificationMediaTarget | NotificationEventTarget | NotificationProposalTarget;

export const notificationTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal(NotificationTargetKind.Media),
    mediaId: idSchema,
    thumbUrl: z.string().max(4096).nullable(),
    place: notificationMediaPlaceSchema
  }),
  z.object({ kind: z.literal(NotificationTargetKind.Event), event: eventRefSchema, canLeave: z.boolean() }),
  z.object({
    kind: z.literal(NotificationTargetKind.Proposal),
    proposalId: idSchema,
    status: z.enum(["approved", "rejected"])
  })
]) satisfies z.ZodType<NotificationTarget>;

/** The target kind each notification kind must carry. */
export function notificationTargetKindOf(kind: NotificationKind): NotificationTargetKind {
  if (kind === NotificationKind.EventAdded) return NotificationTargetKind.Event;
  if (kind === NotificationKind.TreeProposalResolved) return NotificationTargetKind.Proposal;
  return NotificationTargetKind.Media;
}

/** One feed entry. */
export interface Notification {
  id: string;
  kind: NotificationKind;
  /** The latest actor (for coalesced likes/comments); `null` when unknown. */
  actor: NotificationActor | null;
  target: NotificationTarget;
  /** Events coalesced into this row (≥ 1): "Ana y {count − 1} más" (Ana = `actor`, the latest). */
  count: number;
  /** `null` while unread. */
  seenAt: string | null;
  /** When it last fired (coalescing moves it), the feed order. */
  createdAt: string;
}

export const notificationSchema = z
  .object({
    id: idSchema,
    kind: notificationKindSchema,
    actor: notificationActorSchema.nullable(),
    target: notificationTargetSchema,
    count: z.number().int().min(1),
    seenAt: dateTimeSchema.nullable(),
    createdAt: dateTimeSchema
  })
  .refine((value) => value.target.kind === notificationTargetKindOf(value.kind), {
    error: "El destino no corresponde al tipo de aviso.",
    path: ["target"]
  }) satisfies z.ZodType<Notification>;

/** `GET /api/notifications` query (newest first, keyset on `created_at, id`). */
export const notificationListQuerySchema = cursorQuerySchema.extend({
  /** `"true"`: unread only. */
  unread: queryBooleanSchema.exactOptional()
});
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;
export type NotificationListQueryRequest = z.input<typeof notificationListQuerySchema>;

export const notificationPageSchema = pageSchema(notificationSchema);

/**
 * `POST /api/notifications/read`: mark some (`ids`, the caller's own; others'
 * ids are ignored, never an error) or `all` as read. Answers
 * {@link UnreadCount}.
 */
export const markNotificationsReadInputSchema = z.union([
  z.strictObject({
    ids: z
      .array(idSchema)
      .min(1)
      .max(NOTIFICATION_READ_IDS_MAX)
      .refine((ids) => new Set(ids).size === ids.length, { error: "Hay avisos repetidos." })
  }),
  z.strictObject({ all: z.literal(true) })
]);
export type MarkNotificationsReadInput = z.infer<typeof markNotificationsReadInputSchema>;
export type MarkNotificationsReadRequest = z.input<typeof markNotificationsReadInputSchema>;

/** `GET /api/notifications/unread-count` (and the read route's answer). Visible targets only. */
export interface UnreadCount {
  /** Capped at {@link NOTIFICATION_UNREAD_COUNT_MAX}. */
  count: number;
}

export const unreadCountSchema = z.object({
  count: z.number().int().min(0).max(NOTIFICATION_UNREAD_COUNT_MAX)
}) satisfies z.ZodType<UnreadCount>;

/**
 * WebSocket server frame (on the existing chat socket, to the recipient's
 * sockets only): a notification was created or re-fired. Built by the same
 * read model as the feed, after the visibility check, so it never carries a
 * target the recipient cannot see. Older clients drop the unknown frame.
 */
export const wsServerNotificationSchema = z.object({
  type: z.literal("notification"),
  notification: notificationSchema,
  unreadCount: z.number().int().min(0).max(NOTIFICATION_UNREAD_COUNT_MAX)
});
export type WsServerNotification = z.infer<typeof wsServerNotificationSchema>;
