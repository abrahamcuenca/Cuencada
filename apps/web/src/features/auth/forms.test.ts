import { loginInputSchema, PASSWORD_BREACHED_MESSAGE } from "@cuencada/types";
import { describe, expect, it } from "vitest";
import {
  breachedPasswordError,
  CONFIRM_REQUIRED_MESSAGE,
  confirmError,
  describeAuthError,
  hasErrors,
  PASSWORDS_DIFFER_MESSAGE,
  passwordStrength,
  RATE_LIMITED_MESSAGE,
  validateForm
} from "./forms";

const apiFailure = (status: number, code: string, message = "Mensaje del servidor."): unknown => ({ status, data: { error: { code, message } } });

describe("validateForm", () => {
  it("returns the parsed data when the values are valid", () => {
    const result = validateForm(loginInputSchema, { email: " Prima@Example.com ", password: "x" });

    expect(result).toEqual({ ok: true, data: { email: "prima@example.com", password: "x" }, errors: {} });
  });

  it("keeps the first Spanish message per field when the values are invalid", () => {
    const result = validateForm(loginInputSchema, { email: "", password: "" });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual({ email: "Correo electrónico inválido.", password: "Escribe tu contraseña." });
    expect(hasErrors(result.errors)).toBe(true);
  });
});

describe("hasErrors", () => {
  it("ignores fields whose error is undefined", () => {
    expect(hasErrors({ email: undefined })).toBe(false);
  });
});

describe("confirmError", () => {
  it("asks for the confirmation when it is empty", () => {
    expect(confirmError("abc", "")).toBe(CONFIRM_REQUIRED_MESSAGE);
  });

  it("reports mismatched passwords and accepts matching ones", () => {
    expect(confirmError("abc", "abd")).toBe(PASSWORDS_DIFFER_MESSAGE);
    expect(confirmError("abc", "abc")).toBeUndefined();
  });
});

describe("breachedPasswordError", () => {
  const validation = (details: unknown[]): unknown => ({
    status: 400,
    data: { error: { code: "VALIDATION", message: "Revisa los datos enviados.", details } }
  });

  it("returns the Spanish message for a PASSWORD_BREACHED detail on the field", () => {
    const error = validation([{ path: "newPassword", message: "x", code: "PASSWORD_BREACHED" }]);
    expect(breachedPasswordError(error, "newPassword")).toBe(PASSWORD_BREACHED_MESSAGE);
    expect(breachedPasswordError(error, "password")).toBeUndefined();
  });

  it("ignores an unknown detail code but still parses the error (older client, newer server)", () => {
    const error = validation([{ path: "newPassword", message: "Otra razón.", code: "SOME_FUTURE_CODE" }]);
    expect(breachedPasswordError(error, "newPassword")).toBeUndefined();
    expect(describeAuthError(error)).toBe("Revisa los datos enviados.");
  });
});

describe("describeAuthError", () => {
  it("returns null for an abort so no error is shown", () => {
    expect(describeAuthError({ name: "AbortError", message: "Aborted" })).toBeNull();
  });

  it("always uses the rate-limit copy for 429", () => {
    expect(describeAuthError(apiFailure(429, "RATE_LIMITED"), { RATE_LIMITED: "otra cosa" })).toBe(RATE_LIMITED_MESSAGE);
  });

  it("prefers the override for a code over the server message", () => {
    expect(describeAuthError(apiFailure(401, "INVALID_CREDENTIALS"), { INVALID_CREDENTIALS: "Genérico." })).toBe("Genérico.");
  });

  it("falls back to the server message, then to the generic message", () => {
    expect(describeAuthError(apiFailure(409, "CONFLICT", "Ya existe."))).toBe("Ya existe.");
    expect(describeAuthError({ status: "FETCH_ERROR", error: "offline" })).toMatch(/Revisa tu conexión/);
  });
});

describe("passwordStrength", () => {
  it("counts the missing characters below 12", () => {
    expect(passwordStrength("abcdefghijk")).toMatchObject({ level: "short", label: "Te falta 1 carácter.", score: 0 });
    expect(passwordStrength("")).toMatchObject({ level: "short", label: "Te faltan 12 caracteres." });
  });

  it("rejects a password made only of spaces", () => {
    expect(passwordStrength("            ").label).toBe("No puede ser solo espacios.");
  });

  it("rates longer passwords higher", () => {
    expect(passwordStrength("a".repeat(12)).level).toBe("ok");
    expect(passwordStrength("a".repeat(16)).level).toBe("good");
    expect(passwordStrength("a".repeat(20)).level).toBe("strong");
  });

  it("flags a password over the maximum length", () => {
    expect(passwordStrength("a".repeat(129))).toMatchObject({ level: "short", score: 0 });
  });
});
