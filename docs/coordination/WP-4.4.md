# WP-4.4 Directory contact information [SEC]
Owner: Senior full-stack engineer + UI/UX · Reviewers: TL, Security · Branch: wp/4.4-contacts

Built on WP-4.0 (contracts and migration 0004). Runs in parallel with WP-4.1 (family editing, owns the tree "Detalles" accordion), WP-4.2 (invites) and WP-4.3 (photos, `AvatarEditor`). This WP does not touch `AvatarEditor`; its profile changes are a new Contacto section.

## Server
- **`PATCH /api/profile/me/contacts`** (`updateContactsInputSchema`, strict). It writes only the caller's row and has no id in the path or body.
  - Phone and WhatsApp are normalized to E.164. Handles drop one leading `@`, and a pasted URL is a 400. The website must be canonical https.
  - `visibility.email`/`visibility.phone` write `show_email`/`show_phone`. The other seven switches are merged into `contact_visibility`, after the stored map is re-read fail-closed (known keys, boolean values only).
  - WhatsApp is stored exactly as sent; the server never infers it from the phone.
  - Audited as `profile.updated` with field names only (`contacts.phone`, `contacts.visibility.instagram`…), never values. Same per-user rate limit as `PATCH /api/profile/me`.
- **`OwnProfile.contacts`**: the raw values plus the nine-key visibility (`toContactVisibility`).
- **`OwnProfile.phoneNeedsConfirmation?: true`** (contract addition in `packages/types/src/profile.ts`): present only when the stored phone is not E.164.
- **`DirectoryEntry.contacts`**: built only with `buildContactCard(row, toContactVisibility(...))`.
  - It exists only for the listed, active rows that the directory queries return, and both routes require a verified email.
  - Hidden fields are absent. The card is `[]` when nothing is shown.
  - Search still ignores every contact.
  - The legacy `email`/`phone` fields are unchanged, for older clients.
- **`loadPersonContactRows` / `personContactCard`** (`modules/family/personContacts.ts`, signatures kept): one query (`users.email` + profile contact columns), ids de-duplicated. As defense in depth, the query also filters to active accounts with `listed_in_directory`, so a disabled or unlisted account always gets an empty card even if a caller forgets to check. WP-4.1 calls these from `PersonDetails`.

## Web
- **"Mi perfil" → Contacto** (`features/profile/components/ContactSection.tsx`, model in `lib/contactForm.ts`): its own form and "Guardar contacto" button, sending only what changed.
  - **Email:** shown read-only, with a switch.
  - **Phone:** a country picker (default +52; a number typed with its own `+lada` wins). The banner "Confirma tu teléfono con la lada de tu país" appears when `phoneNeedsConfirmation` is set.
  - **WhatsApp:** "Usar mi teléfono" (pre-filled from the phone when turned off).
  - **Instagram/Facebook/TikTok/LinkedIn/GitHub:** handles with an inline `@`, a hint per network, and "Escribe solo tu usuario, sin el enlace." for pasted links.
  - **Website:** https, with a soft warning for IP literals and private names.
  - **Switches:** each field has a "Mostrar a la familia" switch, default off. Its accessible name is "Mostrar a la familia (Instagram)" and so on.
- **Main profile form:** phone and the email/phone switches moved out of "Tus datos" into Contacto. On desktop the photo spans both forms.
- **Directorio:**
  - **List:** the card link plus a row of 44 px chips with inline-SVG icons (no icon font, no requests, no `style` attributes).
  - **Detail:** a "Contacto" section listing every visible contact with the server's `display` text, or "No comparte datos de contacto.".
  - **Older servers:** responses without `contacts` keep the old phone/email buttons.

### `ContactList` (for WP-4.1)
`features/directory/components/ContactList.tsx`:

```tsx
<ContactList
  contacts={details.contacts}      // ContactItem[] from the server, rendered in order
  variant="list"                   // "list" (default, full rows) | "chips" (44 px icon-only links)
  ownerName={details.displayName}  // optional; accessible names "WhatsApp de Ana: +52…"
  emptyText="No comparte datos de contacto." // optional; omitted/null renders nothing
  className={styles.x}             // optional
/>
```

- `href` is never built on the client. Each item is re-checked with `contactItemSchema`, which allows only `https://`, `mailto:` and `tel:+digits`; anything else is skipped.
- `https` links open with `target="_blank"` and `rel="noopener noreferrer nofollow"` (`CONTACT_LINK_REL`); `tel:`/`mailto:` open natively.
- Styles live in its own `ContactList.module.css`, so it can be used outside the directory.

## Decisions
- **Legacy free-form phones:**
  - The country is never guessed and nothing is backfilled automatically. The card omits such a phone, as WP-4.0 does.
  - The owner is prompted through `phoneNeedsConfirmation`.
  - In the form, a legacy phone counts as changed, so saving (with the visible +52 or the picked lada) is the confirmation.
- **"Usar mi teléfono":** starts on when WhatsApp equals the phone, or when neither is set yet.
- **`rel`:** the WP-4.0 value `noopener noreferrer nofollow` (a superset of `noopener noreferrer`).
- **E2E helper:** the app scrolls smoothly, so the contacts journey uses an instant-scroll toggle helper. The shared `setControl` can miss controls that are a screen away.

## Tests
- **Server:**
  - `profile/contacts.test.ts`: normalization; merge into the stored map; clearing; WhatsApp never inferred; 12 bodies that must return 400 and write nothing (pasted URL, http/javascript website, ambiguous phone, unknown or mass-assigned keys, empty visibility, empty body); own-row-only; audit and log redaction; 401/403.
  - Also in `profile/contacts.test.ts`: the `phoneNeedsConfirmation` matrix, and the directory card (switches, legacy phone dropped, empty card, unverified viewer gets 403, nothing from unlisted or disabled accounts, an owner PATCH is seen by another member).
  - `family/personContacts.test.ts`.
- **Security:**
  - Route matrix: `PATCH /api/profile/me/contacts`, with an IDOR probe that compares the other member's contact columns before and after, and a mass-assignment probe that must return 400.
  - PII scan: hidden contacts are planted on the hidden member, and all-on contacts on an unlisted and a disabled member; none may appear in any member-facing body. `contactVisibility` is a forbidden key; unverified viewers get 403 with no contacts; the scanner self-test covers the new cases.
  - `docs/security/routes.md` regenerated.
- **Web:**
  - `ContactSection.test.tsx`, `contactForm.test.ts`, `ContactList.test.tsx`, and the contact tests in `DirectoryPage.test.tsx`.
  - Updated `ProfilePage.test.tsx` and `profileForm.test.ts`.
- **E2E** (`tests/e2e/contacts.spec.ts`, phones + desktop): Darío fills in his contacts (a pasted Instagram link gets the Spanish error) and turns on exactly phone, WhatsApp and Instagram. Ana sees exactly those 3 in the list chips and the detail. The `GET /api/directory/:id` JSON has `contacts` kinds `[phone, whatsapp, instagram]` and no trace of the hidden GitHub or website.
- **Screenshots:** `docs/ux/screenshots/t5/{perfil-contacto,directorio-contactos,directorio-detalle-contactos}-{375,1280}.webp`.
