import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEV_TOTP_ENCRYPTION_KEY } from "../config.js";
import {
  createRecoveryCodes,
  createTotpSecret,
  decryptSecret,
  displayRecoveryCodes,
  encryptSecret,
  hashRecoveryCode,
  manualKey,
  qrSvgDataUri,
  TotpDecryptionError,
  totpCodeAt,
  totpKey,
  totpUri,
  verifyTotpCode
} from "./totp.js";

const KEY = totpKey({ TOTP_ENCRYPTION_KEY: DEV_TOTP_ENCRYPTION_KEY });
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
/** A step boundary, so ±1 step is exact. */
const T0 = new Date(1_800_000_000 * 1000);
const STEP = 30_000;

describe("verifyTotpCode", () => {
  it("accepts the current step and one step on each side, and nothing further", async () => {
    const secret = createTotpSecret();
    const code = await totpCodeAt(secret, T0);
    const step = 1_800_000_000 / 30;
    await expect(verifyTotpCode(secret, code, T0, null)).resolves.toEqual({ ok: true, step });
    await expect(verifyTotpCode(secret, code, new Date(T0.getTime() + STEP), null)).resolves.toEqual({ ok: true, step });
    await expect(verifyTotpCode(secret, code, new Date(T0.getTime() - STEP), null)).resolves.toEqual({ ok: true, step });
    await expect(verifyTotpCode(secret, code, new Date(T0.getTime() + 2 * STEP), null)).resolves.toEqual({ ok: false });
    await expect(verifyTotpCode(secret, code, new Date(T0.getTime() - 2 * STEP), null)).resolves.toEqual({ ok: false });
  });

  it("rejects a step at or below the last used one (replay), but accepts a later one", async () => {
    const secret = createTotpSecret();
    const step = 1_800_000_000 / 30;
    const current = await totpCodeAt(secret, T0);
    await expect(verifyTotpCode(secret, current, T0, step)).resolves.toEqual({ ok: false });
    // The previous step's code is inside the window but older than the last use.
    const previous = await totpCodeAt(secret, new Date(T0.getTime() - STEP));
    await expect(verifyTotpCode(secret, previous, T0, step - 1)).resolves.toEqual({ ok: false });
    const next = await totpCodeAt(secret, new Date(T0.getTime() + STEP));
    await expect(verifyTotpCode(secret, next, T0, step)).resolves.toEqual({ ok: true, step: step + 1 });
  });

  it("rejects malformed codes without throwing", async () => {
    const secret = createTotpSecret();
    for (const code of ["", "12345", "1234567", "abcdef"]) {
      await expect(verifyTotpCode(secret, code, T0, null)).resolves.toEqual({ ok: false });
    }
  });
});

describe("secret encryption (AES-256-GCM)", () => {
  it("never stores the secret in clear and uses a fresh nonce every time", () => {
    const secret = createTotpSecret();
    const first = encryptSecret(KEY, USER, secret);
    const second = encryptSecret(KEY, USER, secret);
    expect(first.ciphertext).not.toContain(secret);
    expect(Buffer.from(first.ciphertext, "base64").toString("utf8")).not.toBe(secret);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(decryptSecret(KEY, USER, first)).toBe(secret);
  });

  it("fails closed with a wrong key, another user's row or a tampered tag", () => {
    const secret = createTotpSecret();
    const encrypted = encryptSecret(KEY, USER, secret);
    expect(() => decryptSecret(randomBytes(32), USER, encrypted)).toThrow(TotpDecryptionError);
    expect(() => decryptSecret(KEY, OTHER, encrypted)).toThrow(TotpDecryptionError);
    const tag = Buffer.from(encrypted.tag, "base64");
    tag[0] = (tag[0] ?? 0) ^ 1;
    expect(() => decryptSecret(KEY, USER, { ...encrypted, tag: tag.toString("base64") })).toThrow(TotpDecryptionError);
    expect(() => decryptSecret(KEY, USER, { ...encrypted, iv: "" })).toThrow(TotpDecryptionError);
  });

  it("never puts the secret in the error", () => {
    const secret = createTotpSecret();
    const encrypted = encryptSecret(KEY, USER, secret);
    try {
      decryptSecret(randomBytes(32), USER, encrypted);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });
});

describe("enrollment material", () => {
  it("builds an otpauth URI with the issuer, SHA-1, 6 digits and 30 s", () => {
    const secret = createTotpSecret();
    const uri = totpUri("ana@example.com", secret);
    expect(uri.startsWith("otpauth://totp/Cuencada:ana%40example.com?")).toBe(true);
    const params = new URL(uri).searchParams;
    expect(params.get("secret")).toBe(secret);
    expect(params.get("issuer")).toBe("Cuencada");
    expect(params.get("algorithm") ?? "SHA1").toBe("SHA1");
    expect(params.get("digits") ?? "6").toBe("6");
    expect(params.get("period") ?? "30").toBe("30");
  });

  it("renders the QR code as an SVG data URI and groups the manual key", () => {
    const qr = qrSvgDataUri("otpauth://totp/Cuencada:x?secret=ABC");
    expect(qr.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(Buffer.from(qr.split(",")[1] ?? "", "base64").toString("utf8")).toContain("<svg");
    expect(manualKey("ABCDEFGHIJ")).toBe("ABCD EFGH IJ");
  });
});

describe("recovery codes", () => {
  it("creates 10 unique 80-bit base32 codes, formatted in groups of four", () => {
    const codes = createRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[a-z2-7]{16}$/);
    expect(displayRecoveryCodes(codes)[0]).toMatch(/^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}$/);
  });

  it("hashes codes (stable, never containing the code)", () => {
    const [code = ""] = createRecoveryCodes();
    expect(hashRecoveryCode(code)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRecoveryCode(code)).toBe(hashRecoveryCode(code));
    expect(hashRecoveryCode(code)).not.toContain(code);
  });
});
