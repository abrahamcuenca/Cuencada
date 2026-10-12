/**
 * TOTP primitives (WP-7) [SEC]: secret generation, RFC 6238 verification with
 * replay prevention (otplib v13), AES-256-GCM encryption of secrets at rest,
 * the `otpauth://` URI and its QR code (SVG, rendered here so the browser
 * makes no external request), and recovery codes.
 *
 * Parameters: SHA-1, 6 digits, 30 s step, window ±1 step (Google
 * Authenticator, 1Password, Authy, Microsoft Authenticator all agree on these).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  formatRecoveryCode,
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_LENGTH,
  TOTP_DIGITS,
  TOTP_ISSUER,
  TOTP_PERIOD_SECONDS,
  TOTP_WINDOW_STEPS
} from "@cuencada/types";
import { generate, generateSecret, generateURI, verify } from "otplib";
import { renderSVG } from "uqr";
import { type AppConfig, decodeTotpKey } from "../config.js";

/** Bytes of a TOTP secret (160 bits, the RFC 4226 recommendation). */
const SECRET_BYTES = 20;
/** AES-GCM nonce size (96 bits, the GCM standard). */
const IV_BYTES = 12;
/** AES-GCM tag size. */
const TAG_BYTES = 16;
const RECOVERY_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** An encrypted secret as stored in `user_totp` (base64 parts). */
export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  tag: string;
}

/** Raised when a stored secret cannot be decrypted (wrong key, tampering): fail closed. */
export class TotpDecryptionError extends Error {
  constructor() {
    super("TOTP secret could not be decrypted");
    this.name = "TotpDecryptionError";
  }
}

/**
 * The AES-256 key from the validated config.
 *
 * @param config - Needs `TOTP_ENCRYPTION_KEY` (validated by `loadConfig`).
 * @throws Error when the key does not decode (only reachable with a hand-built config).
 */
export function totpKey(config: Pick<AppConfig, "TOTP_ENCRYPTION_KEY">): Buffer {
  const key = decodeTotpKey(config.TOTP_ENCRYPTION_KEY);
  if (key === null) throw new Error("TOTP_ENCRYPTION_KEY is not a 32-byte key");
  return key;
}

/** Additional authenticated data: binds a ciphertext to its user (a swapped row fails to decrypt). */
function aad(userId: string): Buffer {
  return Buffer.from(`cuencada:totp:v1:${userId}`, "utf8");
}

/**
 * Encrypt a base32 secret for `userId` with a fresh nonce.
 *
 * @param key - 32-byte key ({@link totpKey}).
 * @param userId - Owner (bound as AAD).
 * @param secret - Base32 secret.
 */
export function encryptSecret(key: Buffer, userId: string, secret: string): EncryptedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(userId));
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

/**
 * Decrypt a stored secret.
 *
 * @param key - 32-byte key.
 * @param userId - Owner (must match the AAD it was encrypted with).
 * @param encrypted - Stored parts.
 * @throws TotpDecryptionError on a wrong key, another user's row or tampering.
 */
export function decryptSecret(key: Buffer, userId: string, encrypted: EncryptedSecret): string {
  try {
    const iv = Buffer.from(encrypted.iv, "base64");
    const tag = Buffer.from(encrypted.tag, "base64");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new TotpDecryptionError();
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(userId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new TotpDecryptionError();
  }
}

/** A new random base32 TOTP secret (160 bits). */
export function createTotpSecret(): string {
  return generateSecret({ length: SECRET_BYTES });
}

/** Outcome of {@link verifyTotpCode}. */
export type TotpVerification = { ok: true; step: number } | { ok: false };

/**
 * Verify a 6-digit code at `now` within ±1 step, refusing any step at or
 * below `lastUsedStep` (replay). Constant-time comparison (otplib).
 *
 * @param secret - Base32 secret.
 * @param code - Six digits (already validated by the contract).
 * @param now - Current time (`app.clock`).
 * @param lastUsedStep - `user_totp.last_used_step`, or `null`.
 * @returns The accepted step (store it as the new `last_used_step`).
 */
export async function verifyTotpCode(
  secret: string,
  code: string,
  now: Date,
  lastUsedStep: number | null
): Promise<TotpVerification> {
  if (!/^\d{6}$/.test(code)) return { ok: false };
  const result = await verify({
    secret,
    token: code,
    algorithm: "sha1",
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    epoch: Math.floor(now.getTime() / 1000),
    epochTolerance: TOTP_PERIOD_SECONDS * TOTP_WINDOW_STEPS,
    ...(lastUsedStep === null ? {} : { afterTimeStep: lastUsedStep })
  });
  // The functional API types HOTP and TOTP results together; only TOTP results carry `timeStep`.
  if (!result.valid || !("timeStep" in result) || typeof result.timeStep !== "number") return { ok: false };
  return { ok: true, step: result.timeStep };
}

/**
 * The code an authenticator shows at `at` (tests and the e2e harness only).
 *
 * @param secret - Base32 secret.
 * @param at - Instant.
 */
export function totpCodeAt(secret: string, at: Date): Promise<string> {
  return generate({
    secret,
    algorithm: "sha1",
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    epoch: Math.floor(at.getTime() / 1000)
  });
}

/**
 * The `otpauth://totp/Cuencada:<email>?secret=…&issuer=Cuencada` URI.
 *
 * @param accountName - Shown in the app (the email).
 * @param secret - Base32 secret.
 */
export function totpUri(accountName: string, secret: string): string {
  return generateURI({
    issuer: TOTP_ISSUER,
    label: accountName,
    secret,
    algorithm: "sha1",
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS
  });
}

/**
 * The QR code of `uri` as an SVG data URI (`img-src data:` is already allowed
 * by the CSP; no external request, no client library).
 *
 * @param uri - The otpauth URI.
 */
export function qrSvgDataUri(uri: string): string {
  const svg = renderSVG(uri, { ecc: "M", border: 2 });
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

/**
 * The secret in groups of four for manual entry (`ABCD EFGH …`).
 *
 * @param secret - Base32 secret.
 */
export function manualKey(secret: string): string {
  return secret.match(/.{1,4}/g)?.join(" ") ?? secret;
}

/**
 * {@link RECOVERY_CODE_COUNT} fresh recovery codes: 16 base32 characters
 * (80 bits) each, normalized (no dashes). Format with `formatRecoveryCode`.
 */
export function createRecoveryCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < RECOVERY_CODE_COUNT) {
    const bytes = randomBytes(RECOVERY_CODE_LENGTH);
    let code = "";
    // 256 is a multiple of 32: `byte % 32` is unbiased.
    for (const byte of bytes) code += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
    codes.add(code);
  }
  return [...codes];
}

/** Formatted codes for display (`xxxx-xxxx-xxxx-xxxx`). */
export function displayRecoveryCodes(codes: readonly string[]): string[] {
  return codes.map(formatRecoveryCode);
}

/**
 * SHA-256 of a normalized recovery code. 80 bits of entropy make an unsalted
 * fast hash safe here (like the opaque tokens), and the lookup stays O(1).
 *
 * @param normalized - Lowercase, no separators (`normalizeRecoveryCode`).
 */
export function hashRecoveryCode(normalized: string): string {
  return createHash("sha256").update(`cuencada-recovery:${normalized}`).digest("hex");
}
