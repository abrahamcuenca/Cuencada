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
  - other ids, such as `:roomId`, use `z.object({ roomId: idSchema })`
- Lists with `cursorQuerySchema` return `Page<T>` (build the schema with `pageSchema(itemSchema)`). Plain arrays are used only where the list is small and bounded.
- `204` responses have no body.
- Every **A** mutation calls `recordAudit(tx, …)` with an `AuditEntityType`.

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
| POST | `/api/invites/inspect` | P | `inviteInspectInputSchema` | `InviteInspectResponse` · 400 `INVITE_INVALID` |
| POST | `/api/invites/accept` | P | `inviteAcceptInputSchema` | 201 `AuthTokenResponse` · 400 `INVITE_INVALID` · 409 `CONFLICT` (email taken) |
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
| GET | `/api/directory` | U | `directoryQuerySchema` | `Page<DirectoryEntry>` |
| GET | `/api/directory/:id` | U | `idParamSchema` (userId) | `DirectoryEntry` |

#### Cuencadas, public and member reads (T2)
| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/api/cuencadas` | P | none | `CuencadaSummary[]` (published only, newest first) |
| GET | `/api/cuencadas/home` | P | none | `CuencadaHome` |
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
| POST | `/api/media/:id/confirm` | U (uploader) | `confirmUploadInputSchema` | `MediaItem` (`processing`) · 400 `UPLOAD_INVALID` |
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
| GET | `/api/chat/rooms/:roomId/messages` | U | `chatHistoryQuerySchema` | `ChatHistoryPage` |
| POST | `/api/chat/rooms/:roomId/read` | U | `markReadInputSchema` | 204 |
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

## Decisions
1. **Response schemas exist for every model.** Each one uses `satisfies z.ZodType<Interface>`, so the type provider can strip unknown keys. This is what makes "response schemas as PII guard" possible.
2. **`DirectoryEntry` hidden contact fields are absent, not `null`** (`exactOptional`).
3. **`ItineraryItem.time` is replaced** by `startTime`/`endTime` (24h `HH:MM`). New fields: `locationId`, `priceNote` and `sortOrder`.
4. **`LocationItem.kind`** changes from `map` to `attraction`. New fields: `mapsUrl`, `lat`/`lng`, `description`, `visibility` and `sortOrder`.
5. **`PublicCuencada` gains** `timezone`, `songUrl`, `weatherWidgetUrl`, `rsvpDeadline`, `publicAnnouncements` and `todayMessage`. The daily message is embedded, so the offline PWA cache has it and no separate endpoint is needed.
6. **`whatsappUrl` is member-only** (in `MemberCuencadaDetails` and `AdminCuencada`). The legacy page made it public, but the WhatsApp group invite link is effectively a credential to join the family group.
7. **Publishing goes through** `PATCH /api/admin/cuencadas/:id` with `{ isPublished }`. The scaffold's `PATCH …/publish` is retired.
8. **Daily messages belong to a Cuencada** (`cuencada_id`). They are upserted by `(cuencadaId, date)`. Import is all-or-nothing, and a duplicate date in one file is an error.
9. **Attendance is keyed by `personId`**, not `userId`, so historical attendees without accounts can be recorded. `Attendee` unions RSVPs (`yes`/`maybe`) with attendance.
10. **Avatar uploads use their own `AvatarUploadResponse`** with `uploadId`, image types only and a 10 MB limit. They are not gallery `MediaItem`s.
11. **Chat history uses `nextBefore`** (an opaque keyset cursor), not `Page<T>`. Messages are oldest → newest within a page.
12. **The chat ticket is in the WS query string.** This is the only token in a URL (see ADR 0001), and it must be redacted from logs.
13. **Change-password returns a new `AuthTokenResponse`.** It rotates the session and revokes the others. Password-reset confirm returns 204, and the user then logs in.
14. **Admin invites must be bound to an email and single-use.** Open invites are member-only.
15. **Additions to `ErrorCode`** beyond the brief: `INVALID_CREDENTIALS`, `TOKEN_INVALID`, `CSRF_FAILED`, `PAYLOAD_TOO_LARGE` and `SERVICE_UNAVAILABLE`.
16. **`packages/types` now compiles with `NodeNext`** and has `exports` conditions (`types`, `import`). Tests are excluded from the build. `typecheck` uses `tsconfig.test.json`, so tests are type-checked too.
17. **`heroImageUrl` and `songUrl` use `assetUrlSchema`:** an `https:` URL, or a site path under `/images/` or `/canciones/` (`..` is rejected). This lets the legacy `/canciones/Cancion_Oficial.mp3` keep working. Every other admin link is `https:` only.
18. **Lint fix in `biome.json`:** `packages/*/dist` is now ignored. The built `dist/` was being linted.

## Open questions (→ orchestrator)
- **WP-0.3 schema requests that these contracts imply:**
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
- **Approval-first moderation flag:** when it is on, new uploads start as `pending_review`. Where does the flag live (config or DB)? T4 needs an answer.

## Review log
- 2026-10-06: Architect implemented the WP. `pnpm lint`, `pnpm typecheck` and `pnpm vitest run packages/types` (56 tests) pass.
