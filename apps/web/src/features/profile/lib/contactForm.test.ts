import { describe, expect, it } from "vitest";
import { emptyContacts, makeProfile } from "../testUtils";
import { buildContactsPatch, composePhone, HANDLE_URL_ERROR, looksLikeProfileUrl, splitPhone, toContactFormValues, websiteWarning } from "./contactForm";

const profile = makeProfile();
const withContacts = { ...profile, contacts: emptyContacts(profile) };
const baseline = toContactFormValues(withContacts);
const stored = { phone: null, whatsapp: null };

describe("splitPhone", () => {
  it("splits E.164 on the longest known calling code", () => {
    expect(splitPhone("+525512345678")).toEqual({ country: "52", number: "5512345678" });
    expect(splitPhone("+50212345678")).toEqual({ country: "502", number: "12345678" });
    expect(splitPhone("+12025550147")).toEqual({ country: "1", number: "2025550147" });
  });

  it("keeps an unknown code in the number and a legacy value as typed, with +52 preselected", () => {
    expect(splitPhone("+81312345678")).toEqual({ country: "52", number: "+81312345678" });
    expect(splitPhone("55 1234 5678")).toEqual({ country: "52", number: "55 1234 5678" });
    expect(splitPhone(null)).toEqual({ country: "52", number: "" });
  });
});

describe("composePhone", () => {
  it("prefixes the picked code unless the number carries its own", () => {
    expect(composePhone({ country: "52", number: " 55 1234 5678 " })).toBe("+52 55 1234 5678");
    expect(composePhone({ country: "52", number: "+1 202 555 0147" })).toBe("+1 202 555 0147");
    expect(composePhone({ country: "52", number: "0034612345678" })).toBe("0034612345678");
    expect(composePhone({ country: "52", number: "  " })).toBeNull();
  });
});

describe("looksLikeProfileUrl", () => {
  it.each(["https://instagram.com/prima", "instagram.com/prima", "www.tiktok.com/@prima", "facebook.com", "fb.me/prima", "linkedin.com/in/x"])(
    "flags %s",
    (value) => expect(looksLikeProfileUrl(value)).toBe(true)
  );

  it.each(["prima.ejemplo", "@prima_ejemplo", "prima-ejemplo", "prima.com.mx"])("accepts %s", (value) => expect(looksLikeProfileUrl(value)).toBe(false));
});

describe("websiteWarning", () => {
  it.each(["https://192.168.1.20", "https://localhost:8080", "https://nas.local/", "https://router.lan", "http://[::1]/"])("warns for %s", (value) =>
    expect(websiteWarning(value)).toMatch(/privada o numérica/)
  );

  it.each(["https://example.com", "", "no es url"])("is quiet for %s", (value) => expect(websiteWarning(value)).toBeNull());
});

describe("buildContactsPatch", () => {
  it("returns a null patch when nothing changed", () => {
    expect(buildContactsPatch(baseline, baseline, stored)).toEqual({ ok: true, patch: null });
  });

  it("normalizes the phone, follows it with WhatsApp and strips the @", () => {
    const values = { ...baseline, phone: { country: "52", number: "555 010 0101" }, instagram: " @prima.ejemplo " };
    expect(buildContactsPatch(baseline, values, stored)).toEqual({
      ok: true,
      patch: { phone: "+525550100101", whatsapp: "+525550100101", instagram: "prima.ejemplo" }
    });
  });

  it("counts a legacy stored phone as changed so saving confirms it", () => {
    const legacy = toContactFormValues({ ...withContacts, phone: "55 1234 5678" });
    expect(buildContactsPatch(legacy, legacy, { phone: "55 1234 5678", whatsapp: null })).toEqual({ ok: true, patch: { phone: "+525512345678" } });
  });

  it("clears a field with null and sends only the switches that changed", () => {
    const start = { ...baseline, github: "prima-ejemplo" };
    const values = { ...start, github: "", visibility: { ...start.visibility, github: true } };
    expect(buildContactsPatch(start, values, stored)).toEqual({ ok: true, patch: { github: null, visibility: { github: true } } });
  });

  it("reports a pasted link with the Spanish handle error and contract errors per field", () => {
    const values = { ...baseline, instagram: "https://instagram.com/prima", website: "ftp://example.com", phone: { country: "52", number: "12" } };
    expect(buildContactsPatch(baseline, values, stored)).toEqual({
      ok: false,
      errors: {
        instagram: HANDLE_URL_ERROR,
        website: "El sitio web debe ser una dirección https:// válida.",
        phone: "Teléfono inválido.",
        whatsapp: "Teléfono inválido."
      }
    });
  });
});
