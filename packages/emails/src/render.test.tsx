import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "@react-email/render";
import { describe, expect, it } from "vitest";
import { CTA_FALLBACK_LABEL, FOOTER_BRAND, FOOTER_IGNORE } from "./content.js";
import { EmailRenderError, EmailRenderErrorCode } from "./errors.js";
import { cleanName } from "./format.js";
import { EmailKind, type EmailTemplate, renderEmail } from "./render.js";
import { InviteEmail } from "./templates/InviteEmail.js";

const EXPIRES = "2026-09-14T13:40:00Z"; // 7:40 a.m. in Mérida (UTC-6)
const XSS = "<script>alert(1)</script>";

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
const auditLogUrl = "https://cuencada.com/admin/bitacora";

const adminChanged = (
  name: string,
  url: string = auditLogUrl,
): EmailTemplate => ({
  kind: EmailKind.AdminAccountChanged,
  props: {
    recipientName: name,
    actorName: name,
    targetName: name,
    changes: ["demoted", "disabled"],
    changedAt: EXPIRES,
    auditLogUrl: url,
  },
});

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
        eventTitle: name,
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

    it("includes the CTA URL exactly twice in the HTML (button + fallback) and once in the text", async () => {
      const email = await renderEmail(c.template);
      const url = c.ctaUrl ?? "";
      expect(countOccurrences(email.html, url)).toBe(2);
      expect(countOccurrences(email.html, `href="${url}"`)).toBe(1);
      expect(countOccurrences(email.text, url)).toBe(1);
    });

    it("shows a copy-paste fallback link that wraps on mobile", async () => {
      const email = await renderEmail(c.template);
      const url = c.ctaUrl ?? "";
      expect(email.html).toContain(CTA_FALLBACK_LABEL);
      expect(email.html).toMatch(
        new RegExp(`word-break:break-all[^>]*>${escapeRegExp(url)}<`),
      );
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
      expect(countOccurrences(email.html, dev)).toBe(2);
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
    });

    it("never ends with 'puedes ignorarlo' and uses the security footer instead", async () => {
      const email = await renderEmail(passwordChanged);
      const footer =
        "Si no reconoces este cambio, escríbenos a admin@cuencada.com de inmediato.";
      expect(email.html).not.toContain("ignorarlo");
      expect(email.text).not.toContain("ignorarlo");
      expect(email.html).toContain(footer);
      expect(email.text.trimEnd().endsWith(footer)).toBe(true);
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

  describe("admin-account-changed", () => {
    const template: EmailTemplate = {
      kind: EmailKind.AdminAccountChanged,
      props: {
        recipientName: "Tía Lupita",
        actorName: "Primo Beto",
        targetName: "Tío Juan",
        changes: ["demoted", "disabled", "demoted"],
        changedAt: EXPIRES,
        auditLogUrl,
      },
    };

    it("says who changed whom, what and when, and links to the audit log", async () => {
      const email = await renderEmail(template);
      expect(email.subject).toBe("Cambio en una cuenta de administrador");
      expect(email.text).toContain("¡Hola, Tía Lupita!");
      expect(email.text).toMatch(
        /Primo Beto hizo este cambio en la cuenta de Tío Juan el lunes 14 de septiembre ·\s7:40/,
      );
      expect(countOccurrences(email.text, "Le quitó el rol de administrador.")).toBe(1);
      expect(email.text).toContain("Desactivó la cuenta.");
      expect(email.text).toContain(`Revisar la bitácora:\n${auditLogUrl}`);
      expect(email.text).toContain("IMPORTANTE: Si no reconoces este cambio");
    });

    it("is a security notice: it never says to ignore it", async () => {
      const email = await renderEmail(template);
      expect(email.html).not.toContain("ignorarlo");
      expect(email.text).not.toContain("ignorarlo");
      expect(email.text.trimEnd()).toMatch(/administras el portal de la Cuencada\.$/);
    });

    it("has the CTA in the button, the fallback and the text alternative", async () => {
      const email = await renderEmail(adminChanged("Ana"));
      expect(countOccurrences(email.html, auditLogUrl)).toBe(2);
      expect(countOccurrences(email.text, auditLogUrl)).toBe(1);
      expect(email.html).toContain("cu-btn");
    });

    it("requires an https audit-log link", async () => {
      await expect(
        renderEmail(adminChanged("Ana", "http://cuencada.com/admin/bitacora")),
      ).rejects.toMatchObject({ code: EmailRenderErrorCode.InsecureUrl });
    });

    it("escapes HTML-like input in every name", async () => {
      const email = await renderEmail(adminChanged(XSS));
      expect(email.html).not.toContain("<script");
      expect(countOccurrences(email.html, "&lt;script&gt;")).toBeGreaterThanOrEqual(3);
    });

    it("tells the changed account it is about their own account, without a bitácora link", async () => {
      const email = await renderEmail({
        ...template,
        props: { ...template.props, recipientName: "Tío Juan", recipientIsTarget: true },
      });
      expect(email.text).toMatch(/Primo Beto hizo este cambio en tu cuenta el lunes 14/);
      expect(email.text).not.toContain("la cuenta de Tío Juan");
      expect(email.text).toContain("el cambio afecta tu cuenta de administrador");
      expect(email.text).toContain("IMPORTANTE: Si no reconoces este cambio, avisa de inmediato");
      expect(email.text).not.toContain(auditLogUrl);
      expect(email.html).not.toContain("<a ");
    });

    it("rejects an empty or unknown change list", async () => {
      for (const changes of [[], ["deleted"]]) {
        await expect(
          renderEmail({
            ...template,
            // Deliberately invalid input, as untyped callers could send it.
            props: { ...template.props, changes: changes as never },
          }),
        ).rejects.toMatchObject({
          code: EmailRenderErrorCode.InvalidOption,
          field: "changes",
        });
      }
    });
  });

  describe("admin-alert-limit", () => {
    const limit: EmailTemplate = {
      kind: EmailKind.AdminAlertLimit,
      props: { recipientName: "Tía Lupita", reachedAt: EXPIRES, auditLogUrl },
    };

    it("announces the daily limit, says removals still alert, and links to the bitácora", async () => {
      const email = await renderEmail(limit);
      expect(email.subject).toBe("Se alcanzó el límite de avisos de seguridad de hoy");
      expect(email.text).toContain("¡Hola, Tía Lupita!");
      expect(email.text).toMatch(/el lunes 14 de septiembre ·\s7:40/);
      expect(email.text).toContain("le quiten el rol de administrador");
      expect(countOccurrences(email.html, auditLogUrl)).toBe(2);
      expect(countOccurrences(email.text, auditLogUrl)).toBe(1);
      expect(email.text).not.toContain("ignorarlo");
    });

    it("escapes names and requires an https link", async () => {
      const escaped = await renderEmail({ ...limit, props: { ...limit.props, recipientName: XSS } });
      expect(escaped.html).not.toContain("<script");
      expect(escaped.html).toContain("&lt;script&gt;");
      await expect(
        renderEmail({ ...limit, props: { ...limit.props, auditLogUrl: "http://cuencada.com/admin/bitacora" } }),
      ).rejects.toMatchObject({ code: EmailRenderErrorCode.InsecureUrl });
    });
  });

  describe("admin-invite-accepted", () => {
    const reviewUrl =
      "https://cuencada.com/admin/bitacora?accion=invite.accepted&actor=00000000-0000-4000-8000-000000000001";
    const accepted: EmailTemplate = {
      kind: EmailKind.AdminInviteAccepted,
      props: {
        recipientName: "Tía Lupita",
        memberName: "Primo Nuevo",
        inviteLabel: "Grupo de primos",
        inviteShortId: "3F2A9C1B",
        useCount: 2,
        maxUses: 5,
        acceptedAt: EXPIRES,
        reviewUrl,
      },
    };

    it("says who joined, with which link, how many uses and when, and links to the review page", async () => {
      const email = await renderEmail(accepted);
      expect(email.subject).toBe("Alguien se unió con un enlace de invitación");
      expect(email.text).toContain("¡Hola, Tía Lupita!");
      expect(email.text).toMatch(
        /Primo Nuevo creó su cuenta en el portal de la Cuencada con el enlace «Grupo de primos» \(3f2a9c1b\) el lunes 14 de septiembre ·\s7:40/,
      );
      expect(email.text).toContain("El enlace lleva 2 de 5 usos.");
      expect(email.text).toContain(`Revisar en la bitácora:\n${reviewUrl}`);
      expect(email.text).toContain("IMPORTANTE: Si no reconoces a esta persona");
      expect(countOccurrences(email.text, "bitacora?accion=invite.accepted")).toBe(1);
      expect(email.text).not.toContain("@");
    });

    it("is a security notice: it never says to ignore it", async () => {
      const email = await renderEmail(accepted);
      expect(email.html).not.toContain("ignorarlo");
      expect(email.text).not.toContain("ignorarlo");
      expect(email.text.trimEnd()).toMatch(/administras el portal de la Cuencada\.$/);
    });

    it("falls back to the short id without a label, and to a neutral name", async () => {
      const email = await renderEmail({
        ...accepted,
        props: { ...accepted.props, inviteLabel: null, memberName: "\u200b", useCount: 1, maxUses: 1 },
      });
      expect(email.text).toContain("Una persona creó su cuenta en el portal de la Cuencada con el enlace 3f2a9c1b el");
      expect(email.text).toContain("El enlace lleva 1 de 1 uso.");
    });

    it("escapes names and labels and requires an https link", async () => {
      const escaped = await renderEmail({
        ...accepted,
        props: { ...accepted.props, memberName: XSS, inviteLabel: XSS, recipientName: XSS },
      });
      expect(escaped.html).not.toContain("<script");
      expect(countOccurrences(escaped.html, "&lt;script&gt;")).toBeGreaterThanOrEqual(3);
      await expect(
        renderEmail({ ...accepted, props: { ...accepted.props, reviewUrl: "http://cuencada.com/admin/bitacora" } }),
      ).rejects.toMatchObject({ code: EmailRenderErrorCode.InsecureUrl });
    });

    it("rejects a malformed short id or inconsistent use counts", async () => {
      await expect(
        renderEmail({ ...accepted, props: { ...accepted.props, inviteShortId: "<b>x</b>" } }),
      ).rejects.toMatchObject({ code: EmailRenderErrorCode.InvalidOption, field: "inviteShortId" });
      for (const [useCount, maxUses] of [
        [0, 5],
        [6, 5],
        [1, 51],
        [1.5, 5],
      ] as const) {
        await expect(
          renderEmail({ ...accepted, props: { ...accepted.props, useCount, maxUses } }),
        ).rejects.toMatchObject({ code: EmailRenderErrorCode.InvalidOption, field: "useCount" });
      }
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

  it("strips bidi and invisible characters from names", async () => {
    const invisible = [
      "\u200b",
      "\u200f",
      "\u202a",
      "\u202e",
      "\u2060",
      "\u2069",
      "\ufeff",
      "\u00ad",
      "\u3164",
    ];
    const email = await renderEmail({
      kind: EmailKind.Invite,
      props: {
        inviterName: `T${invisible.join("")}ía \u202elupita\u202c`,
        acceptUrl: inviteUrl,
        expiresAt: EXPIRES,
      },
    });
    expect(email.subject).toBe("Tía lupita te invitó al portal de la Cuencada");
    for (const char of invisible) {
      expect(email.subject).not.toContain(char);
      expect(email.text).not.toContain(char);
    }
    expect(cleanName("\u200b\u202e\ufeff")).toBeNull();
  });

  it("declares light-only colour scheme and hardens the button for dark mode", async () => {
    const email = await renderEmail(cases[0]?.template ?? passwordChanged);
    expect(email.html).toContain(
      '<meta name="color-scheme" content="light only"',
    );
    expect(email.html).toContain(
      '<meta name="supported-color-schemes" content="light only"',
    );
    expect(email.html).toContain("[data-ogsb] .cu-btn");
    expect(email.html).toMatch(
      /class="cu-btn"[^>]*background-color:#0b5e55|background-color:#0b5e55[^>]*class="cu-btn"/,
    );
    expect(email.html).toContain("border:2px solid #e7b84b;color:#ffffff");
    expect(email.html).toContain('bgcolor="#ffffff"');
  });

  it("gives the container a fixed 600px width attribute for Outlook desktop and a fluid style for everyone else", async () => {
    const email = await renderEmail(cases[0]?.template ?? passwordChanged);
    const container = /<table[^>]*width="600"[^>]*>/.exec(email.html)?.[0];
    expect(container).toBeDefined();
    expect(container).toContain("width:100%");
    expect(container).toContain("max-width:600px");
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
    expect(countOccurrences(html, inviteUrl)).toBe(2);
  });

  it("shows eventTitle in the body when present and omits the sentence otherwise", async () => {
    const withEvent = await renderEmail({
      kind: EmailKind.Invite,
      props: {
        inviterName: "Tía Lupita",
        eventTitle: "Cuencada 2027 · Mérida",
        acceptUrl: inviteUrl,
        expiresAt: EXPIRES,
      },
    });
    expect(withEvent.html).toContain("Cuencada 2027 · Mérida");
    expect(withEvent.text).toContain(
      "Ya estamos preparando la próxima reunión: Cuencada 2027 · Mérida.",
    );
    const without = await renderEmail({
      kind: EmailKind.Invite,
      props: {
        inviterName: "Tía Lupita",
        acceptUrl: inviteUrl,
        expiresAt: EXPIRES,
      },
    });
    expect(without.text).not.toContain("próxima reunión");
  });

  it("escapes HTML-like input in eventTitle", async () => {
    const email = await renderEmail({
      kind: EmailKind.Invite,
      props: {
        inviterName: "Tía Lupita",
        eventTitle: XSS,
        acceptUrl: inviteUrl,
        expiresAt: EXPIRES,
      },
    });
    expect(email.html).not.toContain("<script");
    expect(email.html).toContain("&lt;script&gt;");
  });
});

describe("source", () => {
  const root = fileURLToPath(new URL(".", import.meta.url));
  const sources = readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".test.tsx"))
    .map((f) => ({ file: f, text: readFileSync(join(root, f), "utf8") }));

  it("never uses dangerouslySetInnerHTML", () => {
    expect(sources.length).toBeGreaterThan(5);
    for (const { text } of sources) {
      expect(text).not.toContain("dangerouslySetInnerHTML");
    }
  });

  it("never imports deprecated @react-email component packages, only render", () => {
    for (const { text } of sources) {
      for (const [, pkg] of text.matchAll(/from "(@react-email\/[^"]+)"/g)) {
        expect(pkg).toBe("@react-email/render");
      }
    }
  });

  it("never renders with pretty: true (the only path that loads prettier)", () => {
    for (const { text } of sources) {
      expect(text).not.toMatch(/pretty:\s*true/);
    }
    const renderSource = sources.find((s) => s.file === "render.tsx");
    expect(renderSource?.text).toMatch(/pretty:\s*false/);
  });
});
