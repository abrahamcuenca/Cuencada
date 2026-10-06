import { describe, expect, it } from "vitest";
import { DEFAULT_AFTER_LOGIN_PATH, redirectPathFromState, safeRedirectPath } from "./redirect";

describe("safeRedirectPath", () => {
  it("keeps same-origin paths with a query", () => {
    expect(safeRedirectPath("/galeria/2026?foto=3")).toBe("/galeria/2026?foto=3");
  });

  it("falls back to / for open-redirect attempts and non-strings", () => {
    for (const value of [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "javascript:alert(1)",
      "galeria",
      "/ok\nLocation: x",
      "",
      42,
      null,
      undefined
    ]) {
      expect(safeRedirectPath(value), String(value)).toBe(DEFAULT_AFTER_LOGIN_PATH);
    }
  });
});

describe("redirectPathFromState", () => {
  it("reads a safe from path out of router state", () => {
    expect(redirectPathFromState({ from: "/directorio" })).toBe("/directorio");
  });

  it("falls back to / when state is missing or unsafe", () => {
    expect(redirectPathFromState(null)).toBe("/");
    expect(redirectPathFromState({ from: "//evil.example" })).toBe("/");
  });
});
