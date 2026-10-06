import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { FakeMailer } from "../../../test/helpers/fakes.js";
import { AppError } from "../errors.js";
import { DevMailer } from "./dev.js";
import { AppLinkPath, appLink, createMailer, sendTemplate } from "./index.js";
import { ResendMailer, type ResendEmailsClient } from "./resend.js";

const TOKEN = "tok_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

function captureLogger(): { log: FastifyBaseLogger; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const record = (...args: unknown[]) => {
    calls.push(args);
  };
  const log = {
    level: "info",
    fatal: record,
    error: record,
    warn: record,
    info: record,
    debug: record,
    trace: record,
    silent: record,
    child: () => log
  };
  return { log: log as unknown as FastifyBaseLogger, calls }; // minimal pino-shaped stub
}

const message = {
  to: "ana@example.test",
  subject: "Tu enlace",
  html: `<a href="https://cuencada.com/entrar/enlace#t=${TOKEN}">Entrar</a>`,
  text: `https://cuencada.com/entrar/enlace#t=${TOKEN}`
};

describe("appLink", () => {
  it("puts the token in the fragment under APP_BASE_URL", () => {
    expect(appLink({ APP_BASE_URL: "https://cuencada.com" }, AppLinkPath.Invite, TOKEN)).toBe(
      `https://cuencada.com/invitacion#t=${TOKEN}`
    );
  });

  it("builds a plain link without a token", () => {
    expect(appLink({ APP_BASE_URL: "http://localhost:5173" }, AppLinkPath.VerifyEmail)).toBe(
      "http://localhost:5173/verificar"
    );
  });
});

describe("sendTemplate", () => {
  it("renders the template and sends it with Reply-To SUPPORT_EMAIL, a category tag and the idempotency key", async () => {
    const mailer = new FakeMailer();
    const loginUrl = appLink({ APP_BASE_URL: "http://localhost:5173" }, AppLinkPath.MagicLink, TOKEN);

    await sendTemplate(
      { mailer, config: { NODE_ENV: "development", SUPPORT_EMAIL: "ayuda@cuencada.com" } },
      "ana@example.test",
      { kind: "magic-link", props: { displayName: "Ana", loginUrl, expiresInMinutes: 15 } },
      { idempotencyKey: "magic-link:row-1" }
    );

    const sent = mailer.lastTo("ana@example.test");
    expect(sent?.subject).toBe("Tu enlace para entrar a la Cuencada");
    expect(sent?.replyTo).toBe("ayuda@cuencada.com");
    expect(sent?.tags).toEqual({ category: "magic-link" });
    expect(sent?.idempotencyKey).toBe("magic-link:row-1");
    expect(sent?.text).toContain(loginUrl);
  });

  it("refuses insecure links in production", async () => {
    const mailer = new FakeMailer();

    await expect(
      sendTemplate({ mailer, config: { NODE_ENV: "production", SUPPORT_EMAIL: "admin@cuencada.com" } }, "a@x.test", {
        kind: "verify-email",
        props: { displayName: "Ana", verifyUrl: "http://localhost:5173/verificar#t=x", expiresInMinutes: 60 }
      })
    ).rejects.toThrow();
    expect(mailer.outbox).toHaveLength(0);
  });
});

describe("DevMailer", () => {
  it("logs only the recipient and subject, never the body", async () => {
    const { log, calls } = captureLogger();
    const mailer = new DevMailer(log, "development");

    const result = await mailer.send(message);

    expect(result.id).toMatch(/^dev-mail-/);
    const logged = JSON.stringify(calls);
    expect(logged).toContain("ana@example.test");
    expect(logged).toContain("Tu enlace");
    expect(logged).not.toContain(TOKEN);
  });

  it("refuses to run in production", () => {
    expect(() => new DevMailer(captureLogger().log, "production")).toThrow();
  });
});

describe("createMailer", () => {
  it("uses Resend when the API key and sender are configured, otherwise the dev mailer", () => {
    const { log } = captureLogger();

    expect(
      createMailer({ NODE_ENV: "production", RESEND_API_KEY: "re_x", MAIL_FROM: "Cuencada <no-reply@cuencada.com>" }, log)
    ).toBeInstanceOf(ResendMailer);
    expect(createMailer({ NODE_ENV: "development", RESEND_API_KEY: undefined, MAIL_FROM: undefined }, log)).toBeInstanceOf(
      DevMailer
    );
  });
});

describe("ResendMailer", () => {
  it("passes the message, sanitized tags and the idempotency key to Resend", async () => {
    const send = vi.fn<ResendEmailsClient["send"]>().mockResolvedValue({
      data: { id: "re_123" },
      error: null,
      headers: null
    });
    const mailer = new ResendMailer({ apiKey: "re_x", from: "Cuencada <no-reply@cuencada.com>" }, { send });

    const result = await mailer.send({
      ...message,
      replyTo: "admin@cuencada.com",
      tags: { category: "magic link!" },
      idempotencyKey: "magic-link:row-1"
    });

    expect(result).toEqual({ id: "re_123" });
    expect(send).toHaveBeenCalledWith(
      {
        from: "Cuencada <no-reply@cuencada.com>",
        to: "ana@example.test",
        subject: "Tu enlace",
        html: message.html,
        text: message.text,
        replyTo: "admin@cuencada.com",
        tags: [{ name: "category", value: "magic_link_" }]
      },
      { idempotencyKey: "magic-link:row-1" }
    );
  });

  it("throws SERVICE_UNAVAILABLE without echoing the provider message when Resend rejects", async () => {
    const send = vi.fn<ResendEmailsClient["send"]>().mockResolvedValue({
      data: null,
      error: { name: "validation_error", message: `bad payload ${TOKEN}`, statusCode: 422 },
      headers: null
    });
    const mailer = new ResendMailer({ apiKey: "re_x", from: "x@cuencada.com" }, { send });

    const error = await mailer.send(message).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(String((error as AppError).cause)).not.toContain(TOKEN); // narrowed by the toBeInstanceOf assertion above
  });
});
