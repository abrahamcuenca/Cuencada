# WP-6.1 Notifications (BE + FE) [SEC]
Owner: Senior full-stack JS + UI/UX · Reviewers: TL, Security · Branch: `wp/6.1-notifications` · PR: (not opened)

Based on `origin/main` @ 83dbb88 (WP-6.0 contracts, migration 0010). Implements the WP-6.1 interfaces of `docs/coordination/WP-6.0.md` under ADR 0001 §8 (binding). No migration.

## Server (`apps/server/src/modules/notifications/`)
- **`notify.ts`** (the WP-6.0 stub, signatures unchanged):
  - `recordNotification(tx, …)` inside the caller's transaction: no-op (`null`) when actor = recipient; upsert on `(user_id, dedupe_key)` (`notificationDedupeKey`); a repeat moves `created_at` (feed order), sets the latest actor and clears `seen_at`. Counts follow WP-6.0 decision 3: likes are recomputed from `media_likes` (others than the recipient, ≥ 1), so like/unlike/like never inflates; comments grow while unread and restart at 1 once seen; other kinds stay 1. A kind/target mismatch throws (programming error). Then the recipient is trimmed to `NOTIFICATIONS_PER_USER_MAX` = 500 (unread first, then newest kept; seen and oldest go).
  - `retractNotification(tx, recipient, key)`; **added** `markNotificationSeen(tx, recipient, key)` for 6.2's "approve marks it seen".
  - `pushNotifications(app, ids)` after the commit: loads recipients (active users only), skips offline ones (`ChatHub.isUserConnected`), rebuilds each row through the **feed read model** for that recipient (visibility check), validates the frame with `wsServerNotificationSchema`, and sends it with the new `ChatHub.sendToUser` (the `byUser` set; never a room fan-out). Gone, invisible, unparsable or failed reads → nothing sent; failures are logged with ids and the error class only; never throws.
- **`repository.ts`**, one read model for the feed, the count, the push and the shim. `notificationVisibleSql(viewer)`: photo kinds join `media_items` under `viewableSql`, `event_added` joins `events` under `eventVisibleSql`, proposals need `proposed_by_user_id = viewer` and a resolved status. Actor: name always; avatar (64 px) only for listed, active members; never an id. Thumbnails presigned (1 h), `null` if signing fails.
- **Routes** (`auth: "user"` + verified; per-user limits 240/min reads, 120/min mark): `GET /api/notifications` (keyset on `created_at, id`, `unread=true`), `GET /api/notifications/unread-count` (stops counting at the cap), `POST /api/notifications/read` (`{ids}` own rows only, others silently ignored, or `{all: true}`; answers the count).
- **Retention:** daily timer (unref'd, cleared on close) deletes rows older than 180 days in batches of 1000; the 500-row cap runs on every write.
- **Events wiring:** `addParticipants` and `createEvent` (members added at creation) record `event_added` in their transaction and push after the commit (after the room audience refresh). `leaveEvent` and `removeParticipant` retract `event:{id}`. Self-joins (`joinEvent`) notify no one.
- **Deprecated shims** (`events/notices.ts`): `GET /api/events/notices` = the caller's unseen `event_added` rows for visible events they still take part in; `DELETE /api/events/:id/notice` marks `event:{id}` seen and still sets `notice_seen_at` (404 when invisible). The existing WP-5.3 notice test passes unchanged.
- `app.ts` registers the module; `ChatHub` gains `sendToUser` and `isUserConnected`.

## Contract changes (`packages/types/src/notifications.ts`, additive for this WP's own schemas)
- `NotificationMediaTarget.place`: `{edition, year}` | `{album, event: EventRef}` | `{memory, memoryAlbumId}`, so the client can open the photo on its own page (the WP-6.0 target carried only `mediaId`).
- `NotificationEventTarget.canLeave`: the recipient takes part and is not the last organizer (keeps the one-tap "Salir").
- `NOTIFICATION_UNREAD_COUNT_MAX` 99 → **999** (the brief's "999+" badge). WP-6.0.md's interface table still says 99; this WP supersedes it.

## Web
- **Bell** (`features/notifications/NotificationBell.tsx`, initial chunk, no zod): a 44 px round link beside the account menu at every width (TopNav on desktop, the brand bar on phones), festive count badge capped "999+", name "Notificaciones: 3 notificaciones sin leer". Same gate as the chat badge (signed in, verified, no forced password change). Polls every 60 s while focused; any `notification` frame sets the count.
- **`/notificaciones`** (lazy): "Notificaciones", "Marcar todo como leído", entries grouped Hoy / Ayer / Esta semana / Anteriores (reader's timezone), unread entries tinted with a dot and "Sin leer:" for screen readers, actor avatar or a kind icon, photo thumbnail, relative time, "Cargar más". Wording: "Ana te etiquetó en una foto" (+ "Ábrela para aprobar o rechazar la etiqueta."), "Ana y 2 más comentaron tu foto", "A Ana y 2 más les gustó tu foto", "Rosa te agregó a «Viaje»" (or "Te agregaron a «…»"), "Tu propuesta del árbol fue aprobada/rechazada". Never a comment body or a note.
- **Tap-through** marks the entry read and opens: edition photo `/galeria/{year}?foto=`, album photo `/eventos/{year}/{slug}?vista=fotos&foto=`, box photo `/recuerdos/{boxId}?foto=` (6.3's route), the event, or `/arbol?propuesta=` (6.4 owns the proposal view; the tree is the fallback). `?foto=` is handled by 6.2's lightbox; without it the page simply opens.
- **Live:** the page holds the shared chat socket (`useChatConnection`), so frames insert the entry on top (replacing its coalesced older copy) and update the badge; the feed validates every item with `notificationSchema` and drops malformed ones.
- **Replaces 5.4's banner:** `features/events/notices/` deleted; Home and `/eventos` no longer show it; "Salir" stays on `event_added` entries (it retracts the entry server-side; the leave mutation invalidates the feed and the badge).

## Decisions
1. Media targets carry where the photo lives (contract `place`), rather than a generic `/foto/:id` route: each scope already has its page, and the visibility check that admitted the photo also admits its event or box.
2. Unread badge cap 999 (brief) instead of 99 (WP-6.0 table).
3. Leaving or being removed from an event retracts its `event_added` row (otherwise an all-members event would keep saying "te agregó" after you left).
4. Members added when an event is created also get `event_added` (WP-5.3 set `added_by_user_id` there too); a draft's entry stays invisible until it is visible to them.
5. Push skips offline recipients before any read, and disabled recipients entirely.
6. `markNotificationSeen` added to `notify.ts` for 6.2 (approve → seen) so it does not hand-write SQL on this table.

## Tests
- `notifications/notifications.test.ts` (15): no self; like coalescing (actor, count recomputed, unlike/like, uploader's own like ignored, re-fired unread, newer `created_at`); comment count; kind/target mismatch and rollback with the caller's transaction; the 500 cap (seen trimmed first, others untouched); retract/seen per recipient; retention; keyset feed and bad cursor; read-time filtering (participants-only event left, album photo lost, moderated photo → gone from feed and count, no title or id in the body); proposals (pending invisible, note never sent); `event_added` with `canLeave` and retraction on leave; actor PII (avatar while listed, name only once unlisted, no ids or keys); mark read (others' ids ignored, all, 400 on `all: false`); push to the recipient only and nothing for a gone or invisible row.
- Security: matrix rows for the three routes plus an IDOR probe (another member's id → 200, unchanged); `docs/security/routes.md` regenerated; `pii-leak.test.ts` "notifications (WP-6.1)": an unlisted actor's id/avatar and an invisible event's title in neither the feed, the count nor the WS frame.
- Contract: `notifications.test.ts` (place shapes required).
- Web (RTL + MSW, fake socket): `lib/format.test.ts` (wording, links, day groups across timezones), `pages/NotificationsPage.test.tsx` (kinds and links, mark all and one read + badge, Salir, live frame replacing an older copy + badge, empty and error states, Cargar más, bell 999+ and hidden when unverified, malformed entries dropped). `HomeEvents.test.tsx` drops the banner cases.
- e2e: `events.spec.ts` now finds the consent notice through the bell, checks "Salir de …", taps through to the event; `quality.spec.ts` gates `/notificaciones` at 320/375 + axe. Screenshots: `docs/ux/screenshots/notificaciones/notificaciones-{375,1280}.webp`.

## Verification
(see the end of this file; filled in after the runs)
