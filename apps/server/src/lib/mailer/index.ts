/**
 * Mail sending: pick the transport for the environment and render templates
 * from `@cuencada/emails`.
 */
import { type EmailTemplate, renderEmail } from "@cuencada/emails";
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../../config.js";
import { DevMailer } from "./dev.js";
import { ResendMailer } from "./resend.js";
import type { Mailer, MailSendResult } from "./types.js";

export { DevMailer } from "./dev.js";
export { ResendMailer } from "./resend.js";
export type { Mailer, MailMessage, MailSendResult } from "./types.js";

/**
 * Build the mailer for this environment: Resend when `RESEND_API_KEY` and
 * `MAIL_FROM` are set (config makes both mandatory in production), otherwise
 * the {@link DevMailer} (which prints full messages only in development).
 *
 * @param config - Validated config.
 * @param log - Logger for the dev mailer.
 * @throws Error in production without Resend: the dev mailer is never selected there.
 */
export function createMailer(
  config: Pick<AppConfig, "NODE_ENV" | "RESEND_API_KEY" | "MAIL_FROM">,
  log: FastifyBaseLogger
): Mailer {
  if (config.RESEND_API_KEY !== undefined && config.MAIL_FROM !== undefined) {
    return new ResendMailer({ apiKey: config.RESEND_API_KEY, from: config.MAIL_FROM });
  }
  // Belt and braces: config already requires both keys in production, and the
  // DevMailer constructor refuses production too.
  if (config.NODE_ENV === "production") {
    throw new Error("DevMailer must not be used in production: set RESEND_API_KEY and MAIL_FROM");
  }
  return new DevMailer(log, config.NODE_ENV);
}

/** What {@link sendTemplate} needs; the Fastify app (`app`) satisfies it. */
export interface TemplateMailContext {
  mailer: Mailer;
  config: Pick<AppConfig, "NODE_ENV" | "SUPPORT_EMAIL">;
}

/** Options for {@link sendTemplate}. */
export interface SendTemplateOptions {
  /** Derive from the operation (e.g. `magic-link:<rowId>`), never from the token. */
  idempotencyKey?: string;
}

/**
 * Render a `@cuencada/emails` template and send it to one recipient.
 * `Reply-To` is `SUPPORT_EMAIL` and the template kind is sent as a tag.
 * Outside production `http://localhost` links are allowed; in production a
 * non-https link makes rendering throw (by design).
 *
 * Build links with {@link appLink} so the token travels in the URL fragment.
 *
 * @param ctx - `{ mailer, config }`, e.g. the Fastify app.
 * @param to - Recipient address.
 * @param template - Template kind and props.
 * @param options - Idempotency key.
 * @throws EmailRenderError (safe to log via `toJSON()`) or the mailer's error.
 */
export async function sendTemplate(
  ctx: TemplateMailContext,
  to: string,
  template: EmailTemplate,
  options: SendTemplateOptions = {}
): Promise<MailSendResult> {
  const rendered = await renderEmail(template, { allowInsecureLinks: ctx.config.NODE_ENV !== "production" });
  return ctx.mailer.send({
    to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    replyTo: ctx.config.SUPPORT_EMAIL,
    tags: { category: template.kind },
    ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey })
  });
}

/** Canonical SPA paths that consume a one-time token from the fragment. */
export const AppLinkPath = {
  Invite: "/invitacion",
  MagicLink: "/entrar/enlace",
  PasswordReset: "/restablecer",
  VerifyEmail: "/verificar"
} as const;
export type AppLinkPath = (typeof AppLinkPath)[keyof typeof AppLinkPath];

/**
 * Absolute SPA link under `APP_BASE_URL`, with an optional one-time token in
 * the **fragment** (`#t=…`) so it never reaches server logs or `Referer`.
 *
 * @param config - Needs `APP_BASE_URL`.
 * @param path - SPA path, usually an {@link AppLinkPath}.
 * @param token - Raw token (only its hash is stored).
 */
export function appLink(config: Pick<AppConfig, "APP_BASE_URL">, path: string, token?: string): string {
  const url = new URL(path, config.APP_BASE_URL);
  if (token !== undefined) url.hash = `t=${token}`;
  return url.href;
}
