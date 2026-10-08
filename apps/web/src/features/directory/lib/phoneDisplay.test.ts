import { describe, expect, it } from "vitest";
import { formatPhoneDisplay } from "./phoneDisplay";

describe("formatPhoneDisplay", () => {
  it("groups Mexican and US/Canada numbers as +cc 3-3-4", () => {
    expect(formatPhoneDisplay("+525550100144")).toBe("+52 555 010 0144");
    expect(formatPhoneDisplay("+12025550147")).toBe("+1 202 555 0147");
  });

  it("leaves other countries, odd lengths and non-E.164 text unchanged", () => {
    expect(formatPhoneDisplay("+34612345678")).toBe("+34612345678");
    expect(formatPhoneDisplay("+5255501001")).toBe("+5255501001");
    expect(formatPhoneDisplay("@prima.ejemplo")).toBe("@prima.ejemplo");
    expect(formatPhoneDisplay("555 010 0144")).toBe("555 010 0144");
  });
});
