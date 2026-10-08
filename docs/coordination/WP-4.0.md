# WP-4.0 Family contracts + migration 0004 [SEC]
Owner: Software Architect · Reviewers: TL, Security · Branch: wp/4.0-family-contracts · PR: # (not opened)

Based on `origin/main` (bcaa262). Plan: WP-4 "Family tree people, invite linking, photos with crop, directory contacts". This WP is the schema owner for 0004 and adds **no routes or UI**; WP-4.1–4.4 build on it.

## Scope
- **Migration `0004_family_people_contacts`** (expand-only), Drizzle schema (`db/schema/people.ts`, `profiles.ts`), `meta/0004_snapshot.json`, journal. `drizzle-kit generate`: "No schema changes".
  - `people`: `birth_date date`, `death_date date`, `birthplace text` (≤ 120), `bio text` (≤ 1000), `photo_key text`, `photo_updated_at timestamptz`, `updated_by_user_id uuid` → users `ON DELETE SET NULL` (+ index). CHECKs `people_birth_date_year_check`, `people_death_date_year_check`, `people_dates_order_check`, `people_birthplace_length_check`, `people_bio_length_check`, `people_photo_check` (`photo_key` ⇒ `photo_updated_at`).
  - `person_photo_uploads` (new): mirrors `avatar_uploads` (object key unique, MIME and size CHECKs from the avatar contract, `expires_at`, `confirmed_at`), keyed by `person_id` → people `CASCADE`, plus `uploaded_by_user_id` → users `SET NULL`. Indexes on both FKs.
  - `person_revisions` (new): `id`, `person_id` → people `SET NULL`, `relationship_id` (no FK), `actor_user_id` → users `SET NULL`, `action` (CHECK: `person.create|update|delete`, `relationship.create|delete`, `person.photo`, `person.revert`), `before`/`after` jsonb (CHECK: object or null), `reverted_by_revision_id` → person_revisions `SET NULL` (CHECK: not itself), `created_at`. Indexes `(person_id, created_at desc)`, `(created_at)`, `(actor_user_id)`, partial `(reverted_by_revision_id)`. `COMMENT ON TABLE`: PII, admin-only, 1-year retention by a cleanup job.
  - `profiles`: `whatsapp` (E.164 CHECK), `instagram`, `facebook`, `tiktok`, `linkedin`, `github` (handle CHECKs), `website` (`^https://`, ≤ 200), `contact_visibility jsonb not null default '{}'` (CHECK: object, only the seven stored keys, boolean values). `profiles.phone` is **not** rewritten.
- **Contracts** (`packages/types`):
  - New `src/contacts.ts`, re-exported from `profile.ts` (the barrel is frozen): `ContactKind`, `CONTACT_LABELS`, `CONTACT_HANDLE_RULES`, `E164_PATTERN`, `isValidHandle`, `isE164`, `normalizePhoneE164`, `e164PhoneSchema`, `handleInputSchema(network)`, `contactWebsiteSchema`, `ContactVisibility` + schema, `STORED_CONTACT_VISIBILITY_KEYS`, `toContactVisibility`, `contactVisibilityInputSchema`, `OwnContacts` + schema, `updateContactsInputSchema`, `ContactItem`/`ContactCard` + schemas, `ContactSource`, `buildContactCard`.
  - `profile.ts`: `OwnProfile.contacts?`, `DirectoryEntry.contacts?` (both optional), `ImageCropRect`/`imageCropRectSchema`, `IMAGE_CROP_MAX_PX`, `clampCropRect`.
  - `family.ts`: `FAMILY_TREE_MAX_DEPTH = 4`; `Person` gains optional `birthDate`/`deathDate`/`birthplace`/`bio`; `PersonDetails` + `PersonPhotoSource`; `FamilyIssueCode`; `RelateKind`/`relateToSchema`; `adminCreatePersonInputSchema`, `memberCreatePersonInputSchema`, `adminUpdatePersonInputSchema`, `memberUpdatePersonInputSchema`; `personDatesIssue`; `PersonRevisionAction`, `PersonRevisionSnapshot` (+ variants), `PersonRevision`, `personRevisionsQuerySchema`, `revertPersonRevisionInputSchema`; `personPhotoUploadInputSchema`/`ResponseSchema`/`personPhotoConfirmInputSchema`. `createPersonInputSchema`/`updatePersonInputSchema` are kept, marked `@deprecated`.
  - `auth.ts`: `InviteIssueCode` (`INVITE_PERSON_DECEASED`, `INVITE_PERSON_REQUIRES_BOUND`).
- **Cross-track edits:** `member-routes.test.ts` (T6 clamp test now expects depth 4), `admin.test.ts` (same in the contract). No mapper changes were needed: every new response field is optional.
- **Docs:** ADR 0001 §6, threat model (assets, STRIDE rows, accepted risks A10/A11).

## Why it is expand-only
- New columns are nullable, or NOT NULL with a constant default (`contact_visibility '{}'`): old inserts and updates are unaffected and `ADD COLUMN` is metadata-only.
- New CHECKs constrain only the new columns, which 0003-era code never writes. CHECKs and the FK on the existing tables are added `NOT VALID` and then validated in the same transaction, like 0002/0003. New tables are empty, so their constraints are created valid.
- Nothing is dropped, renamed or narrowed. No data step.

## Decisions
- **Date ↔ year rule: the year follows the date.** `birth_year`/`death_year` stay (ancestors often have only a year). A full date requires its year and must fall in it (DB CHECK, equality only). The **contract** fills a missing year from the date and rejects a mismatch; a death year/date without `deceased` sets `deceased: true` (or rejects an explicit `false`). The DB's existing year-range and death ⇒ deceased CHECKs therefore cover dates too. A PATCH can still conflict with *stored* values (e.g. a new `birthYear` vs a stored `birth_date`): the server merges and calls `personDatesIssue()` for a Spanish 400 on the right field instead of a 500 from the CHECK. Dates are 1800–2200, like years.
- **`show_*` vs `contact_visibility`: keep the columns as the source of truth** for email, phone and city; `contact_visibility` stores only the seven new kinds (its CHECK rejects `email`/`phone` keys). The read model `ContactVisibility` has all nine keys (`toContactVisibility(showEmail, showPhone, stored)`), and the write model `contactVisibilityInputSchema` accepts all nine: the server maps `email`/`phone` to the columns. No backfill, no dual write, nothing to drop later, and 0003-era code keeps reading the same columns.
- **Crop rect: optional, server-clamped.** `crop: { x, y, size }` in source pixels after EXIF rotation, integers ≥ 0, `size` ≥ 1, each ≤ 30 000, strict object. Only on `personPhotoConfirmInputSchema`; avatars can adopt `imageCropRectSchema` in WP-4.3. The web normally crops client-side (1024² JPEG) and omits it. When present, the server must use `clampCropRect(rect, width, height)` (origin pulled inside, side shrunk to fit, always square ≥ 1) before `extract()`.
- **Handle rules in one constant.** `CONTACT_HANDLE_RULES` regex sources are anchored, ASCII, backslash-free (bracket classes, `(?:…)`), case-sensitive, and valid in both JS and Postgres ARE. The Drizzle schema builds the CHECKs from them; the migration test runs a corpus (lengths, edge dots/hyphens, `javascript:`, `/`, `%2F`, `@`, `?`, `#`, whitespace, newline, Cyrillic, full-width, ZWSP) through both engines and asserts they agree. Inputs only strip whitespace and one leading `@`; a pasted URL is rejected, not parsed.
- **`buildContactCard` lives in `packages/types`** (pure, used by the server; the web can use it in fixtures). It re-validates every stored value and **drops** anything that fails, so a corrupt row never becomes a link. `contactItemSchema.href` additionally only allows `https://…`, `mailto:` and `tel:+digits`. Website display uses `URL.host` (punycode for IDN lookalikes).
- **E.164 normalizer** (`normalizePhoneE164`): separators ignored; `+`/`00` = international; 10 digits = MX local (+52); `52`+10 digits; `521`+10 digits (old mobile prefix, the `1` is dropped, also after `+52`); anything else (e.g. 11 digits without `+`) is ambiguous → `null`. `buildContactCard` normalizes legacy free-form `profiles.phone` on read and drops unreadable ones. `phoneSchema` is unchanged; WP-4.4 switches the input to `e164PhoneSchema` and a later WP backfills.
- **Person fields optional on the wire, required in `PersonDetails`.** Older PWA clients ignore unknown keys; newer clients parse older servers. `Person.avatarUrl` becomes the resolved photo in WP-4.3 (same field, so old clients show tree photos too).
- **New admin/member input schemas instead of extending the old ones.** The current admin routes pick fields explicitly, so extending `createPersonInputSchema` would silently drop dates. The new schemas are strict (unknown keys → 400).
- **Revision snapshots are typed** (`type: person | relationship | photo`) and never contain object keys. Photo revisions are not revertible.
- **Error detail codes**, not new `ErrorCode`s (closed enum; ADR 0001 §4).

## Interfaces for 4.1–4.4

### WP-4.1 Family editing (BE + FE)
- **Inputs:** `adminCreatePersonInputSchema` (`POST /api/admin/family/people`, `relateTo` nullable), `memberCreatePersonInputSchema` (`POST /api/family/people`, `relateTo` required), `adminUpdatePersonInputSchema` / `memberUpdatePersonInputSchema` (`PATCH …/people/:id`), `createRelationshipInputSchema` (existing; members too), `RelateKind` → edge mapping (`parent_of`: new → anchor; `child_of`: anchor → new; `partner_of`). Server merges PATCHes and calls `personDatesIssue()`; the old admin routes either move to the new schemas or merge-check.
- **Read:** `PersonDetails`/`personDetailsSchema` (`GET /api/family/people/:id/details`); fill `Person.birthDate/deathDate/birthplace/bio` in `toPerson` with the privacy rules (living: self, admin, circle; deceased: shown; bio: verified members). `canEdit` from the circle; `isLinked` follows the unlisted rule.
- **Errors:** 403 `FORBIDDEN` + `details[0].code` `FamilyIssueCode.NotInCircle` / `PersonLinkedToOther`.
- **Revisions:** write `person_revisions` (`personRevisions` table) in the same transaction as each change, with `PersonRevisionSnapshot` (`type`-tagged) `before`/`after`; for relationship actions set `relationship_id` and `person_id` = the anchor/new person. Set `people.updated_by_user_id`. Admin routes: `GET /api/admin/family/revisions` (`personRevisionsQuerySchema` → `Page<PersonRevision>`), `POST /api/admin/family/revisions/revert` (`revertPersonRevisionInputSchema`; set `reverted_by_revision_id` on the original, write a `person.revert` row; 409 when already reverted or stale). Retention job: delete rows with `created_at < now() - 1 year` (uses `person_revisions_created_at_idx`).
- **Tree:** `FAMILY_TREE_MAX_DEPTH` is now 4 (already clamped by the existing query schema and `tree.ts`).

### WP-4.2 Invites linked to people (BE + FE)
- Existing `adminInviteCreateInputSchema.personId` (nullable) is the field. Server checks → 400 `VALIDATION` with `details: [{ path: "personId", code }]`: `InviteIssueCode.PersonDeceased`, `InviteIssueCode.PersonRequiresBound` (open/multi-use invite with a person); already linked → 409 `CONFLICT` + `FamilyIssueCode.PersonLinkedToOther`.
- Picker data: `PersonDetails.isLinked`, `deceased`, `birthYear`/`deathYear` (admins see all), or a dedicated admin search; WP-4.2 owns any `AdminInvite` read-model extension ("who it's for").

### WP-4.3 Photos with crop
- Table `person_photo_uploads` (`personPhotoUploads`); columns `people.photo_key`, `photo_updated_at` (`people_photo_check` requires both).
- `personPhotoUploadInputSchema` → `PersonPhotoUploadResponse` (`POST /api/family/people/:id/photo/uploads`), `personPhotoConfirmInputSchema` with optional `crop` → `PersonDetails` (`…/photo/confirm`), delete → `PersonDetails`. `clampCropRect` before `extract()`. Optionally add `crop: imageCropRectSchema.exactOptional()` to `avatarConfirmInputSchema`.
- Precedence: own avatar → tree photo → null; expose via `Person.avatarUrl` (256/64) and `PersonDetails.photoUrl` (512) + `photoSource`. `canEditPhoto`: admin, close relative (parent/child/partner), or the linked person.
- Write a `person.photo` revision (`PersonRevisionPhotoSnapshot`, no keys; not revertible). Reuse the avatar cleanup job for expired pending rows.

### WP-4.4 Directory contacts
- Columns `profiles.whatsapp…website`, `contact_visibility`. Input `updateContactsInputSchema` (`PATCH /api/profile/me/contacts`, or merged into `PATCH /api/profile/me` if WP-4.4 prefers; `visibility.email/phone` → `show_email/show_phone`, the rest merged into the jsonb). Own read: `OwnProfile.contacts` (`OwnContacts`, `toContactVisibility`).
- Directory/tree read: `DirectoryEntry.contacts` and `PersonDetails.contacts` = `buildContactCard(row, toContactVisibility(row.showEmail, row.showPhone, row.contactVisibility))`, only for verified viewers and listed, active accounts. Directory search must keep ignoring contacts.
- `ContactList` renders `href` as-is with `rel="noopener noreferrer nofollow"`; labels from `item.label`.
- Phone input: switch to `e164PhoneSchema`; the E.164 backfill of `profiles.phone` is a later WP (backlog).

## Open questions (→ orchestrator)
- The coordination README still lists only WP-0.3/2.1 as schema owners; 3.1a (0003) and this WP (0004) were schema owners by assignment.
- Backlog: E.164 backfill of `profiles.phone`; `person_revisions` retention job (WP-4.1).

## Verification (2026-10-07)
- `pnpm lint`, `pnpm turbo run typecheck --force` (6/6), `pnpm test` (164 files, 2120 tests) and `pnpm build`: green (see the PR for the post-merge re-run).
- `drizzle-kit generate`: "No schema changes, nothing to migrate".
- Migration test "migration 0004" (4 cases): a seeded 0003 database (user, profile with a free-form phone and `show_*` flags, a linked person, a deceased ancestor, a relationship) is migrated to latest; the old columns of `people` and `profiles` are identical, new columns are null / `{}`, the phone is untouched, and an old-shape insert still works. Date CHECKs (year required and equal, order, death ⇒ deceased, same-day allowed), character-length CHECKs (120/1000, multibyte), photo CHECK. Contact CHECKs agree with `isValidHandle`/`isE164` on a 36-value corpus per network; website and visibility-map CHECKs. Upload MIME/size/unique CHECKs; revision action and snapshot CHECKs, self-revert refused, deleting a revert row unlinks; deleting a user sets `updated_by_user_id`/`uploaded_by_user_id`/`actor_user_id` null; deleting a person cascades uploads and keeps revisions with `person_id` null; the PII table comment is present.
- Contract tests: `contacts.test.ts` (rules, normalizer, inputs, `buildContactCard` with an injection corpus, href schema, response compatibility), `family.test.ts` (date derivation and rules, strictness, member vs admin, read models, revisions, crop clamp, issue codes).

## Review log
