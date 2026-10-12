/**
 * Two-step verification test helpers (WP-7). The secret below is a
 * **test-only** fixture (public repository): never use it anywhere real.
 */
import type { LightMyRequestResponse } from "fastify";
import { eq } from "drizzle-orm";
import type { App } from "../../src/app.js";
import { DEV_TOTP_ENCRYPTION_KEY } from "../../src/config.js";
import { userTotp } from "../../src/db/schema/index.js";
import { encryptSecret, totpCodeAt, totpKey } from "../../src/lib/totp.js";
import { getTestDb } from "./db.js";

/** Test-only base32 TOTP secret (fictional; the RFC 4648 example pattern). */
export const TEST_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

/**
 * Enroll a user directly in the database with {@link TEST_TOTP_SECRET},
 * encrypted with the dev/test key (the default `TOTP_ENCRYPTION_KEY` outside production).
 *
 * @param userId - The user.
 * @param secret - Override the secret.
 */
export async function enrollTwoFactor(userId: string, secret: string = TEST_TOTP_SECRET): Promise<void> {
  const encrypted = encryptSecret(totpKey({ TOTP_ENCRYPTION_KEY: DEV_TOTP_ENCRYPTION_KEY }), userId, secret);
  await getTestDb()
    .insert(userTotp)
    .values({
      userId,
      secretCiphertext: encrypted.ciphertext,
      secretIv: encrypted.iv,
      secretTag: encrypted.tag,
      enabledAt: new Date()
    });
}

/**
 * The current code of {@link TEST_TOTP_SECRET} (or `secret`) at the app's
 * clock. Clears the user's replay marker first, so helpers can log the same
 * user in several times within one 30-second step (test-only shortcut: the
 * replay rule itself is tested without it).
 *
 * @param app - The app (its clock).
 * @param userId - Whose replay marker to clear.
 * @param secret - Override the secret.
 */
export async function freshTotpCode(app: App, userId: string, secret: string = TEST_TOTP_SECRET): Promise<string> {
  await getTestDb().update(userTotp).set({ lastUsedStep: null }).where(eq(userTotp.userId, userId));
  return totpCodeAt(secret, app.clock.now());
}

/** The challenge token of a login response that asked for a code, or `null`. */
export function challengeTokenOf(response: LightMyRequestResponse): string | null {
  if (response.statusCode !== 200) return null;
  const body: unknown = response.json();
  if (typeof body !== "object" || body === null || !("twoFactorRequired" in body) || !("challengeToken" in body)) return null;
  return typeof body.challengeToken === "string" ? body.challengeToken : null;
}

/**
 * Finish a login that answered a challenge, with a fresh code.
 *
 * @param app - Test app.
 * @param userId - The user (to clear the replay marker).
 * @param challengeToken - From the login response.
 * @param headers - Extra request headers.
 * @param cookies - Request cookies (e.g. a trusted-device cookie).
 */
export async function answerChallenge(
  app: App,
  userId: string,
  challengeToken: string,
  headers: Record<string, string> = {},
  cookies: Record<string, string> = {}
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: "/api/auth/2fa/verify",
    headers,
    cookies,
    payload: { challengeToken, code: await freshTotpCode(app, userId) }
  });
}
