import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "@react-email/render";
import { describe, expect, it } from "vitest";
import { FOOTER_BRAND, FOOTER_IGNORE } from "./content.js";
import { EmailRenderError, EmailRenderErrorCode } from "./errors.js";
import { EmailKind, type EmailTemplate, renderEmail } from "./render.js";
import { InviteEmail } from "./templates/InviteEmail.js";

const EXPIRES = "2026-09-14T13:40:00Z"; // 7:40 a.m. in Mérida (UTC-6)
const XSS = "<script>alert(1)</script>";

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

interface Case {
  name: string;
  template: EmailTemplate;
  subject: string;
  ctaUrl: string | null;
  withUrl: (url: string) => EmailTemplate;
  withName: (name: string) => EmailTemplate;
}

const inviteUrl = "https://cuencada.com/invitacion#t=abc123_DEF-456";
const loginUrl = "https://cuencada.com/entrar/enlace#t=magic_TOKEN-1";
const resetUrl = "https://cuencada.com/restablecer#t=reset_TOKEN-2";
const verifyUrl = "https://cuencada.com/verificar#t=verify_TOKEN-3";

const cases: Case[] = [
  {
    name: "invite",
    template: {
      kind: EmailKind.Invite,
      props: {
        inviterName: "Tía Lupita",
        inviteeName: "Ana",
        acceptUrl: inviteUrl,
        expiresAt: EXPIRES,
      },
    },
    subject: "Tía Lupita te invitó al portal de la Cuencada",
    ctaUrl: inviteUrl,
    withUrl: (url) => ({
      kind: EmailKind.Invite,
      props: { inviterName: "Tía", acceptUrl: url, expiresAt: EXPIRES },
    }),
    withName: (name) => ({
      kind: EmailKind.Invite,
      props: {
        inviterName: name,
        inviteeName: name,
        acceptUrl: inviteUrl,
        expiresAt: EXPIRES,
      },
    }),
  },
  {
    name: "magic-link",
    template: {
      kind: EmailKind.MagicLink,
      props: { displayName: "Ana", loginUrl, expiresInMinutes: 15 },
    },
    subject: "Tu enlace para entrar a la Cuencada",
    ctaUrl: loginUrl,
    withUrl: (url) => ({
      kind: EmailKind.MagicLink,
      props: { displayName: "Ana", loginUrl: url, expiresInMinutes: 15 },
    }),
    withName: (name) => ({
      kind: EmailKind.MagicLink,
      props: { displayName: name, loginUrl, expiresInMinutes: 15 },
    }),
  },
  {
    name: "password-reset",
    template: {
      kind: EmailKind.PasswordReset,
      props: { displayName: "Ana", resetUrl, expiresInMinutes: 60 },
    },
    subject: "Restablece tu contraseña de la Cuencada",
    ctaUrl: resetUrl,
    withUrl: (url) => ({
      kind: EmailKind.PasswordReset,
      props: { displayName: "Ana", resetUrl: url, expiresInMinutes: 60 },
    }),
    withName: (name) => ({
      kind: EmailKind.PasswordReset,
      props: { displayName: name, resetUrl, expiresInMinutes: 60 },
    }),
  },
  {
    name: "verify-email",
    template: {
      kind: EmailKind.VerifyEmail,
      props: { displayName: "Ana", verifyUrl, expiresInMinutes: 1440 },
    },
    subject: "Confirma tu correo para la Cuencada",
    ctaUrl: verifyUrl,
    withUrl: (url) => ({
      kind: EmailKind.VerifyEmail,
      props: { displayName: "Ana", verifyUrl: url, expiresInMinutes: 1440 },
    }),
    withName: (name) => ({
      kind: EmailKind.VerifyEmail,
      props: { displayName: name, verifyUrl, expiresInMinutes: 1440 },
    }),
  },
];

const passwordChanged: EmailTemplate = {
  kind: EmailKind.PasswordChanged,
  props: {
    displayName: "Ana",
    changedAt: EXPIRES,
    supportContact: "admin@cuencada.com",
  },
};

describe("renderEmail", () => {
  describe.each(cases)("$name", (c) => {
    it("renders HTML, text and the Spanish subject", async () => {
      const email = await renderEmail(c.template);
      expect(email.subject).toBe(c.subject);
      expect(email.html).toContain('lang="es"');
      expect(email.html).not.toContain("..");
      expect(email.html).toContain(FOOTER_BRAND);
      expect(email.html).toContain(FOOTER_IGNORE);
      expect(email.text).toContain(FOOTER_BRAND);
      expect(email.text).toContain(FOOTER_IGNORE);
    });

    it("includes the CTA URL exactly once in the HTML and once in the text", async () => {
      const email = await renderEmail(c.template);
      const url = c.ctaUrl ?? "";
      expect(countOccurrences(email.html, url)).toBe(1);
      expect(countOccurrences(email.text, url)).toBe(1);
      expect(email.html).toContain(`href="${url}"`);
    });

    it("throws EmailRenderError when the link is not https", async () => {
      await expect(
        renderEmail(c.withUrl("http://cuencada.com/x#t=1")),
      ).rejects.toMatchObject({
        code: EmailRenderErrorCode.InsecureUrl,
      });
      await expect(
        renderEmail(c.withUrl("javascript:alert(1)")),
      ).rejects.toBeInstanceOf(EmailRenderError);
      await expect(
        renderEmail(c.withUrl("/relative#t=1")),
      ).rejects.toMatchObject({
        code: EmailRenderErrorCode.InvalidUrl,
      });
    });

    it("allows http://localhost only with allowInsecureLinks", async () => {
      const dev = "http://localhost:5173/x#t=1";
      await expect(renderEmail(c.withUrl(dev))).rejects.toBeInstanceOf(
        EmailRenderError,
      );
      const email = await renderEmail(c.withUrl(dev), {
        allowInsecureLinks: true,
      });
      expect(countOccurrences(email.html, dev)).toBe(1);
      await expect(
        renderEmail(c.withUrl("http://evil.example/x"), {
          allowInsecureLinks: true,
        }),
      ).rejects.toBeInstanceOf(EmailRenderError);
    });

    it("escapes HTML-like input in names", async () => {
      const email = await renderEmail(c.withName(XSS));
      expect(email.html).not.toContain("<script");
      expect(email.html).toContain("&lt;script&gt;");
    });
  });

  describe("password-changed", () => {
    it("renders the subject, date and the 'Si no fuiste tú' warning without a button", async () => {
      const email = await renderEmail(passwordChanged);
      expect(email.subject).toBe("Tu contraseña de la Cuencada cambió");
      expect(email.html).toContain("Si no fuiste tú");
      expect(email.text).toContain("IMPORTANTE: Si no fuiste tú");
      expect(email.text).toContain("admin@cuencada.com");
      expect(email.text).toMatch(/lunes 14 de septiembre ·\s7:40/);
      expect(email.html).not.toContain("<a ");
      expect(email.html).toContain(FOOTER_IGNORE);
    });

    it("escapes HTML-like input in names", async () => {
      const email = await renderEmail({
        ...passwordChanged,
        props: { ...passwordChanged.props, displayName: XSS },
      });
      expect(email.html).not.toContain("<script");
      expect(email.html).toContain("&lt;script&gt;");
    });

    it("throws on an invalid date", async () => {
      await expect(
        renderEmail({
          ...passwordChanged,
          props: { ...passwordChanged.props, changedAt: "not a date" },
        }),
      ).rejects.toMatchObject({
        code: EmailRenderErrorCode.InvalidDate,
        field: "changedAt",
      });
    });
  });

  it("formats dates in America/Merida by default and honours a timeZone override", async () => {
    const merida = await renderEmail(cases[0]?.template ?? passwordChanged);
    expect(merida.text).toMatch(/lunes 14 de septiembre ·\s7:40/);
    const utc = await renderEmail(cases[0]?.template ?? passwordChanged, {
      timeZone: "UTC",
    });
    expect(utc.text).toMatch(/lunes 14 de septiembre ·\s1:40/);
  });

  it("strips control characters from names so the subject stays on one line", async () => {
    const email = await renderEmail({
      kind: EmailKind.Invite,
      props: {
        inviterName: "Tía\r\nBcc: x@evil.example",
        acceptUrl: inviteUrl,
        expiresAt: EXPIRES,
      },
    });
    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(email.subject).toBe(
      "Tía Bcc: x@evil.example te invitó al portal de la Cuencada",
    );
  });

  it("rejects a non-https logoUrl and renders a valid one as the only image", async () => {
    await expect(
      renderEmail(passwordChanged, { logoUrl: "http://cuencada.com/logo.png" }),
    ).rejects.toMatchObject({
      field: "logoUrl",
    });
    const email = await renderEmail(passwordChanged, {
      logoUrl: "https://cuencada.com/icons/logo.png",
    });
    expect(countOccurrences(email.html, "<img")).toBe(1);
    const plain = await renderEmail(passwordChanged);
    expect(plain.html).not.toContain("<img");
  });

  it("rejects invalid TTLs", async () => {
    await expect(
      renderEmail({
        kind: EmailKind.MagicLink,
        props: { displayName: "Ana", loginUrl, expiresInMinutes: 0 },
      }),
    ).rejects.toMatchObject({ code: EmailRenderErrorCode.InvalidDuration });
  });

  it("never echoes the rejected URL (tokens must not reach logs)", async () => {
    const error = await renderEmail(
      cases[1]?.withUrl("http://cuencada.com/#t=SECRET") ?? passwordChanged,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmailRenderError);
    expect(JSON.stringify(error)).not.toContain("SECRET");
    expect(String(error)).not.toContain("SECRET");
  });
});

describe("InviteEmail", () => {
  it("renders standalone as a React Email component", async () => {
    const html = await render(
      <InviteEmail
        inviterName="Tía Lupita"
        acceptUrl={inviteUrl}
        expiresAt={EXPIRES}
      />,
    );
    expect(html).toContain("Aceptar invitación");
    expect(countOccurrences(html, inviteUrl)).toBe(1);
  });
});

describe("source", () => {
  it("never uses dangerouslySetInnerHTML", () => {
    const root = fileURLToPath(new URL(".", import.meta.url));
    const files = readdirSync(root, {
      recursive: true,
      encoding: "utf8",
    }).filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".test.tsx"));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      expect(readFileSync(join(root, file), "utf8")).not.toContain(
        "dangerouslySetInnerHTML",
      );
    }
  });
});
