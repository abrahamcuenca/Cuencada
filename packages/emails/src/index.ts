export {
  EmailLayout,
  type EmailLayoutProps,
} from "./components/EmailLayout.js";
export {
  type EmailContent,
  type EmailCta,
  CTA_FALLBACK_LABEL,
  FOOTER_BRAND,
  FOOTER_IGNORE,
  renderPlainText,
} from "./content.js";
export { EmailRenderError, EmailRenderErrorCode } from "./errors.js";
export {
  assertSafeUrl,
  cleanName,
  endSentence,
  DEFAULT_LOCALE,
  DEFAULT_TIME_ZONE,
  type EmailRenderOptions,
  formatDateTime,
  formatDuration,
  type ResolvedEmailOptions,
  resolveOptions,
} from "./format.js";
export {
  EmailKind,
  type EmailTemplate,
  type RenderedEmail,
  renderEmail,
} from "./render.js";
export {
  buildInviteContent,
  InviteEmail,
  type InviteEmailProps,
} from "./templates/InviteEmail.js";
export {
  buildMagicLinkContent,
  MagicLinkEmail,
  type MagicLinkEmailProps,
} from "./templates/MagicLinkEmail.js";
export {
  buildPasswordChangedContent,
  PasswordChangedEmail,
  type PasswordChangedEmailProps,
} from "./templates/PasswordChangedEmail.js";
export {
  buildPasswordResetContent,
  PasswordResetEmail,
  type PasswordResetEmailProps,
} from "./templates/PasswordResetEmail.js";
export {
  buildVerifyContent,
  VerifyEmail,
  type VerifyEmailProps,
} from "./templates/VerifyEmail.js";
