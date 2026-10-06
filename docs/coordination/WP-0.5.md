# WP-0.5 packages/emails
Owner: Frontend + UI/UX · Reviewers: TL · Branch: wp/0.5-emails · PR: # (not opened; orchestrator to open)

## Scope
- New workspace package `@cuencada/emails` (`packages/emails`): ESM, TS strict, built by `tsc` to `dist/` with `module`/`moduleResolution: NodeNext` and `.js` import specifiers, so `apps/server` (NodeNext) can import it directly. React 19 (same major as `apps/web`), `@react-email/components` 1.0.12, `@react-email/render` 2.1.0 — all older than the 7-day `minimumReleaseAge`.
- Five Spanish templates sharing one layout (`EmailLayout`): single column ≤ 600px, green header with gold wordmark, white card, one gold bulletproof button (14px padding + 24px line height = 48px tall, MSO padding hacks from React Email), muted small print, optional red warning box, footer "CUENCADA · Portal familiar" + "Si no esperabas este correo, puedes ignorarlo."
  - `InviteEmail` — `{ inviterName, inviteeName?, acceptUrl, expiresAt }`
  - `MagicLinkEmail` — `{ displayName, loginUrl, expiresInMinutes }`
  - `PasswordResetEmail` — `{ displayName, resetUrl, expiresInMinutes }`
  - `PasswordChangedEmail` — `{ displayName, changedAt, supportContact }` (no button; "Si no fuiste tú…" warning)
  - `VerifyEmail` — `{ displayName, verifyUrl, expiresInMinutes }`
- Plain-text alternative generated from the same content object as the HTML, so they never drift.
- 30 Vitest tests (`packages/emails/src/render.test.tsx`); standalone `vitest.config.ts`.
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

Also exported: the React components (for previews), `build*Content` (pure copy builders), `renderPlainText`, and the helpers `assertSafeUrl`, `cleanName`, `formatDateTime`, `formatDuration`, `endSentence` and `resolveOptions`.

## How WP-0.4 / T1 calls it (server Mailer)

1. Add `"@cuencada/emails": "workspace:*"` to `apps/server` dependencies. Turbo's `^build` builds it first.
2. Build the link on the server from `APP_BASE_URL` with the raw token in the **fragment**, never in the path or query:
   ```ts
   const acceptUrl = new URL("/invitacion", config.APP_BASE_URL);
   acceptUrl.hash = `t=${rawToken}`; // rawToken is never stored; only hashToken(rawToken) is
   ```
   Paths: `/invitacion#t=…`, `/entrar/enlace#t=…`, `/restablecer#t=…`, and for verify-email `/verificar#t=…` (the route name is still open, see below).
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
   The fake Mailer from WP-0.1 can call `renderEmail` too and record `{ to, kind, subject, text }`. Tests can then pull the URL out of `text`: it is the line after `"<CTA label>:"`, and it appears exactly once.
4. Set `allowInsecureLinks` only when `NODE_ENV !== "production"`. In production a non-https `APP_BASE_URL` makes `renderEmail` throw, which is intended. Catch the error, log `err.toJSON()` and still answer the request generically, so nothing leaks about whether the account exists.
5. Pass only display names. Never put another person's email address in the props. `inviterName` is the inviter's `displayName`. `supportContact` is a configured support address such as `admin@cuencada.com`.
6. Names are cleaned (control characters and CR/LF stripped, whitespace collapsed, capped at 80 characters), so a display name cannot inject header lines through the subject. React escapes the HTML, and there is no `dangerouslySetInnerHTML`; a test enforces that.

## Decisions
- **The CTA URL appears exactly once** in the HTML (the button `href`) and once in the text. There is no visible "copy this link" fallback in the HTML. The React Email `<Button>` is the bulletproof (MSO-padded) anchor, and the text part carries the raw link for clients that cannot show HTML.
- **PasswordChanged has no button.** A security notice should not invite one-click actions. It names the support contact as text, not a `mailto:` link.
- **Dates** use `es-MX` in `America/Merida` and read as "lunes 14 de septiembre · 7:40 a.m.". The weekday is lowercase because the date is always mid-sentence. Non-breaking spaces keep the time and TTL together on 375px screens.
- **No external images by default.** The header is a text wordmark (gold `#ffe39a` on green `#0b5e55`, 6.08:1). `logoUrl` is optional and validated like a link. There are no tracking pixels.
- **Colours** are hard-coded from `tokens.css`, because email clients do not support CSS variables. The button is ink on gold (7.32:1), the body is ink on white, and small print is muted `#60736f` on white (5.02:1).
- **No `email dev` preview server.** The `react-email` CLI pulls in Next.js, which is heavy. Previews can be rendered with `renderEmail` plus a headless browser instead; that is how the screenshots were made.

## Open questions (→ orchestrator)
1. What is the SPA route for email verification? I assumed `/verificar#t=…` in docs and tests; the package itself accepts any https URL.
2. Should `supportContact` be a configured env value (for example `SUPPORT_EMAIL`), or always `admin@cuencada.com`?
3. Do we want a visible copy-paste fallback link under the button? It would make the URL appear twice in the HTML, which conflicts with the "exactly once" acceptance check.
4. Should the invite carry the Cuencada year or event name? It is not in the props yet.

## Review log
