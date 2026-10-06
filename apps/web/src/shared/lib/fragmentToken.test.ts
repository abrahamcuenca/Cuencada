import { afterEach, describe, expect, it } from "vitest";
import { clearFragmentToken, readAndScrubFragmentToken } from "./fragmentToken";

const TOKEN = "a".repeat(20) + "B_c-9".repeat(4);

function visit(url: string, state: unknown = null): void {
  window.history.replaceState(state, "", url);
}

afterEach(() => {
  clearFragmentToken();
  visit("/");
});

describe("readAndScrubFragmentToken", () => {
  it("returns the t token and removes the fragment while keeping path, query and history state", () => {
    const state = { usr: null, key: "abc", idx: 0 };
    visit(`/invitacion?utm=correo#t=${TOKEN}`, state);

    expect(readAndScrubFragmentToken()).toBe(TOKEN);
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(TOKEN);
    expect(`${window.location.pathname}${window.location.search}`).toBe("/invitacion?utm=correo");
    expect(window.history.state).toEqual(state);
  });

  it("does not add a history entry when scrubbing", () => {
    visit(`/restablecer#t=${TOKEN}`);
    const length = window.history.length;

    readAndScrubFragmentToken();

    expect(window.history.length).toBe(length);
  });

  it("returns the same token on a repeated call on the same page", () => {
    visit(`/verificar#t=${TOKEN}`);

    expect(readAndScrubFragmentToken()).toBe(TOKEN);
    expect(readAndScrubFragmentToken()).toBe(TOKEN);
  });

  it("forgets the token on another path or after clearFragmentToken", () => {
    visit(`/entrar/enlace#t=${TOKEN}`);
    readAndScrubFragmentToken();

    visit("/verificar");
    expect(readAndScrubFragmentToken()).toBeNull();

    visit(`/entrar/enlace#t=${TOKEN}`);
    readAndScrubFragmentToken();
    clearFragmentToken();
    expect(readAndScrubFragmentToken()).toBeNull();
  });

  it("scrubs the fragment but returns null for a missing or malformed token", () => {
    for (const hash of ["#otra=1", "#t=corto", `#t=${TOKEN}%3Cscript%3E`, `#t=${"x".repeat(257)}`]) {
      visit(`/invitacion${hash}`);
      expect(readAndScrubFragmentToken(), hash).toBeNull();
      expect(window.location.hash).toBe("");
    }
  });

  it("returns null when there is no fragment", () => {
    visit("/invitacion");
    expect(readAndScrubFragmentToken()).toBeNull();
  });
});
