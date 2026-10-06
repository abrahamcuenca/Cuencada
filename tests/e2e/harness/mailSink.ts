/**
 * TEST-ONLY mail sink [SEC]: a `Mailer` that writes every outbound message
 * as a JSON file instead of sending it, so Playwright specs can read the
 * one-time links (invite, magic link, email verification).
 *
 * Why it can never run in production:
 * - It lives under `tests/e2e/`, outside `apps/server/src`, so it is not in
 *   the server build (`apps/server/dist`) or the deploy artifact at all.
 * - It is only wired in by the e2e harness entrypoint (`server.ts`), which
 *   refuses to start unless `E2E=1` and `NODE_ENV=test`.
 * - The constructor itself throws when `NODE_ENV=production`.
 *
 * The files carry live one-time tokens, so they go to a per-run temp
 * directory (mode 0700) that the harness wipes on every start.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Mailer, MailMessage, MailSendResult } from "../../../apps/server/dist/lib/mailer/types.js";

/** One captured message as written to disk. */
export interface CapturedMail {
  id: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  category: string | null;
  sentAt: string;
}

/** Writes each message to `<dir>/<timestamp>-<id>.json`. */
export class FileSinkMailer implements Mailer {
  readonly #dir: string;
  readonly #seenKeys = new Map<string, string>();

  /**
   * @param dir - Output directory (created if missing).
   * @param nodeEnv - Must not be `production`.
   * @throws Error in production.
   */
  constructor(dir: string, nodeEnv: string | undefined) {
    if (nodeEnv === "production") throw new Error("FileSinkMailer is test-only and refuses NODE_ENV=production");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.#dir = dir;
  }

  /** Capture the message. A repeated idempotency key returns the first id (like Resend). */
  async send(message: MailMessage): Promise<MailSendResult> {
    if (message.idempotencyKey !== undefined) {
      const previous = this.#seenKeys.get(message.idempotencyKey);
      if (previous !== undefined) return { id: previous };
    }
    const id = `e2e-mail-${randomUUID()}`;
    if (message.idempotencyKey !== undefined) this.#seenKeys.set(message.idempotencyKey, id);
    const captured: CapturedMail = {
      id,
      to: message.to.toLowerCase(),
      subject: message.subject,
      text: message.text,
      html: message.html,
      category: message.tags?.category ?? null,
      sentAt: new Date().toISOString()
    };
    const name = `${Date.now().toString().padStart(15, "0")}-${id}.json`;
    writeFileSync(join(this.#dir, name), JSON.stringify(captured), { mode: 0o600 });
    return { id };
  }
}
