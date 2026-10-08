import { describe, expect, it } from "vitest";
import { readAuditFilters, toAuditQuery, writeAuditFilters, zonedMidnight } from "./auditFilters";
import {
  candidateBlockedReason,
  changeInviteDelivery,
  describeCandidate,
  INVITE_FORM_DEFAULTS,
  normalizeInviteForm,
  validateInviteForm
} from "./inviteForm";
import { auditActionLabel, auditEntityLabel } from "./labels";
import { alertFlags, formatMetadataValue, METADATA_VALUE_MAX, metadataRows } from "./metadata";
import { LAST_ADMIN_MESSAGE, SELF_CHANGE_MESSAGE, userActionErrorMessage } from "./userErrors";

describe("validateInviteForm", () => {
  it("builds an email invite body with maxUses 1", () => {
    expect(validateInviteForm({ ...INVITE_FORM_DEFAULTS, email: " ana.prieto@example.com ", maxUses: "9" })).toEqual({
      ok: true,
      request: { email: "ana.prieto@example.com", role: "member", maxUses: 1, expiresInDays: 7, sendEmail: true, note: null }
    });
  });

  it("requires an email for an admin invite", () => {
    expect(validateInviteForm({ ...INVITE_FORM_DEFAULTS, role: "admin" })).toEqual({
      ok: false,
      errors: { email: "Una invitación de administrador debe ir a un correo." }
    });
  });

  it("forces email delivery for the admin role", () => {
    expect(normalizeInviteForm({ ...INVITE_FORM_DEFAULTS, role: "admin", delivery: "link" }).delivery).toBe("email");
    expect(normalizeInviteForm({ ...INVITE_FORM_DEFAULTS, role: "member", delivery: "link" }).delivery).toBe("link");
  });

  it("builds an open invite body without an email", () => {
    expect(validateInviteForm({ ...INVITE_FORM_DEFAULTS, delivery: "link", email: "ignored@example.com", maxUses: "10", expiresInDays: "3" })).toEqual({
      ok: true,
      request: { email: null, role: "member", maxUses: 10, expiresInDays: 3, sendEmail: false, note: null }
    });
  });

  it("defaults an open link to 5 uses and 72 hours, and an email invite back to 7 days", () => {
    const link = changeInviteDelivery({ ...INVITE_FORM_DEFAULTS, expiresInDays: "20" }, "link");
    expect(link).toMatchObject({ delivery: "link", maxUses: "5", expiresInDays: "3" });
    expect(validateInviteForm(link)).toEqual({
      ok: true,
      request: { email: null, role: "member", maxUses: 5, expiresInDays: 3, sendEmail: false, note: null }
    });
    expect(changeInviteDelivery(link, "email")).toMatchObject({ delivery: "email", expiresInDays: "7" });
    expect(changeInviteDelivery(link, "link")).toBe(link);
    expect(normalizeInviteForm({ ...link, role: "admin" })).toMatchObject({ delivery: "email", expiresInDays: "7" });
  });

  it("rejects open invites over the contract limits", () => {
    const result = validateInviteForm({ ...INVITE_FORM_DEFAULTS, delivery: "link", maxUses: "11", expiresInDays: "4" });
    expect(result).toEqual({
      ok: false,
      errors: {
        maxUses: "Un enlace abierto admite como máximo 10 usos.",
        expiresInDays: "Un enlace abierto dura como máximo 72 horas (3 días)."
      }
    });
  });

  it.each([
    ["0", "maxUses"],
    ["abc", "maxUses"],
    ["60", "maxUses"]
  ])("rejects %s uses with a plain message", (maxUses) => {
    const result = validateInviteForm({ ...INVITE_FORM_DEFAULTS, delivery: "link", maxUses });
    expect(result.ok ? null : result.errors.maxUses).toBe("Escribe un número de usos entre 1 y 10.");
  });

  it("rejects an open link lasting 0 days with the 72-hour range", () => {
    const result = validateInviteForm({ ...INVITE_FORM_DEFAULTS, delivery: "link", maxUses: "1", expiresInDays: "0" });
    expect(result.ok ? null : result.errors.expiresInDays).toBe("Escribe un número de días entre 1 y 3 (72 horas).");
  });

  it("rejects a bound invite past 30 days", () => {
    const result = validateInviteForm({ ...INVITE_FORM_DEFAULTS, email: "ana.prieto@example.com", expiresInDays: "31" });
    expect(result.ok ? null : result.errors.expiresInDays).toBe("Escribe un número de días entre 1 y 30.");
  });

  it("rejects an invalid email", () => {
    const result = validateInviteForm({ ...INVITE_FORM_DEFAULTS, email: "no-es-correo" });
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.errors.email).toEqual(expect.any(String));
  });
});

describe("invite person (WP-4.2)", () => {
  const ana = { id: "00000000-0000-4000-8000-000000000002", fullName: "Ana Ejemplo" };

  it("sends personId only on an email invite", () => {
    const result = validateInviteForm({ ...INVITE_FORM_DEFAULTS, email: "ana@example.com", person: ana });
    expect(result).toEqual({
      ok: true,
      request: { email: "ana@example.com", role: "member", maxUses: 1, expiresInDays: 7, sendEmail: true, note: null, personId: ana.id }
    });
  });

  it("drops the person when switching to an open link, and never sends it on one", () => {
    const withPerson = { ...INVITE_FORM_DEFAULTS, person: ana };
    expect(changeInviteDelivery(withPerson, "link").person).toBeNull();
    const forced = validateInviteForm({ ...withPerson, delivery: "link" });
    expect(forced.ok && "personId" in forced.request).toBe(false);
  });

  it("describes namesakes by nickname, birth year and branch", () => {
    expect(describeCandidate({ nickname: null, birthYear: 1990, familyBranch: "Rama Norte" })).toBe("n. 1990 · Rama Norte");
    expect(describeCandidate({ nickname: "Chata", birthYear: null, familyBranch: null })).toBe("«Chata»");
    expect(describeCandidate({ nickname: null, birthYear: null, familyBranch: null })).toBe("");
  });

  it("explains why a person cannot be picked", () => {
    const base = { deceased: false, linked: false, pendingInvite: false };
    expect(candidateBlockedReason(base)).toBeNull();
    expect(candidateBlockedReason({ ...base, linked: true })).toBe("Ya tiene cuenta");
    expect(candidateBlockedReason({ ...base, deceased: true })).toBe("Falleció");
    expect(candidateBlockedReason({ ...base, pendingInvite: true })).toBe("Invitación pendiente");
  });
});

describe("audit filters", () => {
  it("reads only valid params", () => {
    const params = new URLSearchParams("accion=user.disabled&tipo=invite&desde=2026-10-01&hasta=2026-13-01&actor=0b9c2f7e-1d2a-4c3b-8e4f-5a6b7c8d9e01");
    expect(readAuditFilters(params)).toEqual({
      action: "user.disabled",
      entityType: "invite",
      from: "2026-10-01",
      to: "",
      actorUserId: "0b9c2f7e-1d2a-4c3b-8e4f-5a6b7c8d9e01"
    });
    expect(readAuditFilters(new URLSearchParams("accion=<b>&tipo=foo&actor=1"))).toEqual({ action: "", entityType: "", from: "", to: "", actorUserId: "" });
  });

  it("writes only non-empty params", () => {
    expect(writeAuditFilters({ action: "", entityType: "user", from: "", to: "2026-10-06", actorUserId: "" }).toString()).toBe("tipo=user&hasta=2026-10-06");
  });

  it("computes local midnight in a fixed-offset and a DST zone", () => {
    expect(new Date(zonedMidnight("2026-10-06", "America/Merida")).toISOString()).toBe("2026-10-06T06:00:00.000Z");
    expect(new Date(zonedMidnight("2026-03-29", "Europe/Madrid")).toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(new Date(zonedMidnight("2026-07-01", "Europe/Madrid")).toISOString()).toBe("2026-06-30T22:00:00.000Z");
  });

  it("turns a day range into an inclusive instant range", () => {
    expect(toAuditQuery({ action: "", entityType: "", from: "2026-10-01", to: "2026-10-01", actorUserId: "" }, "America/Merida")).toEqual({
      ok: true,
      filter: { from: "2026-10-01T06:00:00.000Z", to: "2026-10-02T06:00:00.000Z" }
    });
  });

  it("refuses an inverted range", () => {
    expect(toAuditQuery({ action: "", entityType: "", from: "2026-10-02", to: "2026-10-01", actorUserId: "" }, "America/Merida").ok).toBe(false);
  });
});

describe("metadata", () => {
  it("badges an open-invite acceptance whose admin alert was skipped (WP-2.3b)", () => {
    expect(alertFlags({ open: true, inviteAlertRecipients: 0, inviteAlertSkipped: true })).toEqual([
      { key: "inviteAlertSkipped", label: "Aviso no enviado", tone: "danger" }
    ]);
    expect(alertFlags({ open: true, inviteAlertRecipients: 2, inviteAlertSkipped: "true" })).toEqual([]);
    expect(alertFlags({ inviteAlertRecipients: 2, inviteAlertLimitNotice: true, inviteAlertSkipped: true }).map((flag) => flag.key)).toEqual([
      "inviteAlertLimitNotice",
      "inviteAlertSkipped"
    ]);
  });

  it("formats every JSON value as plain text", () => {
    expect(formatMetadataValue(true)).toBe("Sí");
    expect(formatMetadataValue(false)).toBe("No");
    expect(formatMetadataValue(null)).toBe("—");
    expect(formatMetadataValue(3)).toBe("3");
    expect(formatMetadataValue(["role", "status"])).toBe("role, status");
    expect(formatMetadataValue([])).toBe("—");
    expect(formatMetadataValue({ from: "member", to: "admin" })).toBe('{"from":"member","to":"admin"}');
    expect(formatMetadataValue("<b>hola</b>")).toBe("<b>hola</b>");
  });

  it("cuts long values", () => {
    expect(formatMetadataValue("x".repeat(METADATA_VALUE_MAX + 10))).toHaveLength(METADATA_VALUE_MAX + 1);
  });

  it("keeps the stored key order", () => {
    expect(metadataRows({ b: 1, a: "x" })).toEqual([
      { key: "b", value: "1" },
      { key: "a", value: "x" }
    ]);
  });
});

describe("labels", () => {
  it("falls back to the raw value for unknown actions and types", () => {
    expect(auditActionLabel("user.disabled")).toBe("Deshabilitó una cuenta");
    expect(auditActionLabel("future.thing_done")).toBe("future.thing_done");
    expect(auditActionLabel("toString")).toBe("toString");
    expect(auditEntityLabel("media")).toBe("Foto o video");
    expect(auditEntityLabel("legacy")).toBe("legacy");
  });
});

describe("userActionErrorMessage", () => {
  const error = (status: number, code: string, message?: string): unknown => ({
    status,
    data: message === undefined ? {} : { error: { code, message } }
  });

  it("maps the guardrails to Spanish", () => {
    expect(userActionErrorMessage(error(409, "CONFLICT", "x"))).toBe(LAST_ADMIN_MESSAGE);
    expect(userActionErrorMessage(error(403, "FORBIDDEN", "No puedes cambiar tu propio rol ni desactivar tu propia cuenta."))).toBe(SELF_CHANGE_MESSAGE);
    expect(userActionErrorMessage(error(429, "RATE_LIMITED", "Esta cuenta ya cambió 3 veces en la última hora."))).toBe("Esta cuenta ya cambió 3 veces en la última hora.");
  });
});
