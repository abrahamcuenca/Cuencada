# WP-T7-FE Chat [SEC]
Owner: Frontend · Reviewers: TL, Sec · Branch: wp/t7-fe-chat · PR: # (not opened)

Built against the WP-0.2 chat contract with MSW and a fake WebSocket. Mid-task, the orchestrator relayed the T7-BE notes twice and asked for `wp/t7-be-chat` to be merged in to align types (last merge: `origin/wp/t7-be-chat` @ eee980d, PR #25 round 1). This branch therefore contains the T7-BE commits:
- contract: `ChatRoom.lastMessage`, `CHAT_UNREAD_COUNT_MAX`, `WS_MAX_FRAME_BYTES` 8 KB, history `limit` ≤ 50
- socket caps: 3 per session, 8 per user, with eviction of the oldest

**Merge T7-BE first.**

## Scope

### Socket client: `features/chat/socket.ts`
- **One shared connection per tab, only while `/chat` is mounted.**
  - `ChatPage` is a single parent route, with the room id on a child route, so moving between rooms keeps the same socket.
  - The last release closes the socket a microtask later, so StrictMode's double effects don't reconnect.
  - Outside `/chat` there is no socket. The Chat tab badge polls instead (see below). Keeping a socket open in every idle tab would keep phones awake just to update a badge that can afford to be a minute late.
- **Handshake:**
  1. `POST /chat/ticket` (RTK mutation, `track: false`) right before every (re)connect.
  2. The response is validated with `chatTicketResponseSchema`.
  3. The URL is built by `buildChatSocketUrl`:
     - the host always comes from `env.apiBaseUrl`, never from the response
     - `wsPath` must be a plain absolute path (no `//host`, `..` or query)
     - `wss:` is required; `ws:` is allowed only when `env.isDev`
  4. The ticket is never logged or stored. No `console.*` call exists anywhere in the feature, and a test asserts that.
- **Inbound frames:** dropped unless all of these pass:
  - a string payload of at most `WS_MAX_FRAME_BYTES` (checked before `JSON.parse`, with UTF-8 byte counting for multi-byte text)
  - valid JSON
  - `wsServerMessageSchema`
- **Outbound frames:** validated with `wsClientMessageSchema`; bodies go through the contract's `chatBodySchema` (NFC, bidi/invisible stripping).
- **Rate budget** (the server allows 20 sends and 60 frames per 10 s, and closes at 32 queued frames). The client stays under it with sliding windows:
  - at most 18 sends and 50 frames per 10 s
  - bursts of at most 8 per second
  - over budget, `send` frames wait in an ordered outbox; `typing`/`ping` frames are dropped
- **Reconnect:** exponential backoff with equal jitter: 1 s, 2 s, 4 s … capped at 30 s. Half of each delay is fixed and half is random.
  - The backoff resets after a connection stays up 10 s, and after `online` / `visibilitychange` / resume.
  - Every reconnect gets a fresh ticket.
  - On `open` after a reconnect (`resumed: true`), the room list and open conversations refetch, and pending messages are resent.
- **Close codes:**

  | Code | Meaning | Client response |
  |---|---|---|
  | 1008, 1009, 1006, 4400 | ticket problem, oversized frame, dropped connection (or a slow reader the server terminated), protocol error | retry with backoff and a new ticket (a ticket is burned on any attempt, so it is never reused) |
  | 4008 | rate limited / backpressure | retry, with the backoff floor raised to 8 s |
  | 1013 | server full | wait at least 30 s (30–45 s with jitter) |
  | 1000 after an `error` frame with `CONFLICT` and no `clientMessageId`, or with the reason "Demasiadas conexiones abiertas." | the account has too many sockets and the server evicted this one | **no automatic reconnect** (it would evict another tab in turn); status `evicted` shows "Se abrió el chat en otra pestaña." with a **Reconectar** button |
  | 4003 | forbidden | `forbidden` state, no retries |
  | 4010 | session revoked | **no blind retry**: one authenticated `GET /chat/rooms` runs the normal auth flow (refresh, or `loggedOut` if refused). Only a session that survives it reconnects; a revoked session can't, because its ticket request would 401 as well |

- **Pauses:**
  - **offline** (`navigator.onLine === false` or the auth `isOffline` flag): the socket is closed and the client waits for `online`.
  - **tab hidden for 5 min:** the socket is closed and reopens as soon as the tab is visible again.
- **Liveness:** an app-level `ping` every 25 s. With no inbound frame for 60 s, the connection is treated as dead (half-open after a phone sleeps) and replaced.
- **[SEC] Session changes:** a store subscription compares `sessionEpoch:userId`. On logout, account switch or a new epoch:
  - the socket closes immediately
  - an in-flight ticket is discarded
  - a still-mounted chat reconnects only with a ticket for the new session
  - a ticket aborted by the account switch's cache reset is retried

### Streaming cache
- **`api.ts`** (initial chunk; it only needs `getRooms`): `getRooms` turns `ChatRoom.lastMessage` into a `RoomPreview` and uses `onCacheEntryAdded` to apply `message` / `message_deleted` frames:
  - preview, `lastMessageAt` and re-sorting
  - `unreadCount + 1` for other people's messages, capped at 999, unless that room is on screen and scrolled to the bottom
  - a refetch for an unknown room
  - a refetch merge keeps a newer preview that came from a frame
- **`conversationApi.ts`** (lazy, injected by the chat chunk):
  - **`getMessages(roomId)`:**
    - loads the latest page (50)
    - `onCacheEntryAdded` merges frames: echo → confirm, duplicates ignored, tombstones win
    - an `error` frame or the 15 s echo timeout marks the message `failed`
    - pending messages are resent on `open`
    - a refetch after a reconnect merges, and restarts from the new page if more than a page was missed, so there is never a silent hole
  - **`getMessagesBefore`:** keyset pages that are prepended.
  - **`markRoomRead`:** optimistic `unreadCount: 0`.
  - **`createChatTicket`.**
  - **`deleteChatMessage`:** tombstones the message on success.
- **Optimistic send** (`actions.ts`):
  1. A `clientMessageId` (`crypto.randomUUID`, with a `getRandomValues` v4 fallback for LAN dev over http) and a `pending` bubble appear at once.
  2. The echo with the same id turns it `sent`, without a duplicate or a remount.
  3. "Reintentar" resends with the **same** id (the server is idempotent). "Descartar" drops it.
- All cache helpers are pure functions (`lib/thread.ts`, `lib/rooms.ts`) with unit tests.

### `/chat`: room list
- The global "Toda la familia" room is pinned first; the others follow by most recent activity.
- Each row shows the last message as "Nombre: texto", or "Tú: …" when known from a frame or history, and "🚫 Mensaje eliminado" for a deleted one.
- The time label reads "9:41 a.m." today, then "ayer", then a weekday ("dom"), then a date ("14 sept").
- A festive count badge shows unread messages ("999+" at the server cap), with screen-reader text "3 mensajes sin leer" / "999 o más mensajes sin leer".
- **≥900px:** two panes (320px list + conversation), with an "Elige una sala" placeholder.

### `/chat/:roomId`: conversation
- **Full screen on phones:** the child route has `MINIMAL_CHROME`, so there is no BottomNav and the composer owns the bottom edge.
- **Composer above the keyboard:**
  - `useChatViewport` puts the layout in a fixed pane from under the app bar (a zero-height marker, so banners are respected) to the bottom of the **visual viewport**
  - it updates on `visualViewport` resize/scroll, window resize/scroll and body resize
  - when the visual viewport is ≥120px shorter than the window it sets `data-keyboard="open"`, which drops the `env(safe-area-inset-bottom)` padding (the inset sits under the keyboard)
  - the list sticks to the newest message when it shrinks (ResizeObserver), so the keyboard opening never hides the last bubble
- **Text only [SEC]:** message bodies and display names are rendered strictly as React text nodes. Presence frames are validated and ignored.
- **Bubbles:**
  - grouped by sender within 5 minutes on the same day
  - avatar and name at the start of a group, time at the end
  - mine on the right, green-soft, "✓" when sent, "Enviando…" while pending
  - every bubble carries a visually hidden "Nombre: " prefix inside groups, so screen readers hear who wrote it
  - tombstones read "🚫 Mensaje eliminado"
  - a sender whose account was removed shows "Cuenta eliminada"
- **Separators:** day separators in `es-MX` ("Hoy", "Ayer", "Lunes 14 de septiembre", with the year when it isn't the current one). A "Nuevos mensajes" divider is placed once, when the room opens, from `lastReadMessageId` / `unreadCount`.
- **Auto-scroll** (`lib/scroll.ts`, pure):
  - jump to the bottom on the first render, after my own send, or when I was within 96px of the bottom
  - otherwise show a "Nuevos mensajes ↓" pill
  - a prepended history page preserves the scroll position
- **History:** "Cargar anteriores", or reaching the top of the list, loads older messages. It first reveals cached messages hidden by the DOM cap, then fetches the previous keyset page.
- **DOM cap:** at most 300 messages are rendered. The window is anchored while you read history and shrinks again once you're back at the bottom.
- **Mark as read:** when the newest server message is on screen (tab visible, near the bottom), `POST …/read` is sent at most once per 2 s (the last one is always sent). It's skipped when the room already says it was read up to that message.
- **Typing:**
  - a `typing` frame is sent at most every 3 s, and only while the socket is open
  - incoming typing shows "Rosa está escribiendo…", "Rosa y Tomás están escribiendo…" or "Varias personas…"
  - it expires after 6 s or when that person's message arrives
  - it is `aria-hidden` (too chatty for a live region)
- **Message menu:**
  - long-press (500 ms, 10 px slop, touch only), right-click, or the "⋯" button opens a bottom-sheet `Dialog`
  - the "⋯" button is always focusable; on hover-capable devices it is hidden until hover/focus
  - the menu offers "Copiar texto" (when the Clipboard API exists) and "Eliminar" (my messages, or any for admins; a UX hint only, since the server decides)
  - "Eliminar" opens an `alertdialog` confirm (`closeOnBackdrop={false}`), then sends `DELETE`, which produces a tombstone and a toast
  - a 404 (already deleted, or someone else's message for a non-admin) is treated as "ya no existe": the message is tombstoned locally and a "Ese mensaje ya no existe." toast is shown
- **Composer:**
  - plain `<textarea>` with a hidden "Mensaje" label
  - grows to 5 lines, then scrolls
  - **Enter sends only with `(hover: hover) and (pointer: fine)`**; Shift+Enter adds a line; IME composition is respected; on touch devices Enter is always a newline
  - 44px send button (`IconButton` solid)
  - from 1,800 characters a counter shows "1,800 / 2,000"; above 2,000 it reads "· Demasiado largo" and sending is disabled
  - with a physical keyboard the composer gets focus on open; on touch the room title gets it, so the keyboard doesn't pop up
- **Links [SEC]:**
  - bodies render as React text
  - only `http(s)://` URLs that `new URL` accepts, without credentials, become `<a target="_blank" rel="noopener noreferrer">`
  - `javascript:`, `data:`, `vbscript:` and `www.` stay text
  - trailing punctuation is trimmed, keeping a parenthesis that balances one inside the URL
  - no `innerHTML`, no `eval`
  - **anti-spoofing (Security L1, PR #28):** the visible link text is rebuilt from the parsed URL, never the typed text: scheme, the ASCII host (punycode for lookalikes, e.g. `https://xn--pple-43d.com/login`) and the percent-encoded path. **The host is never truncated** (Security re-review): a host longer than 40 characters shows only its end, cut at a label boundary, so the registrable domain stays visible (`https://…evil.example/x`); only the path/query/fragment is cut, at 60 characters total, with "…". The `title` carries the full ASCII URL. A URL containing zero-width, bidi-control or BOM characters (U+200B–200F, U+202A–202E, U+2066–2069, U+FEFF) is never linkified. Ideographic full stops (。．｡) are normalized to "." before parsing, so `evil.com。com` shows as `evil.com.com`
- **Connection status** (`<output>` under the app bar):

  | State | Message |
  |---|---|
  | connecting | "Conectando…" |
  | reconnecting | "Reconectando… Los mensajes se enviarán cuando vuelva la conexión." |
  | offline | "Sin conexión. Los mensajes se enviarán cuando vuelva la conexión." |
  | evicted | "Se abrió el chat en otra pestaña." + "Reconectar" |

- **403** (on the room list, the history or the ticket, or close code 4003) shows "Verifica tu correo para usar el chat" and never opens a socket.
  - The socket is only acquired after `GET /chat/rooms` succeeds, so an unverified account never asks for a ticket.
  - An invalid room id is caught client-side ("No encontramos esa sala", no request); a 404 shows the same message.

### Accessibility
- **The log:** `role="log"`, `aria-live="polite"`, `aria-relevant="additions"`. `aria-busy` is set while a history page loads, so older messages aren't announced as new.
- **Focus:** the log has `tabIndex=-1` so it can take focus programmatically after a deletion.
- **Targets:** every interactive control is at least 44px. The status line is an `<output>`.

### Unread badge (app shell)
- `useChatUnreadBadge()` (`features/chat/unread.ts`) feeds the "Chat" item of both `BottomNav` and `TopNav` (`badge` / `badgeLabel`: "Chat, 3 mensajes sin leer").
- **When it requests:** only for an authenticated member, past the forced password change, with a verified email. **Nothing is requested when logged out.**
- **How it stays fresh:**
  - polling every 2 min, paused while the window is unfocused (`skipPollingIfUnfocused`)
  - stopped after a 403
  - `refetchOnReconnect` applies
  - on `/chat` the socket keeps the same cache entry live
- **Bundle:** the initial chunk carries only `api.ts` (`getRooms`), `events.ts`, `unread.ts` and `lib/rooms.ts`, about +1.3 KB gzip. They never import *values* from `@cuencada/types`: one value import keeps all chat zod schemas in the entry chunk (+2.6 KB measured). `lib/limits.ts` mirrors `CHAT_UNREAD_COUNT_MAX`, and a test checks it against the contract.

## Decisions
- **Socket only on chat routes; the badge polls.** See above. If the product wants instant badges everywhere, keep the socket open whenever a member is signed in and the tab is visible. `ChatConnection.acquire()` already supports more holders.
- **Chat times use the reader's timezone** (`Intl…resolvedOptions().timeZone`), unlike the programa, which always uses the Cuencada's timezone. Chat is real-time conversation between people in different places. Every formatter takes the timezone as a parameter, and tests pin `America/Merida`.
- **The "Tú:" prefix in the list** shows only when a frame or loaded history tells us the sender id. `ChatRoomLastMessage` only has the display name (Request 1).
- **Rooms order:** the global room is pinned first, then by recent activity (the server already sorts by activity). The wireframe shows the global room on top.
- **Deleting the previewed message** shows "🚫 Mensaje eliminado" in the list until the next refetch. The server's preview skips to the previous live message.
- **The send queue lives in the cache:** pending messages persist across reconnects in the `getMessages` cache entry (kept 5 min after leaving the room) and are resent on every `open`. The server dedupes by `clientMessageId`.

## Files
- **Feature:** `apps/web/src/features/chat/`
  - `api.ts`, `conversationApi.ts`, `events.ts`, `socket.ts`, `actions.ts`, `unread.ts`, `routes.tsx`, `chat.module.css`
  - `pages/ChatPage.tsx`
  - `components/{RoomList,Conversation,MessageList,MessageRow,Composer,MessageMenu,LinkifiedText}.tsx`
  - `lib/{thread,rooms,format,linkify,scroll,uuid,limits,useChatViewport}.ts`
  - `testing/{fakeSocket,fixtures}.ts`
- **Tests:**
  - `socket.test.ts` (25)
  - `pages/ChatPage.test.tsx` (20)
  - `lib/thread.test.ts` (22)
  - `lib/linkify.test.ts` (6)
  - `lib/scroll.test.ts` (9, including the visual-viewport geometry)
  - `lib/format.test.ts` (4)
  - `lib/limits.test.ts` (1)
- **Outside the feature (authorized / test infra):**
  - `apps/web/src/app/AppLayout.tsx`: the Chat badge on BottomNav and TopNav; `bottomNavItems(programaPath, chatBadge?)`
  - `apps/web/test/msw.ts`: default `GET /chat/rooms → []`, because every signed-in layout render now asks for it
- **Screenshots:** `docs/ux/screenshots/t7/`
- Not edited: `router.tsx`, `store.ts`, `baseApi.ts`, `shared/ui/**`.

Fixtures, tests and screenshots use invented people only ("Lucía Ramírez Solís", "Tomás Herrera Vidal", "Rosa Herrera Soto", "Inés Navarro Soto"…), with initials avatars.

## Verification (2026-10-06, `origin/main` and `origin/wp/t7-be-chat` @ eee980d merged in)
- `pnpm lint`: clean (572 files).
- `pnpm turbo run typecheck --force`: 6/6 tasks pass.
- `pnpm test`: 134 files, 1513 tests pass. The chat feature has 86.
- `pnpm build`: succeeds.
- `pnpm --filter @cuencada/web size`: initial JS is **173.02 kB gzip** (budget 190). The badge's share is about 1.3 kB.
- Lazy chat chunk: `ChatPage` 14.51 kB gzip JS + 2.33 kB CSS. It holds the socket, the zod frame validation (zod itself is already in the entry chunk), the conversation endpoints and the UI.
- **Screenshots** (`docs/ux/screenshots/t7/`): `salas`, `conversacion-teclado` (375), `conversacion` (1280) and `eliminar`, at 375 and 1280.
  - Taken with headless Chromium against the Vite dev server, with `/api/**` stubbed by `page.route` and the WebSocket mocked by `page.routeWebSocket` (it answers pings and sends a typing frame).
  - The keyboard shot overrides `window.visualViewport` to 300px shorter than the window and paints a grey "Teclado en pantalla (simulado)" block there: the composer sits right above it, and the list stays on the newest message.
  - Horizontal overflow is **0 px** for every screen at 320, 375 and 1280.

## Requests
1. **T7-BE / contract:** add `senderUserId` to `ChatRoomLastMessage`, so the list can say "Tú: …" straight from `GET /chat/rooms`. Today it only can after a frame or a history load.
2. **T7-BE:** after a `message_deleted` that removes a room's previewed message, consider sending the room's new preview (or a `room_updated` frame). Until then the client shows "Mensaje eliminado" until the next refetch.
3. **T1 / T7-BE:** the UI treats any 403 on chat (rooms, history, ticket, close 4003) as "verify your email". A distinct code (e.g. `EMAIL_UNVERIFIED`) would avoid a misleading message if chat ever returns 403 for another reason. T6-FE made the same request.
4. **WP-2.3 (Security):** the CSP `connect-src` needs the WebSocket origin. Add `wss://cuencada.com` explicitly: older Safari doesn't treat `'self'` as covering `wss:`.
5. **WP-2.4 (deploy):**
   - strip the query string from the reverse-proxy access logs for `/api/chat/ws` (already in ADR 0001)
   - pass the `Upgrade`/`Connection` headers
   - keep `proxy_read_timeout` above 60 s: the client pings every 25 s and treats 60 s of silence as dead
6. **T9 (PWA), forwarded by the orchestrator:** the service worker must **never** intercept or cache `/api/chat/*` (REST or WS). Chat data lives only in the in-memory RTK cache, which `loggedOut` already resets.
7. ~~**WP-0.6 / `index.html`:** `interactive-widget=resizes-content`~~ **Approved and done** in the PR #28 review round (see the review log).
8. **WP-0.7:**
   - `Badge shape="count"` caps numbers at "99+". The room list passes the string "999+" at the server cap.
   - The BottomNav tab badge sums rooms and shows "99+" above 99 (fine).
   - A shared `ActionSheet` (a list of actions in a bottom-sheet `Dialog`) would serve the chat menu and future long-press menus.
9. **Orchestrator:** this branch includes `wp/t7-be-chat` (merged as instructed). Please merge T7-BE before this PR, or review the two together.

## Review log
- **2026-10-06, PR #28 round 1.** Security approved with one Low; the Tech Lead requested changes. Addressed:
  - **Security L1 (link spoofing):** visible link text rebuilt from the parsed URL (punycode host, encoded path, truncated), `title` with the full ASCII URL; no links containing bidi/invisible characters; ideographic full stops normalized. Tests: Cyrillic lookalike → `xn--pple-43d.com`, RTL `…gpj.exe` not linkified, `evil.com。com` → `evil.com.com`, normal links unchanged.
  - **TL Blocking 1 (lost frames during the first history load):** `getMessages` and `getRooms` now subscribe to the event hub **before** `cacheDataLoaded` (`subscribeChatEventsOnceLoaded` in `events.ts`), buffer frames, and replay them in order once the data is there; if the load fails, they unsubscribe. The dedupe helpers make the overlap harmless. Test: the history response is held, frames for message 5 (also in the page) and message 6 arrive, the response is released, and each renders exactly once.
  - **TL non-blocking 1:** 5 consecutive 1008 closes (with no valid frame in between) stop the retries, set status `failed` ("No pudimos conectar el chat. Recarga la página.") and call `reportUnexpected` (the ticket is never in the error). Tested.
  - **TL non-blocking 3:** the store listener returns early when `state.auth` is the same object as last time.
  - **TL nit:** a comment in `conversationApi.ts` explains why resending pending messages before the `resumed` refetch is safe.
  - **TL nit:** the "⋯" button is now a white disc with a shadow and full-contrast text colour (still hidden until hover/focus with a mouse).
  - **Request 7 (approved):** `apps/web/index.html` viewport meta gains `interactive-widget=resizes-content`. Screenshots retaken: the composer still sits right above the (simulated) keyboard and overflow is 0 px at 320/375/1280.
- **2026-10-06, follow-up (branch `wp/t7-fe-followup`, after PR #28 merged; `origin/wp/0.8a-platform-hygiene` merged in for `EMAIL_UNVERIFIED` and `Badge max`):**
  - **403 handling:** `lib/access.ts` `chatDenial()`. `EMAIL_UNVERIFIED` (or `FORBIDDEN` for a user known to be unverified) shows "Verifica tu correo para usar el chat"; any other 403 shows a generic "No tienes acceso al chat". Applied to the room list, the history and the ticket (new socket status `unverified`); close 4003 uses the in-memory `emailVerified`. Fixtures answer `EMAIL_UNVERIFIED` by default, with a `forbiddenCode` switch for the generic case. Request 3 is resolved.
  - **`room_preview` frames** (PR #30) replace a room's preview and `lastMessageAt` (or clear them), re-sorting the list. Server previews carry `senderUserId`, so "Tú:" now works straight from `GET /chat/rooms`. Requests 1 and 2 are resolved.
  - **Room badge:** `Badge max={999}`. A capped count of 999 means "999 or more", so it is rendered as "999+" (screen reader: "999 o más mensajes sin leer").
  - **Fixtures:** `ME` is now "Prima Morales", matching `makeUser()`. The screenshots only show invented names ("Inés Navarro Soto", …), so they were not retaken.

