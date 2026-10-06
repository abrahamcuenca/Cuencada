#!/usr/bin/env node
/**
 * Post-deploy smoke test (WP-2.4). Read-mostly: it logs in, reads a few
 * member endpoints and opens one chat socket. It changes the password only
 * when SMOKE_NEW_PASSWORD is set (the first login of a must-change account).
 *
 *   SMOKE_BASE_URL=https://cuencada.com \
 *   SMOKE_EMAIL=admin@cuencada.com SMOKE_PASSWORD='…' \
 *   node scripts/deploy-smoke.mjs
 *
 * Options (env):
 *   SMOKE_BASE_URL       required. Origin of the site (nginx in front of the API).
 *   SMOKE_EMAIL / SMOKE_PASSWORD   account to log in with. Unset = public checks only.
 *   SMOKE_NEW_PASSWORD   if the account must change its password, change it to this.
 *   SMOKE_ORIGIN         Origin header for the API's CSRF/WS checks (default: SMOKE_BASE_URL's origin).
 *   SMOKE_STATIC=0       skip the SPA header checks (when hitting the API directly).
 *   SMOKE_HEALTH_PATH    default /healthz (nginx); /health when hitting the API directly.
 *   SMOKE_INSECURE_TLS=1 accept a self-signed certificate (local nginx test only).
 *
 * Never prints tokens, tickets, passwords or cookies. Exit code 1 on any failure.
 */

const env = process.env;
const baseUrl = env.SMOKE_BASE_URL;
if (!baseUrl) {
  process.stderr.write("deploy-smoke: set SMOKE_BASE_URL (e.g. https://cuencada.com)\n");
  process.exit(2);
}
if (env.SMOKE_INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const base = new URL(baseUrl);
const origin = env.SMOKE_ORIGIN ?? base.origin;
const checkStatic = env.SMOKE_STATIC !== "0";
const healthPath = env.SMOKE_HEALTH_PATH ?? "/healthz";
const https = base.protocol === "https:";

let failures = 0;

/** Record one check. */
function report(ok, name, detail = "") {
  if (!ok) failures += 1;
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}\n`);
}

/** fetch relative to the base URL, never following redirects. */
async function get(path, init = {}) {
  return fetch(new URL(path, base), { redirect: "manual", ...init });
}

/** Same-origin JSON API call with the CSRF marker and Origin the API expects. */
async function api(method, path, { token, body } = {}) {
  const headers = { origin, "x-cuencada-csrf": "1" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return get(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

const SPA_HEADERS = {
  "content-security-policy": (v) =>
    v.includes("default-src 'self'") && v.includes("frame-ancestors 'none'") && v.includes("base-uri 'none'"),
  "x-content-type-options": (v) => v === "nosniff",
  "x-frame-options": (v) => v === "DENY",
  "referrer-policy": (v) => v === "strict-origin-when-cross-origin",
  "permissions-policy": (v) => v.includes("camera=()"),
  ...(https ? { "strict-transport-security": (v) => v.startsWith("max-age=") } : {})
};

/** Check the security headers and Cache-Control of one static response. */
function checkSpaHeaders(name, response, cacheControl) {
  const problems = [];
  for (const [header, valid] of Object.entries(SPA_HEADERS)) {
    const value = response.headers.get(header);
    if (value === null || !valid(value)) problems.push(header);
  }
  const cache = response.headers.get("cache-control");
  if (cache !== cacheControl) problems.push(`cache-control=${cache}`);
  report(problems.length === 0, `${name} headers`, problems.join(", "));
}

async function staticChecks() {
  const home = await get("/");
  report(home.status === 200 && (home.headers.get("content-type") ?? "").includes("text/html"), "GET / is the SPA shell", String(home.status));
  checkSpaHeaders("GET /", home, "no-cache");

  const route = await get("/cuencada/2026");
  report(route.status === 200, "SPA fallback /cuencada/2026", String(route.status));

  const sw = await get("/sw.js");
  report(sw.status === 200, "GET /sw.js", String(sw.status));
  checkSpaHeaders("GET /sw.js", sw, "no-cache");

  const html = await home.text();
  const asset = html.match(/\/assets\/[^"']+\.js/)?.[0];
  if (asset) {
    const response = await get(asset);
    report(response.status === 200, "hashed asset", String(response.status));
    checkSpaHeaders("hashed asset", response, "public, max-age=31536000, immutable");
  } else {
    report(false, "hashed asset referenced from index.html");
  }

  const missing = await get("/assets/does-not-exist-w24.js");
  report(missing.status === 404, "missing asset is a 404, not the shell", String(missing.status));

  const legacy = await get("/cuencada2026.html");
  report(legacy.status === 301 && legacy.headers.get("location")?.endsWith("/cuencada/2026") === true, "legacy /cuencada2026.html redirects", String(legacy.status));
}

async function healthCheck() {
  const response = await get(healthPath);
  const body = response.status === 200 ? await response.json().catch(() => null) : null;
  report(response.status === 200 && body?.ok === true, `GET ${healthPath}`, String(response.status));
}

/** Open the chat socket with a fresh ticket and require it to stay open. */
async function chatSocket(token) {
  const ticketResponse = await api("POST", "/api/chat/ticket", { token });
  if (ticketResponse.status !== 201) {
    const code = (await ticketResponse.json().catch(() => null))?.error?.code ?? "";
    const hint = code === "EMAIL_UNVERIFIED" ? ", verify the account's email first" : "";
    report(false, "POST /api/chat/ticket", `${ticketResponse.status} ${code}${hint}`);
    return;
  }
  const { ticket, wsPath } = await ticketResponse.json();
  const url = new URL(wsPath ?? "/api/chat/ws", base);
  url.protocol = https ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);

  const outcome = await new Promise((resolve) => {
    // Node's WebSocket (undici) accepts extra handshake headers; the API checks Origin.
    const socket = new WebSocket(url, { headers: { origin } });
    const timer = setTimeout(() => {
      socket.close(1000);
      resolve({ ok: true, detail: "open for 3 s" });
    }, 3000);
    socket.addEventListener("close", (event) => {
      clearTimeout(timer);
      resolve({ ok: false, detail: `closed ${event.code}` });
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, detail: "handshake error" });
    });
  });
  report(outcome.ok, "chat WebSocket through the proxy", outcome.detail);
}

async function memberChecks() {
  const login = await api("POST", "/api/auth/login", { body: { email: env.SMOKE_EMAIL, password: env.SMOKE_PASSWORD } });
  report(login.status === 200, "POST /api/auth/login", String(login.status));
  if (login.status !== 200) return;
  let { accessToken, user } = await login.json();

  if (user.mustChangePassword) {
    if (!env.SMOKE_NEW_PASSWORD) {
      report(false, "account must change its password first", "set SMOKE_NEW_PASSWORD or change it in the browser");
      return;
    }
    const changed = await api("POST", "/api/auth/change-password", {
      token: accessToken,
      body: { currentPassword: env.SMOKE_PASSWORD, newPassword: env.SMOKE_NEW_PASSWORD }
    });
    report(changed.status === 200, "POST /api/auth/change-password", String(changed.status));
    if (changed.status !== 200) return;
    ({ accessToken, user } = await changed.json());
  }

  const me = await api("GET", "/api/me", { token: accessToken });
  report(me.status === 200, "GET /api/me", String(me.status));
  const noStore = me.headers.get("cache-control") ?? "";
  report(noStore.includes("no-store"), "API responses are no-store", noStore);

  const edition = await api("GET", "/api/cuencadas/2026", { token: accessToken });
  report(edition.status === 200, "GET /api/cuencadas/2026", String(edition.status));

  await chatSocket(accessToken);
}

await healthCheck();
if (checkStatic) await staticChecks();
if (env.SMOKE_EMAIL && env.SMOKE_PASSWORD) await memberChecks();
else process.stdout.write("SKIP  member checks (SMOKE_EMAIL / SMOKE_PASSWORD unset)\n");

process.stdout.write(failures === 0 ? "deploy-smoke: all checks passed\n" : `deploy-smoke: ${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
