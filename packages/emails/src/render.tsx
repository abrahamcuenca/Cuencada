import { render } from "@react-email/render";
import { EmailLayout } from "./components/EmailLayout.js";
import { type EmailContent, renderPlainText } from "./content.js";
import {
  type EmailRenderOptions,
  type ResolvedEmailOptions,
  resolveOptions,
} from "./format.js";
import {
  type AdminAccountChangedEmailProps,
  buildAdminAccountChangedContent,
} from "./templates/AdminAccountChangedEmail.js";
import {
  type InviteEmailProps,
  buildInviteContent,
} from "./templates/InviteEmail.js";
import {
  type MagicLinkEmailProps,
  buildMagicLinkContent,
} from "./templates/MagicLinkEmail.js";
import {
  type PasswordChangedEmailProps,
  buildPasswordChangedContent,
} from "./templates/PasswordChangedEmail.js";
import {
  type PasswordResetEmailProps,
  buildPasswordResetContent,
} from "./templates/PasswordResetEmail.js";
import {
  type VerifyEmailProps,
  buildVerifyContent,
} from "./templates/VerifyEmail.js";

/** Template identifiers accepted by {@link renderEmail}. */
export const EmailKind = {
  Invite: "invite",
  MagicLink: "magic-link",
  PasswordReset: "password-reset",
  PasswordChanged: "password-changed",
  VerifyEmail: "verify-email",
  AdminAccountChanged: "admin-account-changed",
} as const;

export type EmailKind = (typeof EmailKind)[keyof typeof EmailKind];

/** Discriminated union of every email the portal sends. */
export type EmailTemplate =
  | { kind: typeof EmailKind.Invite; props: InviteEmailProps }
  | { kind: typeof EmailKind.MagicLink; props: MagicLinkEmailProps }
  | { kind: typeof EmailKind.PasswordReset; props: PasswordResetEmailProps }
  | { kind: typeof EmailKind.PasswordChanged; props: PasswordChangedEmailProps }
  | { kind: typeof EmailKind.VerifyEmail; props: VerifyEmailProps }
  | {
      kind: typeof EmailKind.AdminAccountChanged;
      props: AdminAccountChangedEmailProps;
    };

/** A rendered email, ready for the Mailer (Resend `subject`/`html`/`text`). */
export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

function buildContent(
  template: EmailTemplate,
  options: ResolvedEmailOptions,
): EmailContent {
  switch (template.kind) {
    case EmailKind.Invite:
      return buildInviteContent(template.props, options);
    case EmailKind.MagicLink:
      return buildMagicLinkContent(template.props, options);
    case EmailKind.PasswordReset:
      return buildPasswordResetContent(template.props, options);
    case EmailKind.PasswordChanged:
      return buildPasswordChangedContent(template.props, options);
    case EmailKind.VerifyEmail:
      return buildVerifyContent(template.props, options);
    case EmailKind.AdminAccountChanged:
      return buildAdminAccountChangedContent(template.props, options);
    default: {
      // Compile-time exhaustiveness check; reached at runtime only with untyped input.
      // The props are never echoed: they carry single-use tokens.
      const unreachable: never = template;
      void unreachable;
      throw new TypeError("Unknown email template kind.");
    }
  }
}

/**
 * Renders an email to a Spanish subject, an HTML body and a plain-text alternative.
 * Validates every link (`https:` only, unless `allowInsecureLinks` permits `http://localhost`)
 * and every date/TTL before rendering. User-provided strings are escaped by React.
 *
 * @param template - Which email to send and its props.
 * @param options - Formatting and dev options (timezone defaults to `America/Merida`).
 * @throws EmailRenderError when a prop or option is invalid. The error never contains the URL.
 */
export async function renderEmail(
  template: EmailTemplate,
  options?: EmailRenderOptions,
): Promise<RenderedEmail> {
  const resolved = resolveOptions(options);
  const content = buildContent(template, resolved);
  const html = await render(
    <EmailLayout content={content} logoUrl={resolved.logoUrl} />,
    { pretty: false },
  );
  return { subject: content.subject, html, text: renderPlainText(content) };
}
