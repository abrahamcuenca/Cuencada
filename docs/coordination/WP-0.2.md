# WP-0.2 Shared contracts in packages/types [SEC]
Owner: Software Architect · Reviewers: Tech Lead, Security · Branch: wp/0.2-contracts · PR: #

## Scope
- Every module contract in `packages/types/src/`: `common`, `auth`, `profile`, `cuencadas`, `rsvp`, `media`, `family`, `chat`, `admin`. Each module has zod input schemas, JSDoc'd response interfaces with `satisfies`-checked response schemas, and as-const unions.
- The frozen barrel `src/index.ts`.
- Vitest tests for the non-trivial schemas: password, email, tokens, daily-message parser, upload rules, WS unions, directory PII stripping and RSVP bounds.
- ADR `docs/adr/0001-contracts-and-auth.md`.
- Minimal consumer fixes so `pnpm typecheck` passes: `apps/server/src/modules/cuencadas/data.ts`, `apps/web/src/data/cuencada2026.ts`, `apps/web/src/app/auth.tsx` and `apps/web/src/pages/CuencadaYearPage.tsx` (`time` → `startTime`).

## Interfaces consumed / exposed
**Exposed:** `@cuencada/types`, the contract below. **Consumed:** nothing.

### Conventions every track follows
- All routes are under `/api` except health. Auth levels:
  - **P** = public
  - **U** = logged-in user, after the must-change gate
  - **U\*** = logged-in user, allowed even while `mustChangePassword` is set
  - **A** = admin
  - **C** = refresh cookie + `X-Cuencada-CSRF` header + exact `Origin`
- Register `params`, `querystring`, `body` **and `response`** schemas on every route. Errors use `apiErrorSchema`. Status codes come from `errorHttpStatus`.
- Path params:
  - `:year` uses `yearParamSchema`
  - `:id` uses `idParamSchema`
  - `:id` + `:date` uses `dateParamSchema`
  - every resource id in a path is named `:id` (chat rooms use `roomIdParamSchema`, which is `{ id }`)
- Lists with `cursorQuerySchema` return `Page<T>` (build the schema with `pageSchema(itemSchema)`). Plain arrays are used only where the list is small and bounded.
- `204` responses have no body.
- Every **A** mutation calls `recordAudit(tx, …)` with an `AuditEntityType` and, where one fits, an `AuditAction` (e.g. `cuencada.published` when `isPublished` flips).
- Request typing: `XxxInput = z.infer` (server, parsed) and `XxxRequest = z.input` (client args/forms) are exported for every input schema. Query booleans accept `true`/`false` or `"true"`/`"false"`; numeric query params accept `number | string`.

### Endpoint → schema map

#### Health
| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/health` | P | none | `{ ok, service }` (existing liveness probe) |
| GET | `/health/ready` | P | none | `HealthResponse` (`healthResponseSchema`) |

#### Auth and sessions (T1) [SEC]
| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| POST | `/api/auth/login` | P | `loginInputSchema` | 200 `AuthTokenResponse` + sets refresh cookie |
| POST | `/api/auth/refresh` | C | none | 200 `RefreshResponse` + rotated cookie · 409 `REFRESH_RACE` |
| POST | `/api/auth/logout` | C | none | 204, clears cookie, revokes session |
| GET | `/api/me` | U\* | none | `CurrentUser` (`currentUserSchema`) |
| POST | `/api/auth/change-password` | U\* | `changePasswordInputSchema` | 200 `AuthTokenResponse` (new session; other sessions revoked) |
| POST | `/api/auth/magic-link/request` | P | `magicLinkRequestInputSchema` | 202 `OkResponse` (always) |
| POST | `/api/auth/magic-link/consume` | P | `magicLinkConsumeInputSchema` | 200 `AuthTokenResponse` · 400 `TOKEN_INVALID` |
| POST | `/api/auth/password-reset/request` | P | `passwordResetRequestInputSchema` | 202 `OkResponse` (always) |
| POST | `/api/auth/password-reset/confirm` | P | `passwordResetConfirmInputSchema` | 204 · 400 `TOKEN_INVALID` |
| POST | `/api/auth/email/verify-request` | U | none | 202 `OkResponse` |
| POST | `/api/auth/email/verify` | P | `emailVerifyConfirmInputSchema` | 204 · 400 `TOKEN_INVALID` |
| GET | `/api/auth/sessions` | U | none | `SessionListItem[]` |
| DELETE | `/api/auth/sessions/:id` | U | `idParamSchema` | 204 (own sessions only, otherwise 404) |
| POST | `/api/auth/sessions/revoke-others` | U | none | 204 |
| POST | `/api/invites/inspect` | P | `inviteInspectInputSchema` | `InviteInspectResponse` (`emailMasked` only, via `maskEmail`) · 400 `INVITE_INVALID` |
| POST | `/api/invites/accept` | P | `inviteAcceptInputSchema` | 201 `AuthTokenResponse` · 400 `INVITE_INVALID` (also on bound-email mismatch) · 409 `CONFLICT` (email taken). `emailVerified` true only if the invite was email-bound and sent by email |
| GET | `/api/admin/invites` | A | `adminInviteListQuerySchema` | `Page<AdminInviteListItem>` |
| POST | `/api/admin/invites` | A | `adminInviteCreateInputSchema` | 201 `AdminInviteCreated` (`inviteUrl` is shown once) |
| POST | `/api/admin/invites/:id/revoke` | A | `idParamSchema` | `AdminInviteListItem` |

#### Profile and directory (T5) [SEC]
| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/api/profile/me` | U | none | `OwnProfile` |
| PATCH | `/api/profile/me` | U | `updateProfileInputSchema` | `OwnProfile` |
| POST | `/api/profile/me/avatar/uploads` | U | `avatarUploadInputSchema` | 201 `AvatarUploadResponse` |
| POST | `/api/profile/me/avatar/confirm` | U | `avatarConfirmInputSchema` | `OwnProfile` · 400 `UPLOAD_INVALID` |
| DELETE | `/api/profile/me/avatar` | U | none | `OwnProfile` |
| GET | `/api/directory` | U | `directoryQuerySchema` | `Page<DirectoryEntry>` built with `toDirectoryEntry()`; `q` matches only fields the target made visible |
| GET | `/api/directory/:id` | U | `idParamSchema` (userId) | `DirectoryEntry` |

#### Cuencadas, public and member reads (T2)
| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/api/cuencadas` | P | none | `CuencadaSummary[]` (published only, newest first) |
| GET | `/api/cuencadas/home` | P | none | `CuencadaHome` (includes portal-wide **public** announcements) |
| GET | `/api/cuencadas/:year` | P | `yearParamSchema` | `PublicCuencada` · 404 if missing or draft |
| GET | `/api/cuencadas/:year/members` | U | `yearParamSchema` | `MemberCuencadaDetails` |
| GET | `/api/announcements` | U | `cursorQuerySchema` | `Page<Announcement>` (portal-wide announcements visible to members) |

#### Cuencadas, admin (T2)
| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/api/admin/cuencadas` | A | none | `AdminCuencada[]` (drafts included) |
| POST | `/api/admin/cuencadas` | A | `createCuencadaInputSchema` | 201 `AdminCuencada` · 409 duplicate year |
| GET | `/api/admin/cuencadas/:id` | A | `idParamSchema` | `AdminCuencadaDetail` |
| PATCH | `/api/admin/cuencadas/:id` | A | `updateCuencadaInputSchema` | `AdminCuencada` (publish = `{ isPublished: true }`; replaces the old `PATCH …/publish`) |
| DELETE | `/api/admin/cuencadas/:id` | A | `idParamSchema` | 204 (drafts only, otherwise 409) |
| POST | `/api/admin/cuencadas/:id/itinerary` | A | `createItineraryItemInputSchema` | 201 `ItineraryItem` |
| PUT | `/api/admin/cuencadas/:id/itinerary/order` | A | `reorderInputSchema` | `ItineraryItem[]` |
| PATCH | `/api/admin/itinerary/:id` | A | `updateItineraryItemInputSchema` | `ItineraryItem` |
| DELETE | `/api/admin/itinerary/:id` | A | `idParamSchema` | 204 |
| POST | `/api/admin/cuencadas/:id/locations` | A | `createLocationInputSchema` | 201 `LocationItem` |
| PUT | `/api/admin/cuencadas/:id/locations/order` | A | `reorderInputSchema` | `LocationItem[]` |
| PATCH | `/api/admin/locations/:id` | A | `updateLocationInputSchema` | `LocationItem` |
| DELETE | `/api/admin/locations/:id` | A | `idParamSchema` | 204 |
| GET | `/api/admin/cuencadas/:id/daily-messages` | A | `idParamSchema` | `DailyMessage[]` (by date) |
| PUT | `/api/admin/cuencadas/:id/daily-messages/:date` | A | `dateParamSchema` + `dailyMessageUpsertInputSchema` | `DailyMessage` |
| DELETE | `/api/admin/cuencadas/:id/daily-messages/:date` | A | `dateParamSchema` | 204 |
| POST | `/api/admin/cuencadas/:id/daily-messages/import` | A | `dailyMessagesImportInputSchema` (server runs `parseDailyMessagesText`) | `DailyMessagesImportResult` · 400 `VALIDATION` with `details[].path = "lines.N"`; nothing is written if any line fails |
| GET | `/api/admin/announcements` | A | `adminAnnouncementQuerySchema` | `Announcement[]` |
| POST | `/api/admin/announcements` | A | `createAnnouncementInputSchema` | 201 `Announcement` |
| PATCH | `/api/admin/announcements/:id` | A | `updateAnnouncementInputSchema` | `Announcement` |
| DELETE | `/api/admin/announcements/:id` | A | `idParamSchema` | 204 |

#### RSVP and attendance (T3)
| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/api/cuencadas/:year/rsvp/me` | U | `yearParamSchema` | `MyRsvpResponse` |
| PUT | `/api/cuencadas/:year/rsvp/me` | U | `upsertRsvpInputSchema` | `MyRsvp` · 403 `FORBIDDEN` after the deadline or for past editions |
| GET | `/api/cuencadas/:year/rsvp/summary` | U | `yearParamSchema` | `RsvpSummary` |
| GET | `/api/cuencadas/:year/attendees` | U | `yearParamSchema` | `Attendee[]` |
| GET | `/api/admin/cuencadas/:id/rsvps` | A | `idParamSchema` | `AdminRsvpRow[]` |
| GET | `/api/admin/cuencadas/:id/rsvps.csv` | A | `idParamSchema` | `text/csv` (columns = `AdminRsvpRow` keys; escape cells starting with `= + - @`) |
| GET | `/api/admin/cuencadas/:id/attendance` | A | `idParamSchema` | `AttendanceRecord[]` |
| POST | `/api/admin/cuencadas/:id/attendance` | A | `adminAttendanceBulkInputSchema` | `AttendanceRecord[]` |

#### Media (T4) [SEC]
| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/api/cuencadas/:year/media` | U | `mediaListQuerySchema` | `Page<MediaItem>` (`ready` + `approved` only, plus the caller's own non-ready items) |
| POST | `/api/cuencadas/:year/media/uploads` | U | `createUploadInputSchema` | 201 `CreateUploadResponse` · 400 `UPLOAD_INVALID` |
| POST | `/api/media/:id/confirm` | U (uploader) | `confirmUploadInputSchema` (no body or `{}`) | `MediaItem` (`processing`) · 400 `UPLOAD_INVALID` |
| GET | `/api/media/:id` | U | `idParamSchema` | `MediaItem` |
| PATCH | `/api/media/:id` | U (uploader) / A | `updateMediaInputSchema` | `MediaItem` |
| DELETE | `/api/media/:id` | U (uploader) / A | `idParamSchema` | 204 (soft delete) |
| POST | `/api/media/:id/report` | U | `reportMediaInputSchema` | 204 · 409 if already reported by the caller |
| GET | `/api/admin/media` | A | `adminMediaQuerySchema` | `Page<AdminMediaItem>` |
| GET | `/api/admin/media/:id/reports` | A | `idParamSchema` | `MediaReport[]` |
| POST | `/api/admin/media/:id/moderate` | A | `moderateMediaInputSchema` | `AdminMediaItem` |

#### Family tree (T6) [SEC]
| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/api/family/tree` | U | `familyTreeQuerySchema` | `FamilyTreeView` · 404 if the caller has no linked person and no `personId` |
| GET | `/api/family/people` | U | `peopleQuerySchema` | `Page<PersonSummary>` |
| GET | `/api/family/people/:id` | U | `idParamSchema` | `Person` |
| PATCH | `/api/family/me` | U | `selfEditPersonInputSchema` | `Person` · 404 if not linked |
| POST | `/api/admin/people` | A | `createPersonInputSchema` | 201 `Person` |
| PATCH | `/api/admin/people/:id` | A | `updatePersonInputSchema` | `Person` · 409 if `userId` is already linked |
| DELETE | `/api/admin/people/:id` | A | `idParamSchema` | 204 (cascades relationships) |
| POST | `/api/admin/relationships` | A | `createRelationshipInputSchema` | 201 `Relationship` · 409 on a cycle or duplicate |
| DELETE | `/api/admin/relationships/:id` | A | `idParamSchema` | 204 |

#### Chat (T7)
| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/api/chat/rooms` | U | none | `ChatRoom[]` |
| GET | `/api/chat/rooms/:id/messages` | U | `roomIdParamSchema` + `chatHistoryQuerySchema` | `ChatHistoryPage` |
| POST | `/api/chat/rooms/:id/read` | U | `roomIdParamSchema` + `markReadInputSchema` | 204 |
| POST | `/api/chat/ticket` | U | none | 201 `ChatTicketResponse` |
| GET (upgrade) | `/api/chat/ws?ticket=…` | ticket | `chatWsQuerySchema`; frames `wsClientMessageSchema` | frames `wsServerMessageSchema`; close codes `WsCloseCode` |
| DELETE | `/api/chat/messages/:id` | U (sender) / A | `idParamSchema` | 204, broadcasts `message_deleted` |

#### Admin console (T8)
| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/api/admin/users` | A | `adminUserListQuerySchema` | `Page<AdminUserListItem>` |
| PATCH | `/api/admin/users/:id` | A | `adminUserPatchInputSchema` | `AdminUserListItem` (disabling revokes sessions; the last admin is protected) |
| POST | `/api/admin/users/:id/revoke-sessions` | A | `idParamSchema` | 204 |
| GET | `/api/admin/audit-logs` | A | `auditLogQuerySchema` | `Page<AuditLogEntry>` |

### WebSocket protocol (T7)
- **Client → server:**
  - `send {roomId, body ≤2000, clientMessageId}`
  - `typing {roomId}`
  - `read {roomId, messageId}`
  - `ping {ts?}`
- **Server → client:**
  - `message {message, clientMessageId|null}`
  - `message_deleted {roomId, messageId}`
  - `typing {roomId, userId, displayName}`
  - `presence {onlineUserIds}`
  - `error {code, message, clientMessageId|null}`
  - `pong {ts|null}`
- Limits:
  - frames are limited to `WS_MAX_FRAME_BYTES`, checked before parsing
  - the server pings every `WS_PING_INTERVAL_MS`
  - the sender is always taken from the socket's session, never from the frame (unknown keys are stripped)
  - `clientMessageId` is a uuid both ways (`null` in echoes to other recipients)
  - the ticket is bound to the issuing session; the global room comes from the seed, and a Cuencada room is auto-created on first publish

## Decisions
1. **Response schemas exist for every model.** Each one uses `satisfies z.ZodType<Interface>`, so the type provider can strip unknown keys. This is what makes "response schemas as PII guard" possible.
2. **`DirectoryEntry` hidden contact fields are absent, not `null`** (`exactOptional`).
3. **`ItineraryItem.time` is replaced** by `startTime`/`endTime` (24h `HH:MM`). New fields: `locationId`, `priceNote` and `sortOrder`.
4. **`LocationItem.kind`** changes from `map` to `attraction`. New fields: `mapsUrl`, `lat`/`lng`, `description`, `visibility` and `sortOrder`.
5. **`PublicCuencada` gains** `timezone`, `songUrl`, `weatherWidgetUrl`, `rsvpDeadline`, `publicAnnouncements` and `todayMessage`. The daily message is embedded, so the offline PWA cache has it and no separate endpoint is needed.
6. **`whatsappUrl` is member-only** (in `MemberCuencadaDetails` and `AdminCuencada`). The legacy page made it public, but the WhatsApp group invite link is effectively a credential to join the family group. The hardcoded entry was removed from `apps/web/src/data/cuencada2026.ts`. **Cutover blocker (owner, WP-2.4/2.5):** the link is still in `HomePage.tsx`, legacy `index.html` and git history, as are the OneDrive upload links; reset the WhatsApp invite link and regenerate the OneDrive share links at launch and never commit the new values.
7. **Publishing goes through** `PATCH /api/admin/cuencadas/:id` with `{ isPublished }`. The scaffold's `PATCH …/publish` is retired.
8. **Daily messages belong to a Cuencada** (`cuencada_id`). They are upserted by `(cuencadaId, date)`. Import is all-or-nothing, and a duplicate date in one file is an error.
9. **Attendance is keyed by `personId`**, not `userId`, so historical attendees without accounts can be recorded. `Attendee` unions RSVPs (`yes`/`maybe`) with attendance.
10. **Avatar uploads use their own `AvatarUploadResponse`** with `uploadId`, image types only and a 10 MB limit. They are not gallery `MediaItem`s.
11. **Chat history uses `nextBefore`** (an opaque keyset cursor), not `Page<T>`. Messages are oldest → newest within a page.
12. **The chat ticket is in the WS query string.** This is the only token in a URL (see ADR 0001). It must be redacted from app logs, and WP-2.4 must strip the query from reverse-proxy access logs for `/api/chat/ws`.
13. **Change-password returns a new `AuthTokenResponse`.** It rotates the session and revokes the others. Password-reset confirm returns 204, and the user then logs in.
14. **Invite rules.** Admin invites must be email-bound, single-use and **sent by email** (no copy-link). Open invites are member-only, with at most 20 uses and 14 days. Inspect returns `emailMasked` only.
15. **Additions to `ErrorCode`** beyond the brief: `INVALID_CREDENTIALS`, `TOKEN_INVALID`, `CSRF_FAILED`, `PAYLOAD_TOO_LARGE` and `SERVICE_UNAVAILABLE`.
16. **`packages/types` now compiles with `NodeNext`** and has `exports` conditions (`types`, `import`). Tests are excluded from the build. `typecheck` uses `tsconfig.test.json`, so tests are type-checked too.
17. **`heroImageUrl` and `songUrl` use `assetUrlSchema`:** an `https:` URL, or a site path under `/images/` or `/canciones/` (`..` and `//` are rejected). This lets the legacy `/canciones/Cancion_Oficial.mp3` keep working. Every other admin link is `https:` only.
18. **Lint fix in `biome.json`:** `packages/*/dist` is now ignored. The built `dist/` was being linted.
19. **Media allowlist (orchestrator decision):** `image/heic` removed (iOS Safari converts to JPEG; sharp can't decode HEIC), `video/quicktime` added (300 MB, no transcoding; video `thumbUrl` may be `null`). Avatars: JPEG/PNG/WebP.
20. **Links are canonicalized:** `httpsUrlSchema` requires a literal `https://`, rejects userinfo and single-label hosts, and outputs `URL.href` (store that). It is input-only (it has a transform).
21. **Anti-spoofing text:** display names, full names, nicknames and file names are NFC-normalized and reject U+202A–202E, U+2066–2069, U+200B–200F, U+2028/2029 and U+FEFF (`displayTextSchema`). Chat bodies strip those characters instead (ZWJ is kept so emoji sequences work) and must still contain a visible character.
22. **`timezoneSchema` is checked with `Intl.DateTimeFormat`**, so unknown zones are rejected.
23. **Partial updates:** a location patch must send `lat` and `lng` together. Services must re-validate the merged row for ranges (`endsAt > startsAt`, `endTime > startTime`, lat/lng pairing, `deathYear >= birthYear`).
24. **`parseDailyMessagesText` caps `errors` at `API_ERROR_DETAILS_MAX` (100):** past the cap it keeps 99 and adds a `{ path: "lines" }` summary. `errorCount` holds the real total.
25. **Package:** `exports` gains a `default` condition; `apps/server` zod is bumped to `^4.6.5` (single zod instance); `lib` includes `DOM` for the global `URL` type.

## Open questions (→ orchestrator)
- **WP-0.3 schema requests that these contracts imply** (the second block was added after the TL review):
  - `cuencadas.external_album_url` (legacy OneDrive link)
  - `itinerary.location_id` and `sort_order`
  - `locations.description`, `maps_url`, `lat`, `lng`, `visibility`
  - `announcements.pinned` and `updated_at`
  - `daily_messages(cuencada_id, date)` unique
  - `people.nickname`, `family_branch`, `birth_year`, `death_year`, `deceased`
  - `invites.person_id` and `note`
  - `users.email_verified_at`
  - `sessions.last_used_at`
  - `media_reports` table with a unique `(media_id, reporter_user_id)`
  - `profiles.show_city`
- **WP-0.3, additions from the TL review:**
  - `cuencada_rsvps.arrival_date` (date), `departure_date` (date), `hotel_location_id` (FK → `cuencada_locations`, `ON DELETE SET NULL`)
  - `media_items.moderated_at`, `moderated_by_user_id` (FK → users), `moderation_note`, `duration_seconds`
  - `media_items.moderation_status`: values `pending_review | approved | hidden` (CHECK), default `approved`, replacing today's `'pending'` default
  - `media_items.mime_type` CHECK: the `MediaMimeType` values (no HEIC; includes `video/quicktime`)
  - already in the 0.3 scope from the plan: `media_items.deleted_at`, `upload_status`, `thumb_key`/`display_key`, width/height
  - pending avatar uploads: an `avatar_uploads` table (`id` = `uploadId`, `user_id`, `object_key`, `mime_type`, `byte_size`, `expires_at`, `confirmed_at`), or a `purpose` column on a shared uploads table; plus `profiles.avatar_key` replacing `profiles.photo_url` (URLs are presigned per response)
  - drop `cuencadas.status`: it is computed, never stored
  - data migrations: `cuencada_locations.kind` `'map'` → `'attraction'`; `cuencada_itinerary_items.item_date timestamptz` → `date date` (converted in `America/Merida`), `item_time` → `start_time`; `display_order` → `sort_order` on items and locations
- **Email verification for copy-link invites:** members who accept a copy-link invite have `emailVerified: false`. Security suggests requiring verification before the directory and family tree. That needs a T1/T5 decision, because the guard would need an `emailVerified` check.
- **Approval-first moderation flag:** when it is on, new uploads start as `pending_review`. Where does the flag live (config or DB)? T4 needs an answer.

## Review log
- 2026-10-06: PR #2 review round 1. Security and TL requested changes.
  - **Blocking, fixed:**
    - S1: `emailMasked`; admin invites must be sent by email; `emailVerified` rule documented
    - S2: WhatsApp entry removed from the public data
    - T1: the WP-0.3 column list is completed
    - T2: parser errors are capped at 100 with a summary
  - **Non-blocking, fixed:**
    - Intl timezone check
    - `XxxRequest = z.input` types
    - query booleans accept booleans
    - HEIC → QuickTime
    - lat/lng pairing and the merged-row note
    - `toDirectoryEntry`
    - optional confirm body
    - `roomIdParamSchema` / `:id`
    - portal-wide public announcements in `CuencadaHome`
    - chat ticket uses `opaqueTokenSchema`
    - uuid `clientMessageId`
    - `AuditAction` (incl. `cuencada.published`)
    - `default` export condition and server zod bump
    - canonical https URLs
    - bidi/invisible character rules
    - open-invite caps
    - the missing tests (104 total)
  - **Deliberately not changed:**
    - `AuditLogEntry.entityType` stays a free string for legacy rows
    - non-uuid ids in the two temporary data files (they are deleted in T2)
- 2026-10-06: Architect implemented the WP. `pnpm lint`, `pnpm typecheck` and `pnpm vitest run packages/types` (56 tests) pass.
