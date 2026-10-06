/**
 * Transactional email contract. The production implementation (WP-0.4) wraps
 * Resend; tests use `FakeMailer` from `apps/server/test/helpers/fakes.ts`.
 *
 * Message bodies may contain one-time tokens (magic links, invites), so
 * implementations must never log `html` or `text`.
 */

/** A single rendered email ready to send. */
export interface MailMessage {
  /** One recipient address. Send one message per person to avoid leaking addresses. */
  to: string;
  subject: string;
  /** Rendered HTML body (e.g. from packages/emails). */
  html: string;
  /** Plain-text alternative; required for deliverability and accessibility. */
  text: string;
  /** Optional Reply-To address. The From address comes from server config. */
  replyTo?: string;
  /** Optional provider tags for analytics, e.g. `{ category: "magic-link" }`. */
  tags?: Record<string, string>;
  /**
   * Optional idempotency key (Resend `Idempotency-Key`), so a retried send,
   * such as a double-submit or a retry after a timeout, delivers at most once.
   * Derive it from the operation, e.g. `magic-link:<magicLinkId>`, and never
   * from the token itself.
   */
  idempotencyKey?: string;
}

/** Provider acknowledgement for an accepted message. */
export interface MailSendResult {
  /** Provider message id (Resend `id`), useful for audit logs and support. */
  id: string;
}

/** Sends transactional email. Implementations throw on provider rejection. */
export interface Mailer {
  /**
   * Send one message.
   *
   * @param message - The rendered message.
   * @returns The provider's message id once the provider has accepted it.
   */
  send(message: MailMessage): Promise<MailSendResult>;
}
