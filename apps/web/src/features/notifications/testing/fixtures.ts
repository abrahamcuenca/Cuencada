/**
 * Notification fixtures (WP-6.1): fictional people and a fake server over
 * MSW (feed keyset pages, mark read, unread count). The repository is public.
 */
import type { Notification as AppNotification, WsServerNotification } from "@cuencada/types";
import { type HttpHandler, HttpResponse, http } from "msw";
import { apiUrl } from "../../../../test/auth";

/** A stable fake uuid. */
export function notificationId(n: number): string {
  return `7a1d2c3b-4a5e-4f60-8a7b-${String(n).padStart(12, "0")}`;
}

const MEDIA = "8b2e3d4c-5b6f-4a71-9b8c-0d1e2f3a4b5c";
const EVENT = "9c3f4e5d-6c7a-4b82-8c9d-1e2f3a4b5c6d";
const PROPOSAL = "0d4a5f6e-7d8b-4c93-9daf-2f3a4b5c6d7e";

/** Ids the fixtures point at. */
export const TARGETS = { media: MEDIA, event: EVENT, proposal: PROPOSAL } as const;

/** The "now" the fixtures are relative to (the page groups by the real clock). */
export const NOW = new Date();

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 3_600_000).toISOString();
}

const ana = { name: "Ana Morales Vega", avatarUrl: null };

/** One of each kind, newest first (two today, one yesterday, one this week, one older). */
export function makeFeed(): AppNotification[] {
  return [
    {
      id: notificationId(1),
      kind: "photo_tag_request",
      actor: ana,
      target: { kind: "media", mediaId: MEDIA, thumbUrl: "https://fotos.example.test/thumb.webp", place: { kind: "edition", year: 2026 } },
      count: 1,
      seenAt: null,
      createdAt: hoursAgo(1)
    },
    {
      id: notificationId(2),
      kind: "photo_commented",
      actor: ana,
      target: {
        kind: "media",
        mediaId: MEDIA,
        thumbUrl: null,
        place: { kind: "album", event: { id: EVENT, year: 2026, slug: "paseo-a-la-laguna-k7q2", title: "Paseo a la laguna" } }
      },
      count: 3,
      seenAt: null,
      createdAt: hoursAgo(2)
    },
    {
      id: notificationId(3),
      kind: "photo_liked",
      actor: ana,
      target: { kind: "media", mediaId: MEDIA, thumbUrl: null, place: { kind: "memory", memoryAlbumId: PROPOSAL } },
      count: 3,
      seenAt: "2026-10-10T20:00:00.000Z",
      createdAt: hoursAgo(26)
    },
    {
      id: notificationId(4),
      kind: "event_added",
      actor: { name: "Rosa Quintero Lara", avatarUrl: null },
      target: { kind: "event", event: { id: EVENT, year: 2026, slug: "paseo-a-la-laguna-k7q2", title: "Paseo a la laguna" }, canLeave: true },
      count: 1,
      seenAt: null,
      createdAt: hoursAgo(72)
    },
    {
      id: notificationId(5),
      kind: "tree_proposal_resolved",
      actor: null,
      target: { kind: "proposal", proposalId: PROPOSAL, status: "approved" },
      count: 1,
      seenAt: "2026-09-01T10:00:00.000Z",
      createdAt: hoursAgo(24 * 40)
    }
  ];
}

/** The fake server state. */
export interface NotificationsDb {
  items: AppNotification[];
  log: string[];
  bodies: unknown[];
  /** Page size of the fake feed. */
  pageSize: number;
  /** Status of the feed (200 by default). */
  feedStatus: 200 | 500;
}

/** A fresh fake server with {@link makeFeed}. */
export function makeNotificationsDb(overrides: Partial<NotificationsDb> = {}): NotificationsDb {
  return { items: makeFeed(), log: [], bodies: [], pageSize: 30, feedStatus: 200, ...overrides };
}

function unreadOf(db: NotificationsDb): number {
  return db.items.filter((item) => item.seenAt === null).length;
}

/** MSW handlers over a {@link NotificationsDb}. */
export function notificationsHandlers(db: NotificationsDb): HttpHandler[] {
  return [
    http.get(apiUrl("/notifications/unread-count"), () => HttpResponse.json({ count: unreadOf(db) })),
    http.get(apiUrl("/notifications"), ({ request }) => {
      const url = new URL(request.url);
      db.log.push(`GET /notifications${url.search}`);
      if (db.feedStatus === 500) return HttpResponse.json({ error: { code: "INTERNAL", message: "Error de prueba." } }, { status: 500 });
      const start = Number(url.searchParams.get("cursor") ?? "0");
      const items = db.items.slice(start, start + db.pageSize);
      const next = start + db.pageSize < db.items.length ? String(start + db.pageSize) : null;
      return HttpResponse.json({ items, nextCursor: next });
    }),
    http.post(apiUrl("/notifications/read"), async ({ request }) => {
      const body: unknown = await request.json();
      db.log.push("POST /notifications/read");
      db.bodies.push(body);
      const ids = typeof body === "object" && body !== null && "ids" in body && Array.isArray(body.ids) ? new Set(body.ids) : null;
      db.items = db.items.map((item) => (ids === null || ids.has(item.id) ? { ...item, seenAt: item.seenAt ?? NOW.toISOString() } : item));
      return HttpResponse.json({ count: unreadOf(db) });
    })
  ];
}

/** A `notification` frame for `notification` with `unreadCount`. */
export function notificationFrame(notification: AppNotification, unreadCount: number): WsServerNotification {
  return { type: "notification", notification, unreadCount };
}
