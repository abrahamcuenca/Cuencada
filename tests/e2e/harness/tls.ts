/**
 * Per-run self-signed certificate for the local object store (127.0.0.1).
 * Generated with the `openssl` CLI; never committed, wiped with the run dir.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Create a short-lived EC key + self-signed cert for `127.0.0.1`/`localhost`.
 *
 * @param dir - Output directory (created, mode 0700).
 * @returns PEM key and certificate.
 */
export function createSelfSignedCert(dir: string): { key: string; cert: string } {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "2",
      "-subj",
      "/CN=cuencada-e2e-storage",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
      "-keyout",
      keyPath,
      "-out",
      certPath
    ],
    { stdio: "ignore" }
  );
  return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") };
}
