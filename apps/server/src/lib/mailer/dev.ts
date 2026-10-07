/**
 * Development {@link Mailer}: nothing is sent.
 *
 * - Every message logs a structured `dev.mail` event with `{ id, to, subject,
 *   category }` only, never the body.
 * - Under `NODE_ENV=development` **only**, the whole message (recipient,
 *   subject and the plain-text body, which carries the invite, magic-link,
 *   verify and reset links) is also printed to the terminal as a readable
 *   block, so a local developer can follow the links without a mail server.
 * - Under `NODE_ENV=test` the body is never printed (tests use `FakeMailer`,
 *   e2e uses its file sink).
 * - It refuses to be constructed under `NODE_ENV=production`, and
 *   `createMailer` never selects it there (config makes Resend mandatory).
 *
 * Why a direct stdout write and not the Pino logger for the body [SEC]: the
 * body holds live one-time tokens. A log line is shipped and retained (the
 * log pipeline, Loki), and the dev logger runs through pino-pretty, which
 * would flatten a multi-line body into one escaped JSON string. The terminal
 * block is a deliberate dev-only console channel, not a log record: it never
 * enters the structured log stream, and it is unreachable in production
 * because this class cannot exist there. It is not `console.log`: the writer
 * is injected (tests capture it) and defaults to `process.stdout.write`.
 */
import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { Mailer, MailMessage, MailSendResult } from "./types.js";

/** Structured event name logged for every message the dev mailer swallows. */
export const DEV_MAIL_EVENT = "dev.mail";

/** Writes a chunk of text to the developer's terminal. */
export type DevMailWriter = (chunk: string) => void;

const writeToStdout: DevMailWriter = (chunk) => {
  process.stdout.write(chunk);
};

const RULE = "─".repeat(72);

/**
 * Render a message as a readable terminal block (plain text only, no HTML).
 *
 * @param id - The fake message id.
 * @param message - The message.
 * @returns The block, ending with a newline.
 */
export function formatDevMail(id: string, message: MailMessage): string {
  const category = message.tags?.category;
  return [
    "",
    `┌${RULE}`,
    "│ dev.mail · correo NO enviado (solo desarrollo)",
    `│ Para:      ${message.to}`,
    `│ Asunto:    ${message.subject}`,
    ...(category === undefined ? [] : [`│ Categoría: ${category}`]),
    `│ Id:        ${id}`,
    `├${RULE}`,
    ...message.text.trimEnd().split(/\r?\n/).map((line) => `│ ${line}`),
    `└${RULE}`,
    ""
  ].join("\n");
}

/** Logs that a message would have been sent; prints it in full in development. */
export class DevMailer implements Mailer {
  readonly #log: FastifyBaseLogger;
  readonly #printBodies: boolean;
  readonly #write: DevMailWriter;

  /**
   * @param log - Logger for the `dev.mail` event.
   * @param nodeEnv - Must not be `production`. Bodies are printed only when it is exactly `development`.
   * @param write - Terminal writer; defaults to `process.stdout.write` (tests inject a capture).
   * @throws Error in production, so a misconfiguration cannot silently drop mail.
   */
  constructor(log: FastifyBaseLogger, nodeEnv: string, write: DevMailWriter = writeToStdout) {
    if (nodeEnv === "production") throw new Error("DevMailer must not be used in production");
    this.#log = log;
    this.#printBodies = nodeEnv === "development";
    this.#write = write;
  }

  /** Log the envelope (and, in development, print the message) and return a fake id. */
  async send(message: MailMessage): Promise<MailSendResult> {
    const id = `dev-mail-${randomUUID()}`;
    this.#log.info(
      {
        event: DEV_MAIL_EVENT,
        mail: { id, to: message.to, subject: message.subject, category: message.tags?.category ?? null },
        printed: this.#printBodies
      },
      this.#printBodies ? "dev mailer: message not sent (printed to the terminal)" : "dev mailer: message not sent"
    );
    if (this.#printBodies) this.#write(formatDevMail(id, message));
    return { id };
  }
}
