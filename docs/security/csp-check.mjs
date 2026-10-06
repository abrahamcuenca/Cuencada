#!/usr/bin/env node
/**
 * SPA CSP verification harness (WP-2.3) [SEC].
 *
 * Serves the built SPA (`apps/web/dist`) with the HTML CSP from
 * `docs/security/csp.md` (the policy nginx must send in WP-2.4), proxies
 * `/api` (HTTP and the chat WebSocket) to the real built API running against
 * a scratch database, and drives headless Chromium through the main public,
 * member and admin routes. It fails if any page reports a
 * `securitypolicyviolation` or a CSP console error.
 *
 * Prerequisites: `pnpm build`, the test Postgres (`scripts/test-db.sh up`) and
 * Playwright's Chromium (`pnpm exec playwright install chromium`).
 *
 * Usage (repo root):
 *   CSP_CHECK_ADMIN_URL=postgres://cuencada:cuencada@127.0.0.1:55432/cuencada_test \
 *   node docs/security/csp-check.mjs
 *
 * `CSP_CHECK_ADMIN_URL` must point at a server where the harness may create and
 * drop the scratch database `w23_csp_check`. Only fictional fixtures are used.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** The SPA is rebuilt into a temp dir with the harness bucket as `VITE_MEDIA_UPLOAD_ORIGIN` (uploads need it). */
let DIST = "";
const SERVER_DIR = path.join(ROOT, "apps/server");
const requireFromServer = createRequire(path.join(SERVER_DIR, "package.json"));
const requireFromRoot = createRequire(path.join(ROOT, "package.json"));
const postgres = requireFromServer("postgres");
const { chromium } = requireFromRoot("@playwright/test");

const ADMIN_URL = process.env.CSP_CHECK_ADMIN_URL ?? "postgres://cuencada:cuencada@127.0.0.1:55432/cuencada_test";
const DB_NAME = "w23_csp_check";
const WEB_PORT = Number(process.env.CSP_CHECK_WEB_PORT ?? 47_310);
const API_PORT = Number(process.env.CSP_CHECK_API_PORT ?? 47_311);
const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
const BUCKET = "cuencada-csp-check";
const BUCKET_ORIGIN = `https://${BUCKET}.us-southeast-1.linodeobjects.com`;
const ADMIN_EMAIL = "admin@example.com";
const TEMP_PASSWORD = "contrasena-temporal-de-prueba-csp";
const PASSWORD = "contrasena-definitiva-de-prueba-csp";

/**
 * The production SPA policy, parsed from the `add_header Content-Security-Policy`
 * line in docs/security/csp.md, so the harness can never drift from the
 * documented string. For the local run only:
 * - `<bucket>` becomes the harness bucket name;
 * - `wss://cuencada.com` becomes the harness origin's `ws:` form;
 * - `upgrade-insecure-requests` is dropped: the harness serves plain
 *   `http://127.0.0.1`, and the directive would rewrite every same-origin
 *   subresource and API call to `https://`, which nothing listens on. In
 *   production the site is HTTPS-only (HSTS), so the directive changes
 *   nothing there.
 *
 * @param markdown - Contents of docs/security/csp.md.
 * @returns The production header value and the local variant.
 */
export function policiesFromDoc(markdown) {
  const match = /add_header Content-Security-Policy "([^"]+)" always;/.exec(markdown);
  if (match === null) throw new Error("csp.md: no add_header Content-Security-Policy line");
  const production = match[1];
  const local = production
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part !== "" && part !== "upgrade-insecure-requests")
    .join("; ")
    .replaceAll("<bucket>", BUCKET)
    .replaceAll("wss://cuencada.com", `ws://127.0.0.1:${WEB_PORT}`);
  return { production, local };
}

const CSP = policiesFromDoc(await readFile(path.join(ROOT, "docs/security/csp.md"), "utf8")).local;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".ico": "image/x-icon"
};

function log(message) {
  process.stdout.write(`[csp-check] ${message}\n`);
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("exit", (code) => (code === 0 ? resolve(output) : reject(new Error(`${args.join(" ")} exited ${code}\n${output}`))));
  });
}

function serverEnv(databaseUrl) {
  return {
    NODE_ENV: "development",
    DATABASE_URL: databaseUrl,
    MIGRATE_DATABASE_URL: databaseUrl,
    JWT_SECRET: "csp-check-secret-at-least-thirty-two-characters",
    APP_BASE_URL: WEB_ORIGIN,
    CORS_ORIGIN: WEB_ORIGIN,
    DEV_ALLOWED_ORIGINS: WEB_ORIGIN,
    HOST: "127.0.0.1",
    PORT: String(API_PORT),
    LOG_LEVEL: "warn",
    S3_ENDPOINT: "https://us-southeast-1.linodeobjects.com",
    S3_BUCKET: BUCKET,
    S3_ACCESS_KEY_ID: "AKIACSPCHECKFAKE",
    S3_SECRET_ACCESS_KEY: "csp-check-fake-secret",
    SEED_ADMIN_EMAIL: ADMIN_EMAIL,
    SEED_ADMIN_TEMP_PASSWORD: TEMP_PASSWORD,
    SEED_WHATSAPP_URL: "https://chat.whatsapp.com/EjemploFicticio",
    SEED_EXTERNAL_ALBUM_URL: "https://example.com/album-ficticio",
    SEED_LYRICS_URL: "https://example.com/letra-ficticia",
    SEED_PROGRAM_URL: "https://example.com/programa-ficticio"
  };
}

async function waitForPort(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise((resolve) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`port ${port} did not open`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Static SPA server with the CSP, proxying /api (HTTP + WebSocket upgrades) to the API. */
function startWebServer() {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", WEB_ORIGIN);
    if (url.pathname.startsWith("/api/")) {
      const upstream = http.request(
        { host: "127.0.0.1", port: API_PORT, method: request.method, path: request.url, headers: request.headers },
        (reply) => {
          response.writeHead(reply.statusCode ?? 502, reply.headers);
          reply.pipe(response);
        }
      );
      upstream.on("error", () => {
        response.writeHead(502).end();
      });
      request.pipe(upstream);
      return;
    }
    let file = path.join(DIST, decodeURIComponent(url.pathname));
    if (!file.startsWith(DIST)) {
      response.writeHead(400).end();
      return;
    }
    const info = await stat(file).catch(() => null);
    if (info === null || info.isDirectory()) file = path.join(DIST, "index.html");
    const body = await readFile(file);
    const headers = {
      "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin"
    };
    // nginx sends the policy on every SPA response (documents and the service worker script).
    headers["content-security-policy"] = CSP;
    response.writeHead(200, headers);
    response.end(body);
  });
  server.on("upgrade", (request, socket, head) => {
    const upstream = net.connect(API_PORT, "127.0.0.1", () => {
      const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        lines.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  return new Promise((resolve) => server.listen(WEB_PORT, "127.0.0.1", () => resolve(server)));
}

async function api(method, url, { token, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${API_PORT}${url}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${url}: ${response.status} ${text.slice(0, 200)}`);
  return text === "" ? null : JSON.parse(text);
}

const PUBLIC_ROUTES = ["/", "/cuencada/2026", "/entrar", "/recuperar", "/invitacion", "/no-existe"];
const MEMBER_ROUTES = [
  "/",
  "/cuencada/2026",
  "/perfil",
  "/perfil/sesiones",
  "/directorio",
  "/arbol",
  "/galeria/2026",
  "/chat",
  "/mas",
  "/admin",
  "/admin/usuarios",
  "/admin/invitaciones",
  "/admin/bitacora",
  "/admin/media",
  "/admin/cuencadas",
  "/admin/familia"
];

/**
 * Known, accepted violation: zod 4 probes `new Function("")` once (inside a
 * try/catch) to decide whether to JIT-compile parsers. CSP blocks it as
 * intended and zod falls back; the fix (`z.config({ jitless: true })` in the
 * web entry) is tracked in docs/coordination/backlog.md (WP-2.3 findings).
 */
function isKnownZodEvalProbe(violation) {
  return violation.directive === "script-src" && violation.blocked === "eval" && /\/assets\/index-[\w-]+\.js:/.test(violation.source ?? "");
}

async function visit(page, route, violations) {
  await page.goto(`${WEB_ORIGIN}${route}`, { waitUntil: "networkidle" });
  // Scroll so lazy content (the weather iframe) loads, then let chunks and the chat socket settle.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1000);
  const found = await page.evaluate(() => window.__cspViolations.splice(0));
  for (const violation of found) violations.push({ route, ...violation });
  return page.evaluate(() => document.querySelectorAll('iframe[src^="https://weatherwidget.io/"]').length);
}

async function main() {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  let apiProcess = null;
  let webServer = null;
  let browser = null;
  const databaseUrl = `${ADMIN_URL.replace(/\/[^/]*$/, "")}/${DB_NAME}`;
  const workDir = await mkdtemp(path.join(os.tmpdir(), "cuencada-csp-check-"));
  DIST = path.join(workDir, "dist");
  try {
    log("building the SPA with the harness bucket as upload origin");
    await run("pnpm", ["--filter", "@cuencada/web", "exec", "vite", "build", "--outDir", DIST, "--emptyOutDir"], {
      VITE_MEDIA_UPLOAD_ORIGIN: BUCKET_ORIGIN
    });
    await admin.unsafe(`drop database if exists ${DB_NAME} with (force)`);
    await admin.unsafe(`create database ${DB_NAME}`);
    const env = serverEnv(databaseUrl);
    log("migrating + seeding scratch database");
    await run("node", ["apps/server/dist/db/migrate.js"], env);
    await run("node", ["apps/server/dist/seed.js"], env);

    apiProcess = spawn("node", ["apps/server/dist/index.js"], { cwd: ROOT, env: { ...process.env, ...env }, stdio: "inherit" });
    await waitForPort(API_PORT);
    webServer = await startWebServer();

    // Finish the forced password change and verify the admin's email (fixture shortcut).
    const first = await api("POST", "/api/auth/login", { body: { email: ADMIN_EMAIL, password: TEMP_PASSWORD } });
    await api("POST", "/api/auth/change-password", {
      token: first.accessToken,
      body: { currentPassword: TEMP_PASSWORD, newPassword: PASSWORD }
    });
    const db = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    await db`update users set email_verified_at = now() where email = ${ADMIN_EMAIL}`;
    await db.end();

    browser = await chromium.launch();
    const context = await browser.newContext();
    await context.addInitScript(() => {
      window.__cspViolations = [];
      document.addEventListener("securitypolicyviolation", (event) => {
        window.__cspViolations.push({
          directive: event.effectiveDirective,
          blocked: event.blockedURI,
          sample: event.sample,
          source: `${event.sourceFile}:${event.lineNumber}`
        });
      });
    });
    const page = await context.newPage();
    const violations = [];
    let controlPhase = false;
    page.on("console", (message) => {
      if (!controlPhase && /Content Security Policy|Refused to/i.test(message.text())) {
        violations.push({ route: page.url(), console: message.text() });
      }
    });

    let weatherFrames = 0;
    for (const route of PUBLIC_ROUTES) weatherFrames += await visit(page, route, violations);
    log(`public routes checked: ${PUBLIC_ROUTES.join(", ")}`);

    await page.goto(`${WEB_ORIGIN}/entrar`, { waitUntil: "networkidle" });
    await page.getByLabel(/correo/i).first().fill(ADMIN_EMAIL);
    await page.getByLabel(/contraseña/i).first().fill(PASSWORD);
    await page.getByRole("button", { name: /entrar|iniciar/i }).first().click();
    await page.waitForURL((url) => !url.pathname.startsWith("/entrar"), { timeout: 15_000 });
    for (const route of MEMBER_ROUTES) weatherFrames += await visit(page, route, violations);
    log(`member/admin routes checked: ${MEMBER_ROUTES.join(", ")}`);
    log(`weather widget iframes rendered (frame-src exercised): ${weatherFrames}`);

    const swState = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return registration?.active?.state ?? registration?.installing?.state ?? registration?.waiting?.state ?? "none";
    });
    log(`service worker: ${swState}`);

    // Large-photo upload: a > 40 MP JPEG makes the gallery downscale it in the
    // resize module worker (worker-src 'self') before the upload intent.
    const workers = [];
    page.on("worker", (worker) => workers.push(worker.url()));
    const sharp = requireFromServer("sharp");
    const big = await sharp({ create: { width: 8000, height: 6000, channels: 3, background: "#0b5e55" } })
      .jpeg({ quality: 80 })
      .toBuffer();
    const bigPath = path.join(workDir, "foto-48mp.jpg");
    await writeFile(bigPath, big);
    await page.goto(`${WEB_ORIGIN}/galeria/2026`, { waitUntil: "networkidle" });
    await page.locator('[data-testid="gallery-file-input"]').setInputFiles(bigPath);
    // The review sheet: confirm the single file.
    await page.getByRole("button", { name: /^Subir$/ }).click({ timeout: 10_000 });
    const intents = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    let intent;
    for (let attempt = 0; attempt < 60 && intent === undefined; attempt += 1) {
      [intent] = await intents`select byte_size, mime_type from media_items where file_name = 'foto-48mp.jpg'`;
      if (intent === undefined) await page.waitForTimeout(500);
    }
    await intents.end();
    await page.waitForTimeout(1000);
    for (const violation of await page.evaluate(() => window.__cspViolations.splice(0))) {
      violations.push({ route: "/galeria/2026 (upload)", ...violation });
    }
    const resizeWorkers = workers.filter((url) => /\/assets\/resize\.worker-[\w-]+\.js$/.test(url));
    log(`resize worker loaded: ${resizeWorkers.join(", ") || "none"}`);
    log(
      intent === undefined
        ? "upload intent: none"
        : `upload intent: ${intent.mime_type}, ${intent.byte_size} bytes (original ${big.byteLength} bytes, 48 MP)`
    );
    if (resizeWorkers.length === 0 || intent === undefined) {
      log("FAIL: the large-photo upload did not go through the resize worker");
      process.exitCode = 1;
    }

    // Control: the instrumentation must see what the policy blocks.
    controlPhase = true;
    await page.evaluate(() => {
      const script = document.createElement("script");
      script.textContent = "window.__inline = 1";
      document.body.append(script);
      const image = document.createElement("img");
      image.src = "https://evil.example/pixel.png";
      document.body.append(image);
      const frame = document.createElement("iframe");
      frame.src = "https://example.com/";
      document.body.append(frame);
      const styled = document.createElement("div");
      styled.setAttribute("style", "color: red");
      document.body.append(styled);
    });
    await page.waitForTimeout(500);
    const control = await page.evaluate(() => window.__cspViolations.splice(0).map((v) => v.directive));
    const expectedControl = ["script-src-elem", "img-src", "frame-src", "style-src-attr"];
    const missing = expectedControl.filter((directive) => !control.includes(directive));
    log(`control violations seen: ${[...new Set(control)].join(", ")}`);
    if (missing.length > 0) {
      log(`FAIL: instrumentation did not see ${missing.join(", ")}`);
      process.exitCode = 1;
    }

    const known = violations.filter(isKnownZodEvalProbe);
    const unexpected = violations.filter((violation) => !isKnownZodEvalProbe(violation));
    if (known.length > 0) log(`known/accepted: ${known.length} zod eval probe(s) blocked (backlog: z.config({ jitless: true }))`);
    if (unexpected.length > 0) {
      log(`FAIL: ${unexpected.length} unexpected CSP violation(s)`);
      for (const violation of unexpected) log(JSON.stringify(violation));
      process.exitCode = 1;
    } else {
      log("OK: zero unexpected CSP violations");
    }
  } finally {
    await browser?.close();
    webServer?.close();
    apiProcess?.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await admin.unsafe(`drop database if exists ${DB_NAME} with (force)`).catch(() => {});
    await admin.end();
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
