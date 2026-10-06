/**
 * Password hashing with argon2id and explicit OWASP parameters
 * (m = 19 MiB, t = 2, p = 1). Hashes created with other parameters still
 * verify (argon2 reads them from the hash); use {@link needsRehash} after a
 * successful login to upgrade them.
 */
import argon2 from "argon2";

/** OWASP Password Storage Cheat Sheet argon2id baseline. */
export const PASSWORD_HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1
} as const;

/**
 * Hash a new password.
 *
 * @param password - Plaintext; validate it with `passwordSchema` first.
 * @returns The encoded argon2id hash (includes salt and parameters).
 */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, PASSWORD_HASH_OPTIONS);
}

/**
 * Check a password against a stored hash.
 *
 * @param hash - Stored encoded hash.
 * @param password - Plaintext candidate.
 * @returns `true` on a match. A malformed stored hash counts as a mismatch.
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    // argon2 throws only for a hash it cannot parse; treat that as "no match"
    // so a corrupt row can never authenticate.
    return false;
  }
}

/**
 * Whether a stored hash uses weaker or different parameters than
 * {@link PASSWORD_HASH_OPTIONS} and should be replaced after a successful login.
 *
 * @param hash - Stored encoded hash.
 */
export function needsRehash(hash: string): boolean {
  try {
    return argon2.needsRehash(hash, PASSWORD_HASH_OPTIONS);
  } catch {
    return true;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Burn the same CPU/memory as a real verification when the user does not
 * exist (or has no password), so response time does not reveal which emails
 * have accounts. Always resolves `false`.
 *
 * @param password - The submitted password.
 */
export async function verifyDummyPassword(password: string): Promise<false> {
  dummyHash ??= argon2.hash("cuencada-dummy-password-for-timing", PASSWORD_HASH_OPTIONS);
  await verifyPassword(await dummyHash, password);
  return false;
}
