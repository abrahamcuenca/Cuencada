/**
 * Read messages captured by the harness' test-only mail sink
 * (`tests/e2e/harness/mailSink.ts`).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import type { CapturedMail } from "../harness/mailSink.js";
import { MAIL_DIR, WEB_ORIGIN } from "../harness/settings.js";

/** Filters for {@link waitForMail}. */
export interface MailQuery {
  to: string;
  /** Template kind (`invite`, `magic-link`, `verify-email`, …). */
  category?: string;
  /** Only messages captured at or after this time. */
  since?: Date;
  timeoutMs?: number;
}

function readAll(): CapturedMail[] {
  if (!existsSync(MAIL_DIR)) return [];
  return readdirSync(MAIL_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(MAIL_DIR, name), "utf8")) as CapturedMail); // written by FileSinkMailer
}

function matches(mail: CapturedMail, query: MailQuery): boolean {
  if (mail.to !== query.to.toLowerCase()) return false;
  if (query.category !== undefined && mail.category !== query.category) return false;
  if (query.since !== undefined && new Date(mail.sentAt).getTime() < query.since.getTime() - 1000) return false;
  return true;
}

/**
 * Wait for the newest message matching `query` (mail is sent from a queue,
 * so it can land a moment after the HTTP response).
 */
export async function waitForMail(query: MailQuery): Promise<CapturedMail> {
  let found: CapturedMail | undefined;
  await expect
    .poll(
      () => {
        found = readAll()
          .filter((mail) => matches(mail, query))
          .at(-1);
        return found !== undefined;
      },
      { timeout: query.timeoutMs ?? 15_000, message: `no email to ${query.to} (${query.category ?? "any"})` }
    )
    .toBe(true);
  if (found === undefined) throw new Error("unreachable: poll succeeded without a message");
  return found;
}

/**
 * The first app link in the message's plain-text body, e.g.
 * `http://localhost:4190/invitacion#t=…`.
 */
export function appLinkIn(mail: CapturedMail, path: string): string {
  const escaped = `${WEB_ORIGIN}${path}`.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const match = new RegExp(`${escaped}[^\\s)\\]>"]*`).exec(mail.text);
  if (match === null) throw new Error(`no ${path} link in the "${mail.subject}" email`);
  return match[0];
}
