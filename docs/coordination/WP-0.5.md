# WP-0.5 packages/emails
Owner: Frontend + UI/UX · Reviewers: TL · Branch: wp/0.5-emails · PR: # (not opened; orchestrator to open)

## Scope
- New workspace package `@cuencada/emails` (`packages/emails`): ESM, TS strict, built by `tsc` to `dist/` with `module`/`moduleResolution: NodeNext` and `.js` import specifiers, so `apps/server` (NodeNext) can import it directly. React 19 (same major as `apps/web`), the individual `@react-email/*` component packages (body, button, container, head, heading, hr, html, img, preview, section, text) plus a single `@react-email/render` 2.1.0 — all older than the 7-day `minimumReleaseAge`.
- Five Spanish templates sharing one layout (`EmailLayout`): single column ≤ 600px, green header with gold wordmark, white card, one bulletproof button (white on green with a gold border; 2px border + 12px padding + 24px line height = 52px tall, MSO padding hacks from React Email), a copy-paste fallback link under the button, muted small print, optional red warning box, footer "CUENCADA · Portal familiar" + "Si no esperabas este correo, puedes ignorarlo." (password-changed uses "Si no reconoces este cambio, escríbenos a {supportContact} de inmediato." instead)
  - `InviteEmail` — `{ inviterName, inviteeName?, eventTitle?, acceptUrl, expiresAt }` (`eventTitle`, e.g. "Cuencada 2027 · Mérida", adds "Ya estamos preparando la próxima reunión: …" to the body)
  - `MagicLinkEmail` — `{ displayName, loginUrl, expiresInMinutes }`
  - `PasswordResetEmail` — `{ displayName, resetUrl, expiresInMinutes }`
  - `PasswordChangedEmail` — `{ displayName, changedAt, supportContact }` (no button; "Si no fuiste tú…" warning)
  - `VerifyEmail` — `{ displayName, verifyUrl, expiresInMinutes }`
- Plain-text alternative generated from the same content object as the HTML, so they never drift.
- 39 Vitest tests (`packages/emails/src/render.test.tsx`), run by the root `vitest.config.ts` project `emails` (root `pnpm test`; `pnpm --filter @cuencada/emails test` runs only that project).
- Screenshots at 375px: `docs/ux/screenshots/emails/*.webp`.
- `biome.json`: ignore `packages/*/dist`.

## Interfaces exposed

```ts
import { renderEmail, EmailKind, EmailRenderError } from "@cuencada/emails";

renderEmail(template: EmailTemplate, options?: EmailRenderOptions): Promise<RenderedEmail>

type EmailTemplate =
  | { kind: "invite"; props: InviteEmailProps }
  | { kind: "magic-link"; props: MagicLinkEmailProps }
  | { kind: "password-reset"; props: PasswordResetEmailProps }
  | { kind: "password-changed"; props: PasswordChangedEmailProps }
  | { kind: "verify-email"; props: VerifyEmailProps };

interface EmailRenderOptions {
  allowInsecureLinks?: boolean; // permits http://localhost|127.0.0.1|[::1] only
  timeZone?: string;            // default "America/Merida"
  locale?: string;              // default "es-MX"
  logoUrl?: string;             // absolute https logo; omitted = text wordmark
}

interface RenderedEmail { subject: string; html: string; text: string }
```

| kind | Subject |
|---|---|
| `invite` | `{inviterName} te invitó al portal de la Cuencada` |
| `magic-link` | `Tu enlace para entrar a la Cuencada` |
| `password-reset` | `Restablece tu contraseña de la Cuencada` |
| `password-changed` | `Tu contraseña de la Cuencada cambió` |
| `verify-email` | `Confirma tu correo para la Cuencada` |

`EmailKind` is an `as const` object with these kinds. `expiresAt` / `changedAt` accept a `Date` or an ISO string. `expiresInMinutes` must be an integer from 1 to 43 200 and is printed as "15 minutos", "1 hora" or "1 día".

Errors: `EmailRenderError { code, field, message }`, with codes `INVALID_URL | INSECURE_URL | INVALID_DATE | INVALID_DURATION | INVALID_OPTION`. The message and `toJSON()` **never include the offending value**, because URLs carry single-use tokens. That makes the error safe to log with Pino.

Also exported: the React components (for previews), `build*Content` (pure copy builders), `renderPlainText`, the copy constants `CTA_FALLBACK_LABEL`, `FOOTER_BRAND` and `FOOTER_IGNORE`, the `EmailBlock` type, and the helpers `assertSafeUrl`, `cleanName`, `formatDateTime`, `formatDuration`, `endSentence` and `resolveOptions`.

## How WP-0.4 / T1 calls it (server Mailer)

1. Add `"@cuencada/emails": "workspace:*"` to `apps/server` dependencies. Turbo's `^build` builds it first.
2. Build the link on the server from `APP_BASE_URL` with the raw token in the **fragment**, never in the path or query:
   ```ts
   const acceptUrl = new URL("/invitacion", config.APP_BASE_URL);
   acceptUrl.hash = `t=${rawToken}`; // rawToken is never stored; only hashToken(rawToken) is
   ```
   Paths: `/invitacion#t=…`, `/entrar/enlace#t=…`, `/restablecer#t=…`, and `/verificar#t=…` for verify-email (confirmed; WP-0.6 adds the SPA route).
3. Mailer sketch (`apps/server/src/lib/mailer.ts`):
   ```ts
   import { renderEmail, type EmailTemplate } from "@cuencada/emails";

   export interface Mailer { send(to: string, template: EmailTemplate): Promise<void> }

   export function createResendMailer(resend: Resend, from: string, isDev: boolean): Mailer {
     return {
       async send(to, template) {
         const { subject, html, text } = await renderEmail(template, { allowInsecureLinks: isDev });
         await resend.emails.send({ from, to, subject, html, text });
       },
     };
   }
   ```
   The fake Mailer from WP-0.1 can call `renderEmail` too and record `{ to, kind, subject, text }`. Tests can then pull the URL out of `text`: it is the line after `"<CTA label>:"`, and it appears exactly once in the text. In the HTML it appears twice: the button `href` and the visible fallback.
4. Set `allowInsecureLinks` only when `NODE_ENV !== "production"`. In production a non-https `APP_BASE_URL` makes `renderEmail` throw, which is intended. Catch the error, log `err.toJSON()` and still answer the request generically, so nothing leaks about whether the account exists.
5. Pass only display names. Never put another person's email address in the props. `inviterName` is the inviter's `displayName`. `supportContact` stays a required prop: the server passes `config.SUPPORT_EMAIL`, a new setting that WP-0.4 adds with the default `admin@cuencada.com`. `eventTitle` is optional; pass the upcoming Cuencada's title when there is one.
6. Names are cleaned (control characters and CR/LF stripped, whitespace collapsed, capped at 80 characters), so a display name cannot inject header lines through the subject. React escapes the HTML, and there is no `dangerouslySetInnerHTML`; a test enforces that.

## Decisions
- **Fallback link.** Under the button the email shows "¿El botón no funciona? Copia y pega este enlace en tu navegador:" and then the URL as plain text (not a second anchor). Many relatives use older mail clients. The URL text uses `word-break: break-all`, so long tokens wrap at 375px. The URL therefore appears exactly twice in the HTML (once as the button `href`, once as text) and once in the plain-text part. The React Email `<Button>` is the bulletproof, MSO-padded anchor.
- **Formatting** follows what `biome.json` enforces, which is Biome's defaults including trailing commas. `biome check packages/emails` is clean. `packages/types` predates biome formatting, so it looks different; I did not hand-adjust either one.
- **PasswordChanged has no button.** A security notice should not invite one-click actions. It names the support contact as text, not a `mailto:` link.
- **Dates** use `es-MX` in `America/Merida` and read as "lunes 14 de septiembre · 7:40 a.m.". The weekday is lowercase because the date is always mid-sentence. Non-breaking spaces keep the time and TTL together on 375px screens.
- **No external images by default.** The header is a text wordmark (gold `#ffe39a` on green `#0b5e55`, 6.08:1). `logoUrl` is optional and validated like a link. There are no tracking pixels.
- **Colours** are hard-coded from `tokens.css`, because email clients do not support CSS variables. The button is white on green (7.65:1) with a gold border, the body is ink on white, and small print is muted `#60736f` on white (5.02:1).
- **No `email dev` preview server.** The `react-email` CLI pulls in Next.js, which is heavy. Previews can be rendered with `renderEmail` plus a headless browser instead; that is how the screenshots were made.

## WP-0.5.1 hardening (Tech Lead follow-ups)
- **Dependencies.** `@react-email/components` was replaced by the 11 component packages actually used, and exactly one `@react-email/render` (2.1.0) is now installed (`pnpm why` shows 1 version, down from 2).
  - The production dependency closure went from 31 packages / 26.8 MB to 26 packages / 19.1 MB. tailwind, tailwindcss, code-block, prismjs, marked and the duplicate render 2.0.6 are gone.
  - Of what remains, `prettier` (9.7 MB) is a hard dependency of `@react-email/render` itself, even though it is only used when `pretty: true`.
  - ⚠ The individual `@react-email/*` component packages (and `@react-email/components`) are marked *deprecated* on npm: upstream folded them into the `react-email` v6 package, which also bundles the CLI (esbuild, babel, socket.io…). They are pinned to exact versions. The longer-term option is to vendor the ~10 trivial table components and keep only `@react-email/render` (still maintained).
- **Names.** `cleanName` now also drops bidi and invisible characters: U+200B–U+200F, U+202A–U+202E, U+2060–U+2069, U+FEFF, U+00AD and U+3164. Control characters are still replaced with a space.
- **Password-changed footer.** It no longer says "puedes ignorarlo". `EmailContent.footerNote` carries a per-template footer line.
- **Dark mode.**
  - The email declares `<meta name="color-scheme" content="light only">` and `supported-color-schemes`, plus `:root { color-scheme: light only }`.
  - Outlook.com `[data-ogsc]` / `[data-ogsb]` rules restore the brand colours.
  - Every container has an explicit background and a `bgcolor` attribute.
  - **The CTA is now white on green (7.65:1) with a gold border**, a documented email exception to the web "gold primary" rule. Under Chromium's forced dark mode (a stand-in for Gmail, which ignores the opt-out), ink-on-gold became light-on-gold and was unreadable. White-on-green survives both modes.
  - Screenshot: `docs/ux/screenshots/emails/invite-375-forced-dark.webp` (Chromium `--force-dark-mode` + `WebContentsForceDark`, with the light-only opt-out removed to emulate the worst case). With the opt-out in place, Chromium leaves the email light.
- **Tests.** The package is a project (`emails`) in the root `vitest.config.ts`. The package-local config was removed.
- **React keys.** Paragraphs and notes are `EmailBlock { id, text }` with stable per-template ids, not `key={text}`.
- **Fragment name.** `#t=` is canonical. ADR 0001 is updated with a note, and two doc comments in `packages/types/src/auth.ts` were fixed.

## Open questions (→ orchestrator)
None open. The orchestrator's answers:
1. **Verify route:** `/verificar#t=…` is confirmed, and WP-0.6 adds the route.
2. **supportContact:** stays a required prop. The server fills it from `SUPPORT_EMAIL` (default `admin@cuencada.com`), which WP-0.4 adds.
3. **Fallback link:** yes. It is added under the button with `word-break: break-all`, and the test now expects the URL twice in the HTML and once in the text.
4. **Invite context:** `InviteEmail` gains an optional `eventTitle`, shown in the body and cleaned and escaped like the names.

## Review log
