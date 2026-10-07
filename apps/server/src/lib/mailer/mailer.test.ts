import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { FakeMailer } from "../../../test/helpers/fakes.js";
import { AppError } from "../errors.js";
import { DEV_MAIL_EVENT, DevMailer, formatDevMail } from "./dev.js";
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
  it("in test logs only the recipient and subject and prints nothing", async () => {
    const { log, calls } = captureLogger();
    const written: string[] = [];
    const mailer = new DevMailer(log, "test", (chunk) => written.push(chunk));

    const result = await mailer.send(message);

    expect(result.id).toMatch(/^dev-mail-/);
    const logged = JSON.stringify(calls);
    expect(logged).toContain("ana@example.test");
    expect(logged).toContain("Tu enlace");
    expect(logged).toContain(DEV_MAIL_EVENT);
    expect(logged).not.toContain(TOKEN);
    expect(written).toEqual([]);
  });

  it("in development prints the whole plain-text message to the terminal and keeps the body out of the log", async () => {
    const { log, calls } = captureLogger();
    const written: string[] = [];
    const mailer = new DevMailer(log, "development", (chunk) => written.push(chunk));

    const result = await mailer.send({ ...message, text: `Hola Ana\n\nEntra aquí: ${message.text}\n`, tags: { category: "magic-link" } });

    expect(written).toHaveLength(1);
    const block = written[0] ?? "";
    expect(block).toContain("dev.mail");
    expect(block).toContain("Para:      ana@example.test");
    expect(block).toContain("Asunto:    Tu enlace");
    expect(block).toContain("Categoría: magic-link");
    expect(block).toContain(`│ Entra aquí: https://cuencada.com/entrar/enlace#t=${TOKEN}`);
    expect(block).toContain(result.id);
    expect(block).not.toContain("<a href");
    const logged = JSON.stringify(calls);
    expect(logged).toContain(DEV_MAIL_EVENT);
    expect(logged).not.toContain(TOKEN);
  });

  it("prints the invite, magic-link, verify and reset links in development", async () => {
    const written: string[] = [];
    const mailer = new DevMailer(captureLogger().log, "development", (chunk) => written.push(chunk));
    const config = { NODE_ENV: "development" as const, SUPPORT_EMAIL: "admin@cuencada.com" };
    const base = { APP_BASE_URL: "http://localhost:5173" };
    const links = {
      invite: appLink(base, AppLinkPath.Invite, TOKEN),
      magic: appLink(base, AppLinkPath.MagicLink, TOKEN),
      verify: appLink(base, AppLinkPath.VerifyEmail, TOKEN),
      reset: appLink(base, AppLinkPath.PasswordReset, TOKEN)
    };

    await sendTemplate({ mailer, config }, "a@x.test", { kind: "magic-link", props: { displayName: "Ana", loginUrl: links.magic, expiresInMinutes: 15 } });
    await sendTemplate({ mailer, config }, "a@x.test", { kind: "verify-email", props: { displayName: "Ana", verifyUrl: links.verify, expiresInMinutes: 60 } });
    await sendTemplate({ mailer, config }, "a@x.test", { kind: "password-reset", props: { displayName: "Ana", resetUrl: links.reset, expiresInMinutes: 60 } });
    await sendTemplate({ mailer, config }, "a@x.test", {
      kind: "invite",
      props: { inviterName: "Beto", acceptUrl: links.invite, expiresAt: "2027-01-01T00:00:00.000Z" }
    });

    expect(written).toHaveLength(4);
    const all = written.join("");
    for (const link of Object.values(links)) expect(all).toContain(link);
  });

  it("refuses to be constructed in production", () => {
    expect(() => new DevMailer(captureLogger().log, "production")).toThrow(/production/);
  });
});

describe("formatDevMail", () => {
  it("frames every body line and omits the category when there is none", () => {
    const block = formatDevMail("dev-mail-1", { to: "b@x.test", subject: "Hola", html: "<p>x</p>", text: "uno\r\ndos" });

    expect(block).toContain("│ uno\n│ dos\n");
    expect(block).not.toContain("Categoría");
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

  it("never selects the dev mailer in production", () => {
    const { log } = captureLogger();

    expect(() => createMailer({ NODE_ENV: "production", RESEND_API_KEY: undefined, MAIL_FROM: undefined }, log)).toThrow(/DevMailer/);
    expect(() => createMailer({ NODE_ENV: "production", RESEND_API_KEY: "re_x", MAIL_FROM: undefined }, log)).toThrow(/DevMailer/);
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
