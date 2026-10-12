import { describe, expect, it } from "vitest";
import { wsServerMessageSchema } from "./chat.js";
import * as barrel from "./index.js";
import {
  NOTIFICATION_READ_IDS_MAX,
  NOTIFICATION_UNREAD_COUNT_MAX,
  NotificationKind,
  markNotificationsReadInputSchema,
  notificationDedupeKey,
  notificationListQuerySchema,
  notificationSchema,
  notificationTargetKindOf,
  unreadCountSchema
} from "./notifications.js";

const ID = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";

const liked = {
  id: ID,
  kind: "photo_liked",
  actor: { name: "Ana Morales Vega", avatarUrl: null },
  target: { kind: "media", mediaId: OTHER, thumbUrl: null, place: { kind: "edition", year: 2026 } },
  count: 3,
  seenAt: null,
  createdAt: "2026-10-11T10:00:00.000Z"
};

describe("notificationSchema", () => {
  it("parses each kind with its own target and strips unknown keys (no actor account id)", () => {
    expect(notificationSchema.parse(liked)).toEqual(liked);
    const added = {
      ...liked,
      kind: "event_added",
      count: 1,
      target: { kind: "event", event: { id: OTHER, year: 2026, slug: "viaje-k7q2", title: "Viaje" }, canLeave: true }
    };
    expect(notificationSchema.parse(added)).toEqual(added);
    const resolved = { ...liked, kind: "tree_proposal_resolved", count: 1, target: { kind: "proposal", proposalId: OTHER, status: "approved" } };
    expect(notificationSchema.parse(resolved)).toEqual(resolved);
    const withUserId = { ...liked, actor: { ...liked.actor, userId: ID } };
    expect(notificationSchema.parse(withUserId).actor).not.toHaveProperty("userId");
  });

  it("rejects a target that does not match the kind, a zero count or an unknown kind", () => {
    expect(notificationSchema.safeParse({ ...liked, kind: "event_added" }).success).toBe(false);
    expect(notificationSchema.safeParse({ ...liked, count: 0 }).success).toBe(false);
    expect(notificationSchema.safeParse({ ...liked, kind: "photo_shared" }).success).toBe(false);
    expect(
      notificationSchema.safeParse({ ...liked, kind: "tree_proposal_resolved", target: { kind: "proposal", proposalId: OTHER, status: "pending" } })
        .success
    ).toBe(false);
  });

  it("carries where a photo lives (edition, event album or Memory Box) and requires it (WP-6.1)", () => {
    const event = { id: OTHER, year: 2026, slug: "viaje-k7q2", title: "Viaje" };
    for (const place of [{ kind: "album", event }, { kind: "memory", memoryAlbumId: OTHER }]) {
      const item = { ...liked, target: { ...liked.target, place } };
      expect(notificationSchema.parse(item)).toEqual(item);
    }
    expect(notificationSchema.safeParse({ ...liked, target: { kind: "media", mediaId: OTHER, thumbUrl: null } }).success).toBe(false);
    expect(notificationSchema.safeParse({ ...liked, target: { ...liked.target, place: { kind: "edition" } } }).success).toBe(false);
  });

  it("maps every kind to one target kind", () => {
    expect(Object.values(NotificationKind).map(notificationTargetKindOf)).toEqual(["media", "media", "media", "event", "proposal"]);
  });
});

describe("inputs and counts", () => {
  it("marks some ids or all as read, never both or neither", () => {
    expect(markNotificationsReadInputSchema.parse({ all: true })).toEqual({ all: true });
    expect(markNotificationsReadInputSchema.parse({ ids: [ID] })).toEqual({ ids: [ID] });
    expect(markNotificationsReadInputSchema.safeParse({ ids: [ID], all: true }).success).toBe(false);
    expect(markNotificationsReadInputSchema.safeParse({}).success).toBe(false);
    expect(markNotificationsReadInputSchema.safeParse({ all: false }).success).toBe(false);
    expect(markNotificationsReadInputSchema.safeParse({ ids: [] }).success).toBe(false);
    expect(markNotificationsReadInputSchema.safeParse({ ids: [ID, ID] }).success).toBe(false);
    const many = Array.from({ length: NOTIFICATION_READ_IDS_MAX + 1 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    expect(markNotificationsReadInputSchema.safeParse({ ids: many }).success).toBe(false);
  });

  it("caps the unread count and parses the list query", () => {
    expect(unreadCountSchema.safeParse({ count: NOTIFICATION_UNREAD_COUNT_MAX + 1 }).success).toBe(false);
    expect(notificationListQuerySchema.parse({ unread: "true" })).toEqual({ unread: true, limit: 20 });
  });

  it("builds per-target dedupe keys", () => {
    expect(notificationDedupeKey.like(ID)).toBe(`like:${ID}`);
    expect(notificationDedupeKey.event(ID)).toBe(`event:${ID}`);
  });
});

describe("WebSocket notification frame", () => {
  it("is part of the server frame union", () => {
    const frame = { type: "notification", notification: liked, unreadCount: 2 };
    expect(wsServerMessageSchema.parse(frame)).toEqual(frame);
    expect(wsServerMessageSchema.safeParse({ ...frame, notification: { ...liked, count: 0 } }).success).toBe(false);
  });

  it("is exported from the barrel", () => {
    expect(barrel.notificationSchema).toBe(notificationSchema);
    expect(barrel.NotificationKind).toBe(NotificationKind);
  });
});
