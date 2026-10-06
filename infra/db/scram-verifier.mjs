#!/usr/bin/env node
/**
 * Print a PostgreSQL SCRAM-SHA-256 password verifier for the password read
 * from stdin (WP-2.4, Security L2). Use it to set a role password without the
 * plain password ever reaching the server, its logs, shell history or `ps`:
 *
 *   read -rs PW && printf '%s' "$PW" | node infra/db/scram-verifier.mjs; unset PW
 *   # then, in psql as a superuser:
 *   ALTER ROLE cuencada_app PASSWORD 'SCRAM-SHA-256$4096:…';
 *
 * Interactive alternative: psql's `\password <role>` does the same client-side.
 * Accepts ASCII passwords only (the hex passwords the runbook generates), so
 * SASLprep normalization is the identity and the verifier matches what the
 * server computes.
 *
 * Format (RFC 5802/7677, as stored in pg_authid.rolpassword):
 *   SCRAM-SHA-256$<iterations>:<salt b64>$<StoredKey b64>:<ServerKey b64>
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

/** PostgreSQL's default `scram_iterations`. */
export const SCRAM_ITERATIONS = 4096;

/**
 * Compute the SCRAM-SHA-256 verifier for `password`.
 *
 * @param password - ASCII password.
 * @param salt - 16 random bytes (injectable for tests).
 * @param iterations - PBKDF2 iteration count.
 * @returns The verifier string PostgreSQL accepts in `ALTER ROLE … PASSWORD`.
 */
export function scramVerifier(password, salt = randomBytes(16), iterations = SCRAM_ITERATIONS) {
  if (password.length === 0 || !/^[\x20-\x7e]+$/.test(password)) {
    throw new Error("password must be non-empty printable ASCII");
  }
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const password = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  process.stdout.write(`${scramVerifier(password)}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`scram-verifier: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
