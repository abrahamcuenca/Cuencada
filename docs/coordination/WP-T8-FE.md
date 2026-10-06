# WP-T8-FE Admin console [SEC]
Owner: Frontend · Reviewers: TL, Sec · Branch: wp/t8-fe-admin · PR: # (not opened)

Based on `origin/main` (2bcb7a0) with `origin/wp/t8-be-admin` (PR #24) merged in for the contract types. **Merge after #24.**

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
- **`/admin/invitaciones`:** status filter (`?estado=`), cards with email or "Enlace abierto", status/role badges, expiry, uses, last email send, creator and note. "＋ Invitar" opens the form: rol, "Por correo" or "Enlace para compartir" (disabled for the admin role), correo or usos (≤ 20), días (≤ 30 bound / ≤ 14 open), nota. Revoke goes through an `alertdialog`; resend for pending email-bound invites, with "El enlace anterior ya no funciona".
- **One-time URL:** for copy-link invites the `inviteUrl` is shown in a box with "Este enlace solo se muestra una vez…", a read-only field, "Copiar enlace" (Clipboard API; when blocked, the text is selected and the admin is told to copy by hand), "Compartir por WhatsApp" (`https://wa.me/?text=<message + URL, percent-encoded>`) and "Listo", which drops it.
- **`/admin/usuarios`:** search (name or email, debounced), Rol and Estado filters (`?rol=`, `?estado=`), keyset list. Rows open a sheet (`Dialog`) with badges, último acceso, sesiones activas, alta, and actions: Hacer/Quitar administrador, Cerrar sesiones, Forzar cambio de contraseña, Marcar correo como verificado (when unverified), Deshabilitar/Habilitar cuenta. Every action but verify confirms first with its consequences ("Se cerrarán todas sus sesiones y sus enlaces de correo pendientes dejarán de funcionar…"). Results and errors show in live regions inside the sheet. Links: "Ver su actividad en la bitácora" (`?actor=`) and "Ver en el árbol".
- **`/admin/bitacora`:** filters Acción, Tipo, Desde, Hasta in the URL (`?accion=&tipo=&desde=&hasta=&actor=`); tapping an actor name filters by that actor (removable chip). Cards: actor (current name, "Sistema", or "Cuenta eliminada") · action label, `es-MX` timestamp in `America/Merida`, entity type + id, raw action, IP, and the metadata as a `<dl>`. "Cargar más" pages with the cursor.

## Security notes
- **One-time URL [SEC]:** kept only in `InvitesPage` component state. The create mutation's cached result is `reset()` right after `.unwrap()`, so the token-bearing URL doesn't stay in the Redux store; it's never written to storage, the URL or logs. Leaving the page or "Listo" forgets it. Sharing via `wa.me` puts the link in a WhatsApp URL by design (that's the requested channel); the exposure is bounded by the open-invite limits (≤ 20 uses, ≤ 14 days) and T1-BE's per-token accept rate limit.
- **Audit metadata is never HTML:** every value is turned into a string (`formatMetadataValue`) and rendered as a React text node; no `dangerouslySetInnerHTML` anywhere. Tested with `<img src=x onerror=…>`: the text shows verbatim and no `img`/`[onerror]` element exists.
- **URL filters are validated at the boundary:** `rol`, `estado` (contract enums), `accion` (`auditActionSchema`), `tipo` (`auditEntityTypeSchema`), `actor` (`idSchema`), dates (real calendar dates). Invalid values are ignored, never sent. An inverted range shows an error and makes no request.
- **Guards are UX only.** `RequireAdmin` redirects members from every T8 path before any admin request (tested); the server enforces every rule.
- Emails/IPs shown here are admin-only data from admin endpoints; nothing is logged.

## Decisions
- **Guardrails:** branch on the code. 409 → "Debe quedar al menos un administrador activo."; 403 → the server's Spanish message (covers both the self-change and "Tu cuenta ya no tiene permisos de administración."), with a fallback; 404 / 429 have their own copy.
- **Own row:** "(tú)" in the list; in the sheet the role, sessions, force-reset and disable buttons are disabled with an explanation and a link to `/perfil/sesiones`. "Marcar correo como verificado" stays enabled on self because T8-BE allows it.
- **`emailQueued`:** `true` → success "…le enviamos un correo para elegir una contraseña nueva."; `false` → an info notice that the account must still change its password but no email went out (disabled account or mail budget) and "Avísale por otro medio."
- **Enable has a light confirmation** ("Sus sesiones anteriores siguen cerradas…") so a mis-tap can't re-open a disabled account. Promote also confirms.
- **Invite form delivery:** two modes, "Por correo" (bound, sent, single use) and "Enlace para compartir" (open). The contract's third case, a bound copy-link member invite (`email` + `sendEmail: false`), isn't offered: it loses the "delivered by email ⇒ verified" guarantee and adds a confusing choice. The form validates with the contract schema, so client and server rules can't drift.
- **"Sin verificar correo" card** links to the active users list: `GET /admin/users` has no verified filter; rows carry a "Sin verificar" badge.
- **Dates:** `PORTAL_TIME_ZONE` (`America/Merida`, from T1) for every admin timestamp and for the audit day range (`desde` = local midnight, `hasta` = end of that local day). `zonedMidnight` handles any offset/DST (tested with Europe/Madrid).
- **Cache tags:** `Invite LIST`, `AdminUser LIST` (shared with T6's account picker, so it refreshes too), `AdminUser SUMMARY` for the dashboard, `AuditLog LIST`. Each write invalidates what it changes, plus the audit log. No new tag types.
- **Asistencia** has no index page of its own (it's per edition): the nav row opens Cuencadas, and the dashboard's RSVP card deep-links to the next edition's asistencia. Until T3-FE (#23) merges, that deep link lands on the admin not-found state.

### Changes outside my folders
- `apps/web/src/features/auth/guards.test.tsx` (T1): the "renders /admin/* for an admin" test asserted the old placeholder heading "Panel de la Cuencada". It now renders `/admin/no-existe` and expects the T8 admin not-found heading (no API call needed). One assertion, same intent.

## Verification (2026-10-06)
- `pnpm lint`: biome, 0 diagnostics.
- `pnpm turbo run typecheck --force`: 6/6.
- `pnpm test`: 107 files, 1148 tests passed. T8-FE adds 53: `AdminDashboard.test.tsx` (7), `AdminInvites.test.tsx` (10), `AdminUsers.test.tsx` (10), `AdminAudit.test.tsx` (6), `lib/lib.test.ts` (20).
- `pnpm build`: OK. `pnpm --filter @cuencada/web size`: initial JS **170.66 KB gzip** (budget 190 KB); all T8 code is lazy. Chunks (gzip): AdminLayout 0.9 KB, admin api 0.75 KB, DashboardPage 1.2 KB, AuditLogPage 2.6 KB, UsersPage 3.6 KB, InvitesPage 4.0 KB, admin CSS 1.8 KB.
- **Screenshots** in `docs/ux/screenshots/t8/`: `admin`, `invitaciones` (with a one-time URL), `usuarios` (detail sheet open) and `bitacora` (including the XSS string shown as text), each at 375 and 1280. Headless Chromium against `vite preview` with `/api/**` stubbed with fictional data. Horizontal overflow at 320px: 0 px on all four.

## Requests (→ orchestrator)
- **T6-FE:** `searchUsersForPersonLink` can switch to `GET /admin/users` as it already does; T8-FE's `listAdminUsers` (infinite, same `AdminUser LIST` tag) is available if T6 wants paging. No change required.
- **T8-BE (optional):** an `emailVerified=false` filter on `GET /admin/users` would let the "Sin verificar correo" card open an exact list.
- **T3-FE (#23):** the dashboard links to `/admin/cuencadas/:id/asistencia`; it works once #23 merges.
- **T4-FE (optional):** reading `?cola=reported` on `/admin/media` would let the "Fotos reportadas" card open that tab directly.
- **Coordination board:** please mark T8-FE as in review (README not edited to avoid conflicts).
