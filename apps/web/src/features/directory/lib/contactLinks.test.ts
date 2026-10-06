import { describe, expect, it } from "vitest";
import { classifyPhone, internationalDigits, mailtoHref, telHref, whatsappHref } from "./contactLinks";

describe("whatsappHref", () => {
  it.each([
    ["+52 555 010 0101", "https://wa.me/525550100101"],
    ["+52 (555) 010-0101", "https://wa.me/525550100101"],
    ["0052 555 010 0101", "https://wa.me/525550100101"],
    ["+1 (512) 555-0100", "https://wa.me/15125550100"],
    ["52 555 010 0101", "https://wa.me/525550100101"]
  ])("formats %s as %s", (phone, href) => {
    expect(whatsappHref(phone)).toBe(href);
  });

  it.each(["123", "", "+1234567890123456"])("returns null for %j, which can't be a full number", (phone) => {
    expect(whatsappHref(phone)).toBeNull();
  });

  it.each(["555 010 0101", "(512) 555-0100", "9991234"])("returns null for %j: no country code, and none is assumed", (phone) => {
    expect(whatsappHref(phone)).toBeNull();
  });
});

describe("telHref", () => {
  it("dials the international number", () => {
    expect(telHref("+52 555 010 0101")).toBe("tel:+525550100101");
  });

  it("dials a number without a country code as typed (local call)", () => {
    expect(telHref("555 010 0101")).toBe("tel:5550100101");
    expect(telHref("123")).toBeNull();
  });
});

describe("internationalDigits", () => {
  it("keeps a number typed with + as is", () => {
    expect(internationalDigits("+44 20 7946 0958")).toBe("442079460958");
  });

  it("returns null for a 10-digit number without a country code", () => {
    expect(internationalDigits("555 010 0101")).toBeNull();
  });
});

describe("classifyPhone", () => {
  it("treats +, 00 and 11+ digits as international, shorter numbers as local", () => {
    expect(classifyPhone("+52 555 010 0101")).toEqual({ kind: "international", digits: "525550100101" });
    expect(classifyPhone("00 1 512 555 0100")).toEqual({ kind: "international", digits: "15125550100" });
    expect(classifyPhone("52 555 010 0101")).toEqual({ kind: "international", digits: "525550100101" });
    expect(classifyPhone("555 010 0101")).toEqual({ kind: "local", digits: "5550100101" });
    expect(classifyPhone("12 34")).toEqual({ kind: "invalid" });
    expect(classifyPhone("+12 34")).toEqual({ kind: "invalid" });
  });
});

describe("mailtoHref", () => {
  it("links a plain address", () => {
    expect(mailtoHref("rosa@example.com")).toBe("mailto:rosa@example.com");
  });

  it.each(["rosa@example.com?bcc=otro@example.com", "a b@example.com", "rosa@example.com#x", "rosa@example.com,otro@example.com", "rosa@example.com;otro@example.com", "sin-arroba"])("refuses %s, which would add parameters or is not an address", (email) => {
    expect(mailtoHref(email)).toBeNull();
  });
});
