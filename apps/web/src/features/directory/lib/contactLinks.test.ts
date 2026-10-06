import { describe, expect, it } from "vitest";
import { internationalDigits, mailtoHref, telHref, whatsappHref } from "./contactLinks";

describe("whatsappHref", () => {
  it.each([
    ["+52 999 123 4567", "https://wa.me/529991234567"],
    ["+52 (999) 123-4567", "https://wa.me/529991234567"],
    ["999 123 4567", "https://wa.me/529991234567"],
    ["0052 999 123 4567", "https://wa.me/529991234567"],
    ["+1 (512) 555-0100", "https://wa.me/15125550100"],
    ["52 999 123 4567", "https://wa.me/529991234567"]
  ])("formats %s as %s", (phone, href) => {
    expect(whatsappHref(phone)).toBe(href);
  });

  it.each(["123", "", "+1234567890123456"])("returns null for %j, which can't be a full number", (phone) => {
    expect(whatsappHref(phone)).toBeNull();
  });
});

describe("telHref", () => {
  it("dials the international number", () => {
    expect(telHref("999 123 4567")).toBe("tel:+529991234567");
  });
});

describe("internationalDigits", () => {
  it("keeps a number typed with + as is", () => {
    expect(internationalDigits("+44 20 7946 0958")).toBe("442079460958");
  });
});

describe("mailtoHref", () => {
  it("links a plain address", () => {
    expect(mailtoHref("rosa@example.com")).toBe("mailto:rosa@example.com");
  });

  it.each(["rosa@example.com?bcc=otro@example.com", "a b@example.com", "rosa@example.com#x", "sin-arroba"])("refuses %s, which would add parameters or is not an address", (email) => {
    expect(mailtoHref(email)).toBeNull();
  });
});
