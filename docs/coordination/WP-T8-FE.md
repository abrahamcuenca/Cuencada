# WP-T8-FE Admin console [SEC]
Owner: Frontend · Reviewers: TL, Sec · Branch: wp/t8-fe-admin · PR: # (not opened)

Based on `origin/main` (2bcb7a0) with `origin/wp/t8-be-admin` merged in for the contract types; `origin/main` (885b4e9, includes #23 T3-FE and #24 T8-BE) merged in before finishing.

## Scope
`apps/web/src/features/admin/**`:
- `routes.tsx`: `/admin` is now a layout route (`AdminLayout`) with lazy children: index (dashboard), `invitaciones`, `usuarios`, `bitacora`, `*` (admin not-found). The other tracks' absolute paths (`/admin/cuencadas*`, `/admin/cuencadas/:id/asistencia`, `/admin/media`, `/admin/familia*`) still rank above the `*` child and render without this layout.
- `api.ts`: `getAdminSummary`; invites `listAdminInvites` (infinite), `createAdminInvite`, `revokeAdminInvite`, `resendAdminInvite`; users `listAdminUsers` (infinite), `updateAdminUser`, `revokeAdminUserSessions`, `forceAdminPasswordReset`, `verifyAdminUserEmail`; `listAuditLogs` (infinite). Lists are RTK infinite queries over the keyset cursors ("Cargar más"), 25 per page.
- `components/`: `AdminLayout` + `AdminNav` (section list), `UserSheet`, `InviteForm`, `InviteLinkBox`, `common.tsx` (`ConfirmDialog`, `Notice` live region, `ListFooter`).
- `pages/`: `DashboardPage`, `InvitesPage`, `UsersPage`, `AuditLogPage`, `AdminNotFoundPage`. The old placeholder `AdminPage.tsx` is deleted.
- `lib/`: `labels.ts` (Spanish labels for roles, statuses, every `AuditAction` and `AuditEntityType`), `inviteForm.ts` (validation with the contract `adminInviteCreateInputSchema`), `auditFilters.ts` (URL filters, day range in the portal timezone), `metadata.ts` (text-only formatting), `userErrors.ts` (guardrail messages), `format.ts`, `hooks.ts`.
- `testing/fixtures.ts`: fictional data and contract-validated MSW handlers over an in-memory store.

### Screens
- **`/admin`:** six tappable count cards from `GET /admin/summary` (usuarios activos / deshabilitados / sin verificar correo, invitaciones pendientes, fotos por revisar / reportadas; photo cards are highlighted when non-zero) plus a card for the next Cuencada's RSVPs (sí / quizá / no / acompañantes) that links to `/admin/cuencadas/:id/asistencia`. Section nav: Resumen, Cuencadas, Asistencia (→ `/admin/cuencadas`, it's per edition), Fotos, Personas y árbol, Invitaciones, Usuarios, Bitácora. On phones the list sits under the cards and the other T8 pages show "‹ Administración"; at ≥900px it's a sticky 15rem sidebar on every T8 page. The summary refetches on every visit.
- **`/admin/invitaciones`:** status filter (`?estado=`), cards with email or "Enlace abierto", status/role badges, expiry, uses, last email send, creator and note. "＋ Invitar" opens the form: rol, "Por correo" or "Enlace para compartir" (disabled for the admin role), correo or usos (≤ 20), días (≤ 30 bound / ≤ 14 open), nota. (Superseded by WP-2.3b: open links default to 5 uses / 3 days = 72 h, allow at most 10 uses / 72 h, and show a security note.) Revoke goes through an `alertdialog`; resend for pending email-bound invites, with "El enlace anterior ya no funciona".
- **One-time URL:** for copy-link invites the `inviteUrl` is shown in a box with "Este enlace solo se muestra una vez…", a read-only field, "Copiar enlace" (Clipboard API; when blocked, the text is selected and the admin is told to copy by hand), "Compartir por WhatsApp" (`https://wa.me/?text=<message + URL, percent-encoded>`) and "Listo", which drops it.
- **`/admin/usuarios`:** search (name or email, debounced), Rol and Estado filters (`?rol=`, `?estado=`), keyset list. Rows open a sheet (`Dialog`) with badges, último acceso, sesiones activas, alta, and actions: Hacer/Quitar administrador, Cerrar sesiones, Forzar cambio de contraseña, Marcar correo como verificado (when unverified), Deshabilitar/Habilitar cuenta. Every action but verify confirms first with its consequences ("Se cerrarán todas sus sesiones y sus enlaces de correo pendientes dejarán de funcionar…"). Results and errors show in live regions inside the sheet. Links: "Ver su actividad en la bitácora" (`?actor=`) and "Ver en el árbol".
- **`/admin/bitacora`:** filters Acción, Tipo, Desde, Hasta in the URL (`?accion=&tipo=&desde=&hasta=&actor=`); tapping an actor name filters by that actor (removable chip). Cards: actor (current name, "Sistema", or "Cuenta eliminada") · action label, `es-MX` timestamp in `America/Merida`, entity type + id, raw action, IP, and the metadata as a `<dl>`. "Cargar más" pages with the cursor.

## Security notes
- **One-time URL [SEC]:** kept only in `InvitesPage` component state. The create mutation's cached result is `reset()` right after `.unwrap()`, so the token-bearing URL doesn't stay in the Redux store; it's never written to storage, the URL or logs. Leaving the page or "Listo" forgets it. Sharing via `wa.me` puts the link in a WhatsApp URL by design (that's the requested channel); the exposure is bounded by the open-invite limits (≤ 20 uses, ≤ 14 days) and T1-BE's per-token accept rate limit. (WP-2.3b tightened the open-invite limits to ≤ 10 uses / ≤ 72 h and added an admin alert per acceptance.)
- **Audit metadata is never HTML:** every value is turned into a string (`formatMetadataValue`) and rendered as a React text node; no `dangerouslySetInnerHTML` anywhere. Tested with `<img src=x onerror=…>`: the text shows verbatim and no `img`/`[onerror]` element exists.
- **URL filters are validated at the boundary:** `rol`, `estado` (contract enums), `accion` (`auditActionSchema`), `tipo` (`auditEntityTypeSchema`), `actor` (`idSchema`), dates (real calendar dates). Invalid values are ignored, never sent. An inverted range shows an error and makes no request.
- **Guards are UX only.** `RequireAdmin` redirects members from every T8 path before any admin request (tested); the server enforces every rule.
- Emails/IPs shown here are admin-only data from admin endpoints; nothing is logged.

## Decisions
- **Guardrails:** branch on the code. 409 → "Debe quedar al menos un administrador activo."; 403 → the server's Spanish message (covers both the self-change and "Tu cuenta ya no tiene permisos de administración."), with a fallback; 404 / 429 have their own copy.
- **Own row:** "(tú)" in the list; in the sheet every action (role, sessions, force reset, verify email, disable) is disabled with an explanation and a link to `/perfil/sesiones`. Verify-on-self is disabled too because T8-BE now answers 403 for it (PR #24 review).
- **Admin alerts:** T8-BE emails every other active admin when an administrator account changes. The confirmation for a promotion, and for any change to an admin account except "Cerrar sesiones", adds "Los demás administradores recibirán un aviso por correo."
- **`emailQueued`:** `true` → success "…le enviamos un correo para elegir una contraseña nueva."; `false` → an info notice that the account must still change its password but no email went out (disabled account or mail budget) and "Avísale por otro medio."
- **Enable has a light confirmation** ("Sus sesiones anteriores siguen cerradas…") so a mis-tap can't re-open a disabled account. Promote also confirms.
- **Invite form delivery:** two modes, "Por correo" (bound, sent, single use) and "Enlace para compartir" (open). The contract's third case, a bound copy-link member invite (`email` + `sendEmail: false`), isn't offered: it loses the "delivered by email ⇒ verified" guarantee and adds a confusing choice. The form validates with the contract schema, so client and server rules can't drift.
- **"Sin verificar correo" card** opens `/admin/usuarios?estado=active&correo=sin-verificar` (`emailVerified=false`, WP-0.8b).
- **Dates:** `PORTAL_TIME_ZONE` (`America/Merida`, from T1) for every admin timestamp and for the audit day range (`desde` = local midnight, `hasta` = end of that local day). `zonedMidnight` handles any offset/DST (tested with Europe/Madrid).
- **Cache tags:** `Invite LIST`, `AdminUser LIST` (shared with T6's account picker, so it refreshes too), `AdminUser SUMMARY` for the dashboard, `AuditLog LIST`. Each write invalidates what it changes, plus the audit log. No new tag types.
- **Asistencia** has no index page of its own (it's per edition): the nav row opens Cuencadas, and the dashboard's RSVP card deep-links to the next edition's asistencia (T3-FE, merged in #23).

### Changes outside my folders
- `apps/web/src/features/auth/guards.test.tsx` (T1): the "renders /admin/* for an admin" test asserted the old placeholder heading "Panel de la Cuencada". It now renders `/admin/no-existe` and expects the T8 admin not-found heading (no API call needed). One assertion, same intent.

## Verification (2026-10-06)
- `pnpm lint`: biome, 0 diagnostics.
- `pnpm turbo run typecheck --force`: 6/6.
- `pnpm test` (after merging `origin/main` 885b4e9): 121 files, 1360 tests passed. T8-FE adds 53: `AdminDashboard.test.tsx` (7), `AdminInvites.test.tsx` (10), `AdminUsers.test.tsx` (10), `AdminAudit.test.tsx` (6), `lib/lib.test.ts` (20).
- `pnpm build`: OK. `pnpm --filter @cuencada/web size`: initial JS **170.95 KB gzip** (budget 190 KB); all T8 code is lazy. Chunks (gzip): AdminLayout 0.9 KB, admin api 0.75 KB, DashboardPage 1.2 KB, AuditLogPage 2.6 KB, UsersPage 3.7 KB, InvitesPage 4.0 KB, admin CSS 1.8 KB.
- **Screenshots** in `docs/ux/screenshots/t8/`: `admin`, `invitaciones` (with a one-time URL), `usuarios` (detail sheet open) and `bitacora` (including the XSS string shown as text), each at 375 and 1280. Headless Chromium against `vite preview` with `/api/**` stubbed with fictional data. Horizontal overflow at 320px: 0 px on all four.

## Requests (→ orchestrator)
- **T6-FE:** `searchUsersForPersonLink` can switch to `GET /admin/users` as it already does; T8-FE's `listAdminUsers` (infinite, same `AdminUser LIST` tag) is available if T6 wants paging. No change required.
- **T8-BE (optional):** an `emailVerified=false` filter on `GET /admin/users` would let the "Sin verificar correo" card open an exact list.
- **T4-FE (optional):** reading `?cola=reported` on `/admin/media` would let the "Fotos reportadas" card open that tab directly.
- **Coordination board:** please mark T8-FE as in review (README not edited to avoid conflicts).

## Review log
- 2026-10-06, **WP-0.8c**:
  - [SEC] `createAdminInvite` is dispatched with `{ track: false }`: the one-time URL never enters the Redux store (asserted on the whole state).
  - Copy success adds "El enlace queda en tu portapapeles: pégalo solo en el chat de la familia y, al terminar, copia otra cosa para borrarlo."
  - Bitácora: `adminAlertExempt` / `adminAlertLimitNotice` / `adminAlertSkipped` (literal `true` only) show as badges; entity ids show 8 characters on phones (full id in `title`, visible from 600 px and read by screen readers). "Hasta" is sent as the start of the next local day (exclusive `to`, WP-0.8b).
  - Usuarios: "Correo" filter (`?correo=sin-verificar|verificado` → `emailVerified`), with a client-side check; a 429 on `PATCH` shows the server's message (per-account limit).
  - Dashboard photo cards link to `/admin/media?cola=pending|reported`.
  - Screenshot `t8/bitacora-avisos-{375,1280}`.
