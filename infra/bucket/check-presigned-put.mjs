#!/usr/bin/env node
/**
 * Real-bucket check (WP-2.4): the bucket must enforce what the presigned PUT
 * signs. Uses the server's own S3Storage (built), so it presigns exactly like
 * production does.
 *
 *   pnpm build
 *   # keys pasted without echo (zsh and bash; never `read -p`, it fails in zsh)
 *   printf 'runtime access key: '; read -rs S3_ACCESS_KEY_ID; echo
 *   printf 'runtime secret key: '; read -rs S3_SECRET_ACCESS_KEY; echo
 *   export S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY
 *   S3_ENDPOINT=https://us-east-1.linodeobjects.com S3_REGION=us-east-1 \
 *   S3_BUCKET=cuencada node infra/bucket/check-presigned-put.mjs
 *   unset S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY
 *
 * Checks, against the real bucket:
 *   1. control: the signed type and length upload (200)
 *   2. a body one byte longer than signed is rejected (403)
 *   3. a different Content-Type than signed is rejected (403)
 *   4. an unsigned GET of the object is refused (private bucket)
 *   5. CORS: a preflight from https://cuencada.com is allowed for PUT with
 *      content-type; one from another origin is not
 * Then deletes the probe object. Writes only under `_preflight/`. Never prints
 * credentials or signed URLs. Exit code 1 on any failure.
 */
import { randomUUID } from "node:crypto";
import { S3Storage } from "../../apps/server/dist/lib/storage/s3.js";

const settings = {
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? "",
  S3_REGION: process.env.S3_REGION ?? "us-east-1",
  S3_BUCKET: process.env.S3_BUCKET ?? "",
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? "",
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? ""
};
for (const [key, value] of Object.entries(settings)) {
  if (value === "") {
    process.stderr.write(`check-presigned-put: set ${key}\n`);
    process.exit(2);
  }
}
const APP_ORIGIN = process.env.CHECK_APP_ORIGIN ?? "https://cuencada.com";
const FOREIGN_ORIGIN = "https://evil.example";

const storage = new S3Storage(settings);
const key = `_preflight/${randomUUID()}.jpg`;
const size = 1024;
const body = new Uint8Array(size).fill(0xab);
let failures = 0;

function report(ok, name, detail) {
  if (!ok) failures += 1;
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}  (${detail})\n`);
}

async function put(contentType, bytes) {
  const signed = await storage.presignPut({ key, contentType: "image/jpeg", contentLength: size, expiresInSeconds: 120 });
  const response = await fetch(signed.url, { method: "PUT", headers: { "content-type": contentType }, body: bytes });
  await response.arrayBuffer();
  return response.status;
}

async function preflight(origin) {
  const signed = await storage.presignPut({ key, contentType: "image/jpeg", contentLength: size, expiresInSeconds: 120 });
  const response = await fetch(signed.url, {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": "PUT",
      "access-control-request-headers": "content-type"
    }
  });
  await response.arrayBuffer();
  return response.headers.get("access-control-allow-origin");
}

try {
  const longer = await put("image/jpeg", new Uint8Array(size + 1).fill(0xab));
  report(longer === 403, "a body longer than signed is rejected", `HTTP ${longer}`);

  const wrongType = await put("image/png", body);
  report(wrongType === 403, "a Content-Type other than signed is rejected", `HTTP ${wrongType}`);

  const control = await put("image/jpeg", body);
  report(control === 200, "control: the signed type and length upload", `HTTP ${control}`);

  const endpoint = new URL(settings.S3_ENDPOINT);
  const anonymous = await fetch(`${endpoint.protocol}//${settings.S3_BUCKET}.${endpoint.host}/${key}`);
  await anonymous.arrayBuffer();
  report(anonymous.status === 403, "an unsigned GET is refused (bucket is private)", `HTTP ${anonymous.status}`);

  const allowed = await preflight(APP_ORIGIN);
  report(allowed === APP_ORIGIN, `CORS preflight from ${APP_ORIGIN} is allowed`, `allow-origin ${allowed ?? "none"}`);
  const foreign = await preflight(FOREIGN_ORIGIN);
  report(foreign === null, "CORS preflight from a foreign origin is not allowed", `allow-origin ${foreign ?? "none"}`);
} finally {
  await storage.delete(key).catch((error) => {
    process.stderr.write(`check-presigned-put: could not delete ${key}: ${error?.name ?? "error"}\n`);
  });
}

process.stdout.write(failures === 0 ? "check-presigned-put: OK\n" : `check-presigned-put: ${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
