/**
 * Development {@link Mailer}: logs that a message would have been sent.
 * Only `to` and `subject` are logged, never the body, because bodies carry
 * one-time links. Refuses to run in production.
 */
import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { Mailer, MailMessage, MailSendResult } from "./types.js";

/** Logs `{ to, subject }` instead of sending. */
export class DevMailer implements Mailer {
  readonly #log: FastifyBaseLogger;

  /**
   * @param log - Logger to write to.
   * @param nodeEnv - Must not be `production`.
   * @throws Error in production, so a misconfiguration cannot silently drop mail.
   */
  constructor(log: FastifyBaseLogger, nodeEnv: string) {
    if (nodeEnv === "production") throw new Error("DevMailer must not be used in production");
    this.#log = log;
  }

  /** Log the envelope and return a fake id. */
  async send(message: MailMessage): Promise<MailSendResult> {
    const id = `dev-mail-${randomUUID()}`;
    this.#log.info({ mail: { id, to: message.to, subject: message.subject } }, "dev mailer: message not sent");
    return { id };
  }
}
