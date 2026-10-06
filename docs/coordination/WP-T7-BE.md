# WP-T7-BE Chat (backend) [SEC]
Owner: Backend · Reviewers: TL, Security · Branch: wp/t7-be-chat · PR: # (not opened)

Based on `origin/main` (2bcb7a0), then merged with `origin/main` 9718d54 (T5-BE/FE). T8-BE was not on main at hand-off.

## Scope
- `apps/server/src/modules/chat/**`:
  - `index.ts`: module plugin, the WS route, the hub timers, and the exports `closeSocketsForSession`, `closeSocketsForUser`, `chatHubOf`
  - `routes.ts`: REST routes and `POST /chat/ticket`
  - `socket.ts`: upgrade checks and frame handling
  - `hub.ts`: socket registry, fan-out, presence, heartbeat, session re-check
  - `tickets.ts`: in-memory hashed ticket store
  - `limits.ts`: sliding-window limiter and typing throttle
  - `repository.ts`: room visibility, room list with unread counts, keyset history, idempotent insert, monotonic read state, soft delete, session checks
  - `mappers.ts`, `cursor.ts`, `avatars.ts` (batched `avatarUrlFor`)
  - tests: `routes.test.ts` (REST), `socket.test.ts` (WebSocket via `injectWS`), `units.test.ts`; fixtures in `apps/server/test/helpers/chat.ts` (new file)
- `packages/types/src/chat.ts`: contract amendments (below) and `chat.test.ts`.

## Interfaces exposed
| Route | Auth | Notes |
|---|---|---|
| `GET /api/chat/rooms` | U + verified | `ChatRoom[]`: the global room plus rooms of **published** editions. `unreadCount` = live messages from **other** members after `last_read_message_id` in `(created_at, id)` order, capped at 999. `lastMessage` is the newest live message (preview ≤ 140 chars). Ordered by `lastMessageAt` desc; rooms without messages last (global first, then newest year) |
| `GET /api/chat/rooms/:id/messages?before=&limit=` | U + verified | `ChatHistoryPage`. Keyset `(created_at desc, id desc)`, `limit` 1–50 (default 50), `nextBefore` = opaque cursor of the oldest row (epoch µs + id). Messages oldest → newest within a page. Deleted messages are tombstones (`body: ""`, `deletedAt` set, sender kept). Avatars presigned once per distinct key. 404 for unknown rooms and rooms of unpublished editions; 400 for a forged cursor |
| `POST /api/chat/rooms/:id/read` | U + verified | `{ messageId }` → 204. Upsert that only moves forward (`ON CONFLICT … DO UPDATE … WHERE NOT EXISTS (current ≥ new)`). 404 if the message is not in that room |
| `DELETE /api/chat/messages/:id` | U + verified | 204. The sender or an admin. **404** for unknown messages, another member's message (non-admins) and messages in hidden rooms (everyone, admins included). Soft delete (`deleted_at`, `deleted_by_user_id`); an admin deleting **someone else's** message is audited `chat_message.deleted` with `{ roomId, senderUserId }` (no body). Already deleted → 204 no-op. Broadcasts `message_deleted` |
| `POST /api/chat/ticket` | U + verified | 201 `ChatTicketResponse`, `Cache-Control: no-store`. 10/min per user |
| `GET /api/chat/ws?ticket=` | ticket | WebSocket, see below. 30 upgrades/min per IP |

There is **no** route that deletes or closes a room (the contract has none). Edition rooms are never deleted (WP-T2-BE request 6); a test asserts `DELETE /api/chat/rooms/:id` and `/api/admin/chat/rooms/:id` are 404.

### For T1/T8: closing sockets
```ts
import { closeSocketsForSession, closeSocketsForUser } from "../chat/index.js";
closeSocketsForSession(app, sessionId); // after logout / session revoke / password change (other sessions)
closeSocketsForUser(app, userId);       // after disabling a user or revoking all their sessions
```
`app` is any Fastify instance of the app (the hub is found through the shared `app.server`). Both close the sockets with `4010 SessionRevoked`, burn unused tickets, return the number of sockets closed, and are no-ops (0) when nothing is connected. Call them **after** the revoking transaction commits. Without these calls, sockets still close at the next 5-minute re-check. Wired in `modules/auth` (via `auth/chatSockets.ts#closeChatSockets`, non-fatal) and `modules/admin/userRoutes.ts` (disable, revoke sessions, force reset).

`closeSocketsForSession` also remembers the session id for 60 s (`REVOKED_MEMORY_MS`), so a socket whose handshake passed the DB check just before the revocation cannot register afterwards. User-level races (disable, closeUser) are covered by a second DB check right after registration.

## WebSocket protocol summary
Handshake (`GET /api/chat/ws?ticket=…`, route `auth: "public"`):
1. The ticket (`opaqueTokenSchema`) is looked up by SHA-256 hash and **deleted on lookup**, on **any** upgrade attempt (used, expired or from a bad Origin, it is gone).
2. `Origin` must equal one of `allowedOrigins(config)` (`CORS_ORIGIN` + `DEV_ALLOWED_ORIGINS`; the latter is forced empty in production). Missing or other → close **1008**. Then an unknown/expired ticket → 1008.
3. At the global soft cap (`MAX_SOCKETS_TOTAL` = 2000) → close **1013** ("try again later").
4. The ticket's session is loaded from the DB: it must belong to the ticket's user and be unrevoked and unexpired, with the user `active`, email verified and not pending a password change. Otherwise → 1008.
5. The socket registers, then the session is checked once more (race with a concurrent revocation → `4010`).
6. Caps: at most `MAX_SOCKETS_PER_SESSION` = 3 sockets per session and `MAX_SOCKETS_PER_USER` = 8 per user. A new socket over a cap closes the **oldest** one: it gets an `error {code: "CONFLICT", message: "Demasiadas conexiones abiertas."}` frame, then a normal close **1000** with the same reason (clients must not auto-reconnect on 1000).

All handshake rejections use the same reason (`"No autorizado."`). Client: on 1008, fetch a new ticket; a 401 there means refresh/log in.

Frames (JSON text only, `maxPayload` = `WS_MAX_FRAME_BYTES` = 8 KB; larger → ws closes **1009**):
| Client → server | Server behaviour |
|---|---|
| `send {roomId, body, clientMessageId}` | 20 per 10 s per user (`error RATE_LIMITED` past it). Room must be visible (`error NOT_FOUND`). Insert `ON CONFLICT (sender_user_id, client_message_id) DO NOTHING`; new → `message` to every socket (`clientMessageId` echoed to the sending socket, `null` for the rest); duplicate → `message` with the **stored** message to the sender only |
| `typing {roomId}` | Throttled to 1 per 3 s per user and room; relayed as `typing {roomId, userId, displayName}` to other users' sockets |
| `read {roomId, messageId}` | Same monotonic update as the REST route; `error NOT_FOUND` if the message is not in the room |
| `ping {ts?}` | `pong {ts | null}` |

- Every frame counts toward 60 per 10 s per user (`error RATE_LIMITED`). Frames are processed **one at a time, in order** per socket; more than 32 waiting frames close the socket with `4008 RateLimited`.
- Invalid JSON, binary frames, unknown `type`s and schema failures → `error {code: "VALIDATION", message, clientMessageId}` (the id when it parses as a uuid). The 5th invalid frame closes with `4400 ProtocolError`.
- `presence {onlineUserIds}` lists only members with `profiles.listed_in_directory = true` (no profile → unlisted); each recipient also sees their own id. It is broadcast when a listed user's first socket opens or last socket closes, and when a listing changes (picked up by the 5-minute re-check); other new sockets get it directly. Unlisted members are never announced.
- **Backpressure:** before every send the socket's `bufferedAmount` is checked. Above 1 MB (`BUFFER_TERMINATE_BYTES`) the socket is **terminated** (a close frame could not reach a reader that is not reading; the client sees 1006 and the server logs only the connection id). Above 256 KB (`BUFFER_SKIP_LOW_PRIORITY_BYTES`), `typing` and `presence` frames are dropped for that socket; messages, deletes and errors still go.
- The server sends a protocol-level **ping every 25 s** (`WS_PING_INTERVAL_MS`) and terminates sockets that did not pong since the previous round. Browsers pong automatically.
- Every 5 min, all connected sessions are re-validated in one query; sockets of revoked/expired sessions or disabled/unverified/must-change users close with `4010 SessionRevoked`.
- The sender always comes from the socket's session, never from the frame.

## Contract amendments (`packages/types/src/chat.ts`) [flagged]
1. **`WS_MAX_FRAME_BYTES` 16 KB → 8 KB** (brief). `app.ts` already passes it as `maxPayload`, so no frozen file changed. A maximal `send` (2000 UTF-16 units ≤ 6000 UTF-8 bytes + envelope) still fits.
2. **`chatHistoryQuerySchema.limit` max 100 → 50, default 50** (`CHAT_HISTORY_LIMIT_MAX`) (brief).
3. **`ChatRoom.lastMessage: ChatRoomLastMessage | null`** (new interface + `chatRoomLastMessageSchema`: `id`, `senderDisplayName | null`, `preview` ≤ `CHAT_PREVIEW_MAX_LENGTH` (140), `createdAt`) for the room-list preview (brief). `unreadCount` is now bounded by `CHAT_UNREAD_COUNT_MAX` (999).
4. New constant `CHAT_TICKET_TTL_SECONDS = 30`.

Web impact: no web code builds `ChatRoom` yet (only the `ChatRoom` RTK tag), so nothing else changed. T7-FE should render `999+` at the cap.

## Decisions
- **Visibility = membership.** Every verified member reads every visible room (WP-0.3 dropped membership rows), so "sockets subscribed to room R" is every live socket; each `send`/`typing`/`read` re-checks that R is visible. Rooms of editions that were unpublished keep their history but disappear from the list and answer 404.
- **Single process.** The hub, tickets and limits live in memory. Scaling to more than one API process would need Postgres `LISTEN/NOTIFY` (a `chat` channel carrying message ids / delete events, each process fanning out locally) plus shared tickets and rate limits. A restart drops outstanding tickets; clients reconnect with a new one.
- **`created_at` is the DB clock** (`now()` default), not `app.clock`, so history order is strict to the microsecond. Expiry, tickets, limits and the re-check use `app.clock`.
- **Soft-deleted bodies stay in the DB** (the `char_length between 1 and 2000` CHECK forbids blanking) for moderation; they never leave the server (tombstones, previews skip deleted messages, the audit has no body).
- Unread counts exclude the caller's own messages, so sending does not need a read update.
- Handshake checks run inside the WS handler (after the 101) so the client gets a close code; the upgrade itself is cheap and rate-limited per IP.
- **Logging:** bodies and tickets are never logged. The upgrade URL is scrubbed by the WP-0.4 serializer (`ticket=[REDACTED]`); handshake rejections log only the failed check; DB errors go through the WP-0.4 serializer (SQL text, no params). A test sends a distinctive body and ticket and asserts neither appears in the captured logs.
- Ticket store cap: 10,000 outstanding (oldest evicted); per-user issuance is already 10/min.

## WP-2.4 items (nginx)
```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
# Log format without the query string, for the chat socket (the ticket is in ?ticket=).
log_format cuencada_noquery '$remote_addr - $remote_user [$time_local] "$request_method $uri $server_protocol" '
                            '$status $body_bytes_sent "$http_referer" "$http_user_agent"';

location = /api/chat/ws {
  proxy_pass http://127.0.0.1:3104;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection $connection_upgrade;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $remote_addr;   # overwrite, never append (WP-0.4)
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_read_timeout 75s;                          # > 25 s server ping; idle sockets survive
  proxy_send_timeout 75s;
  proxy_buffering off;
  access_log /var/log/nginx/cuencada_access.log cuencada_noquery;   # $uri, not $request: no ?ticket=
}
```
- Keep `Origin` intact (do not rewrite it); the app checks it against `CORS_ORIGIN`.
- `error_log` lines can include the request line with the query; keep `error_log` at `warn` or above for this location, or accept that risk explicitly.
- CSP `connect-src` already lists the `wss://` app origin (WP-0.4).

## Requests (→ orchestrator)
1. Resolved: T5-BE merged before hand-off, so sender avatars use `avatarUrlFor(app, key, AvatarSize.Small)` from `modules/profile` (64 px; the interim copy is gone).
2. Resolved (authorized cross-module edit, `modules/auth/**`): `auth/chatSockets.ts#closeChatSockets` runs **after commit** and is non-fatal (logs the error name; the 5-minute re-check is the backstop). Logout, revoke-one, revoke-others and refresh-token reuse close the revoked session ids; logout-all, change-password and password-reset confirm close every socket of the user (the new session from change-password has no socket yet, since its token has not been sent). Tests: `auth/chatSockets.test.ts` (logout keeps the other session's socket, logout-all, revoke-one/others, change-password + the new session can connect, reset confirm).
3. Resolved (authorized, after merging T8-BE): the admin module's `TODO(T7)` placeholder now calls `closeChatSockets` → `closeSocketsForUser` on disable, revoke sessions and force reset. Test: `admin/chatSockets.test.ts` (all three close an open socket with 4010).
4. **T7-FE:**
   - Reconnect with backoff on any close except `4010` (re-auth first), `1008` (new ticket; on 401 refresh/log in) and `1000` (closed on purpose, e.g. replaced by a newer tab: show "Demasiadas conexiones abiertas" and reconnect only on user action). `1013`: back off longer.
   - Track unread with `lastMessage`/`unreadCount`; show `999+` at the cap. Keep under 60 frames / 10 s and do not burst more than 32 frames.
   - Render bodies and display names as **text nodes only** (no `dangerouslySetInnerHTML`, no unsanitized markdown); Security verified `<img onerror>` is stored and relayed as text.
5. **T5 (help text for "Aparecer en el directorio"):** unlisted members are left out of chat presence, but chat still shows the **author's** display name and avatar on messages they post (posting is voluntary and visible; Security accepted this). Suggested help text: "Tus mensajes en el chat mostrarán tu nombre y foto."
6. **Optional:** `MemberCuencadaDetails.chatRoomId` (WP-T2-BE request 4) if T7-FE wants to deep-link from an edition page.

## Review log
- **PR #25 round 1 (Security: CHANGES REQUESTED; TL addendum).** Addressed:
  - **M1:** per-session (3) and per-user (8) caps closing the oldest socket (error frame + 1000), global soft cap 2000 → 1013, constants exported; backpressure on every send (terminate past 1 MB buffered, skip typing/presence past 256 KB). Tests in `chat/capacity.test.ts` (4th socket on a session, 9th on a user across sessions, global cap, slow reader terminated via a simulated `bufferedAmount`, low-priority skipping).
  - **L1:** presence lists only directory-listed members (each user sees themselves), refreshed by the re-check; authors still show name/avatar (T5 help-text request 5). Tested.
  - **L2:** the ticket is burned before the Origin check; a ticket tried from a foreign origin then fails from the real one. Tested.
  - **L3 + TL:** delete answers 404 for another member's message and for messages in hidden rooms. Tested.
  - **TL handshake race:** closed sessions are remembered 60 s and refused at registration (tested at the hub), plus a second DB check right after registration for user-level changes.
  - **TL nit:** shutdown awaits an in-flight re-check (`hub.idle()`).
  - **T8 wiring** (merged origin/main with T8-BE): admin disable / revoke sessions / force reset close the user's sockets; `admin/chatSockets.test.ts`.
  - `pnpm lint && pnpm turbo run typecheck --force && pnpm test && pnpm build`: green (122 files, 1374 tests).

## Verification (2026-10-06)
- After merging `origin/main` (9718d54): `pnpm lint && pnpm turbo run typecheck --force && pnpm test && pnpm build` all green (111 files, 1274 tests).
- Chat tests (49 server + 12 contract): `routes.test.ts` 17 (REST happy/400/401/403-unverified, keyset paging with timestamp ties, tombstones + avatars, unread counts, monotonic read, delete own/other/admin+audit, no room deletion, ticket shape/no-store/10-per-min), `socket.test.ts` 21 (bad/missing Origin, single use, expiry with the injected clock, session binding, disabled/unverified/must-change, fan-out to two clients, idempotent `clientMessageId`, invalid frames + close after 5, 8 KB cap → 1009, hidden rooms, 20/10 s send limit, 60/10 s frame limit, queue flood → 4008, ping/typing, WS read, delete broadcast, re-check closes revoked/disabled/expired sessions, `closeSocketsForSession`/`User`, heartbeat terminate, no bodies/tickets in logs), `units.test.ts` 11, contract `chat.test.ts` +2.
