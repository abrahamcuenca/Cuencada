/**
 * Production {@link Mailer} backed by Resend. Bodies (which carry one-time
 * links) are never logged; provider errors are reduced to their code.
 */
import { Resend } from "resend";
import { AppError } from "../errors.js";
import type { Mailer, MailMessage, MailSendResult } from "./types.js";

/** Settings for {@link ResendMailer}. */
export interface ResendMailerOptions {
  apiKey: string;
  /** Sender, e.g. `Cuencada <no-reply@cuencada.com>`. */
  from: string;
}

/** Minimal slice of the Resend SDK this class uses; lets tests inject a stub. */
export type ResendEmailsClient = Pick<Resend["emails"], "send">;

/** Resend tag names/values: ASCII letters, digits, `_` and `-` only. */
const TAG_UNSAFE = /[^A-Za-z0-9_-]/g;

/** Sends transactional mail through the Resend API. */
export class ResendMailer implements Mailer {
  readonly #emails: ResendEmailsClient;
  readonly #from: string;

  /**
   * @param options - API key and sender.
   * @param emails - Optional injected client (tests); defaults to a real Resend client.
   */
  constructor(options: ResendMailerOptions, emails?: ResendEmailsClient) {
    this.#emails = emails ?? new Resend(options.apiKey).emails;
    this.#from = options.from;
  }

  /**
   * Send one message. `idempotencyKey` is passed as Resend's `Idempotency-Key`.
   *
   * @throws AppError `SERVICE_UNAVAILABLE` when Resend rejects the message.
   */
  async send(message: MailMessage): Promise<MailSendResult> {
    const tags = Object.entries(message.tags ?? {}).map(([name, value]) => ({
      name: name.replace(TAG_UNSAFE, "_").slice(0, 256),
      value: value.replace(TAG_UNSAFE, "_").slice(0, 256)
    }));
    const response = await this.#emails.send(
      {
        from: this.#from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
        ...(tags.length === 0 ? {} : { tags })
      },
      message.idempotencyKey === undefined ? undefined : { idempotencyKey: message.idempotencyKey }
    );
    if (response.error !== null) {
      throw new AppError("SERVICE_UNAVAILABLE", undefined, {
        // Only the provider's error class; its message may echo the payload.
        cause: new Error(`Resend rejected the message: ${response.error.name}`)
      });
    }
    return { id: response.data.id };
  }
}
