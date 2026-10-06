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
| `DELETE /api/chat/messages/:id` | U + verified | 204. The sender or an admin; others 403. Soft delete (`deleted_at`, `deleted_by_user_id`); an admin deleting **someone else's** message is audited `chat_message.deleted` with `{ roomId, senderUserId }` (no body). Already deleted → 204 no-op. Broadcasts `message_deleted` |
| `POST /api/chat/ticket` | U + verified | 201 `ChatTicketResponse`, `Cache-Control: no-store`. 10/min per user |
| `GET /api/chat/ws?ticket=` | ticket | WebSocket, see below. 30 upgrades/min per IP |

There is **no** route that deletes or closes a room (the contract has none). Edition rooms are never deleted (WP-T2-BE request 6); a test asserts `DELETE /api/chat/rooms/:id` and `/api/admin/chat/rooms/:id` are 404.

### For T1/T8: closing sockets
```ts
import { closeSocketsForSession, closeSocketsForUser } from "../chat/index.js";
closeSocketsForSession(app, sessionId); // after logout / session revoke / password change (other sessions)
closeSocketsForUser(app, userId);       // after disabling a user or revoking all their sessions
```
`app` is any Fastify instance of the app (the hub is found through the shared `app.server`). Both close the sockets with `4010 SessionRevoked`, burn unused tickets, return the number of sockets closed, and are no-ops (0) when nothing is connected. Call them **after** the revoking transaction commits. Without these calls, sockets still close at the next 5-minute re-check.

## WebSocket protocol summary
Handshake (`GET /api/chat/ws?ticket=…`, route `auth: "public"`):
1. `Origin` must equal one of `allowedOrigins(config)` (`CORS_ORIGIN` + `DEV_ALLOWED_ORIGINS`; the latter is forced empty in production). Missing or other → close **1008**. This runs first, so a cross-origin attempt does not burn the ticket.
2. The ticket (`opaqueTokenSchema`) is looked up by SHA-256 hash and **deleted on lookup** (used or expired, it is gone). Unknown/expired → 1008.
3. The ticket's session is loaded from the DB: it must belong to the ticket's user and be unrevoked and unexpired, with the user `active`, email verified and not pending a password change. Otherwise → 1008.

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
- `presence {onlineUserIds}` is broadcast when a user's first socket opens or last socket closes; a second socket of an already-online user gets it directly.
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
3. **T8 follow-up:** replace the `TODO(T7)` placeholder (`closeChatSockets()`) in the admin module with `closeSocketsForUser(app, userId)` on disable / revoke sessions / force reset, plus a test that an open socket closes. T8 was not on `origin/main` when this WP finished.
4. **T7-FE:** reconnect with backoff on any close except `4010` (re-auth first) and `1008` (new ticket; on 401 refresh/log in). Track unread with `lastMessage`/`unreadCount`; show `999+` at the cap. Keep under 60 frames / 10 s and do not burst more than 32 frames.
5. **Optional:** `MemberCuencadaDetails.chatRoomId` (WP-T2-BE request 4) if T7-FE wants to deep-link from an edition page.

## Verification (2026-10-06)
- After merging `origin/main` (9718d54): `pnpm lint && pnpm turbo run typecheck --force && pnpm test && pnpm build` all green (111 files, 1274 tests).
- Chat tests (49 server + 12 contract): `routes.test.ts` 17 (REST happy/400/401/403-unverified, keyset paging with timestamp ties, tombstones + avatars, unread counts, monotonic read, delete own/other/admin+audit, no room deletion, ticket shape/no-store/10-per-min), `socket.test.ts` 21 (bad/missing Origin, single use, expiry with the injected clock, session binding, disabled/unverified/must-change, fan-out to two clients, idempotent `clientMessageId`, invalid frames + close after 5, 8 KB cap → 1009, hidden rooms, 20/10 s send limit, 60/10 s frame limit, queue flood → 4008, ping/typing, WS read, delete broadcast, re-check closes revoked/disabled/expired sessions, `closeSocketsForSession`/`User`, heartbeat terminate, no bodies/tickets in logs), `units.test.ts` 11, contract `chat.test.ts` +2.
