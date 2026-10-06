/**
 * Deploy preflight (WP-2.4): checks, without any secret, that
 * `infra/project.yml`, `infra/nginx/cuencada.conf` and `docs/security/csp.md`
 * agree with each other and with what the server actually reads
 * (`config.ts`).
 *
 *   pnpm --filter @cuencada/server deploy:preflight      (mise run deploy-preflight)
 *
 * Every vault reference is replaced by a well-formed dummy and the resulting
 * environment goes through the real `loadConfig()` with production rules, so a
 * missing, misspelled or invalid variable fails here instead of crash-looping
 * the systemd unit. Exit code 1 when any problem is found.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { CONFIG_ENV_KEYS, ConfigError, loadConfig } from "../src/config.js";

/** Inputs of {@link runPreflight}, read from the repository by the CLI. */
export interface PreflightInput {
  /** Parsed `infra/project.yml`. */
  project: unknown;
  /** Text of `infra/nginx/cuencada.conf`. */
  nginxConf: string;
  /** Text of `docs/security/csp.md`. */
  cspDoc: string;
  /** Parsed `apps/server/package.json`. */
  serverPackage: unknown;
  /** Text of the Acleron nginx role's tasks, or `null` when the platform checkout wasn't found. */
  platformNginxTasks: string | null;
  /**
   * `CUENCADA_NGINX_MANUAL=1`: the operator installs the site by hand after
   * each deploy (interim fallback in docs/deploy/nginx.md), so a platform
   * without `site_template` support is a warning, not a blocker.
   */
  manualNginx?: boolean;
}

/** Outcome of {@link runPreflight}. */
export interface PreflightResult {
  /** Blocking: the deploy must not proceed. */
  problems: string[];
  /** Worth reading, not blocking. */
  warnings: string[];
  /** Vault variables `infra/project.yml` needs, sorted. */
  vaultRefs: string[];
}

/** Path of the project's own nginx site, relative to the repo root. */
export const NGINX_SITE_TEMPLATE = "infra/nginx/cuencada.conf";

/** Runtime variables that must come from the vault, never a literal. */
export const SECRET_ENV_KEYS = [
  "DATABASE_URL",
  "JWT_SECRET",
  "RESEND_API_KEY",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY"
] as const;

/** Config keys that may stay unmapped: ignored in production. */
const EXEMPT_CONFIG_KEYS = new Set(["DEV_ALLOWED_ORIGINS"]);

/** Non-config runtime variables allowed in `server.env`. */
const EXTRA_RUNTIME_KEYS = new Set(["UV_THREADPOOL_SIZE"]);

/**
 * Variables that must never reach the VPS: the owner-role migrate URL, the
 * seed's admin password and links (operator-only), test and drizzle switches.
 */
const FORBIDDEN_ENV = /^(MIGRATE_DATABASE_URL|TEST_DATABASE_URL|ALLOW_DRIZZLE_PUSH|SEED_.*)$/;

/** A whole value that is exactly one vault reference. */
const VAULT_REF = /^\{\{\s*(vault_cuencada_[a-z0-9_]+)\s*\}\}$/;

/** Linode bucket names: 3–63 lowercase letters, digits and hyphens. */
const BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/** Dummies for vault values: valid enough for `loadConfig`, obviously fake. */
function dummyFor(key: string): string {
  if (key === "DATABASE_URL") return "postgresql://preflight:preflight@127.0.0.1:5432/preflight";
  if (key === "JWT_SECRET") return "preflight-".repeat(5);
  return "preflight-placeholder";
}

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dict(value: unknown): Dict {
  return isDict(value) ? value : {};
}

/** `argv` list or string command as one string. */
function commandText(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(" ");
  return typeof value === "string" ? value : "";
}

/** Every `add_header <name> "<value>" always;` value in an nginx file. */
function headerValues(conf: string, name: string): string[] {
  const pattern = new RegExp(`add_header\\s+${name}\\s+"([^"]*)"\\s+always;`, "g");
  return [...conf.matchAll(pattern)].map((match) => match[1] ?? "");
}

/** Body of one `location <spec> { … }` block (no nested blocks in this file). */
function locationBlock(conf: string, spec: string): string | null {
  const start = conf.indexOf(`location ${spec} {`);
  if (start < 0) return null;
  const end = conf.indexOf("}", start);
  return end < 0 ? null : conf.slice(start, end);
}

/**
 * Validate `server.env` and run it through `loadConfig` with dummy secrets.
 *
 * @returns The validated config, or `null` when it can't be built.
 */
function checkServerEnv(
  project: Dict,
  problems: string[],
  vaultRefs: Set<string>
): ReturnType<typeof loadConfig> | null {
  const server = dict(project.server);
  const env = dict(server.env);
  if (Object.keys(env).length === 0) {
    problems.push("server.env is missing or empty");
    return null;
  }

  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") {
      problems.push(`server.env.${key} must be a quoted string (systemd and Ansible render YAML booleans/numbers unpredictably)`);
      continue;
    }
    if (FORBIDDEN_ENV.test(key)) {
      problems.push(`server.env.${key} must not be on the VPS (operator-only, see docs/deploy/runbook.md)`);
      continue;
    }
    if (!CONFIG_ENV_KEYS.includes(key) && !EXTRA_RUNTIME_KEYS.has(key)) {
      problems.push(`server.env.${key} is not read by the server (typo?)`);
      continue;
    }
    const ref = VAULT_REF.exec(value);
    if (ref?.[1] !== undefined) {
      vaultRefs.add(ref[1]);
      resolved[key] = dummyFor(key);
      continue;
    }
    if (value.includes("{{") || value.includes("{%")) {
      problems.push(`server.env.${key} must be a literal or exactly one {{ vault_cuencada_* }} reference (no filters or defaults)`);
      continue;
    }
    if (/[%"\\$]/.test(value)) {
      problems.push(`server.env.${key} contains %, ", \\ or $, which systemd Environment= lines mangle`);
    }
    resolved[key] = value;
  }

  for (const key of SECRET_ENV_KEYS) {
    const value = env[key];
    if (typeof value !== "string" || !VAULT_REF.test(value)) {
      problems.push(`server.env.${key} must be a {{ vault_cuencada_* }} reference, never a literal`);
    }
  }
  for (const key of CONFIG_ENV_KEYS) {
    if (!(key in env) && !EXEMPT_CONFIG_KEYS.has(key)) {
      problems.push(`server.env.${key} is not mapped (config.ts reads it; production must not fall back to its dev default)`);
    }
  }
  const threads = resolved.UV_THREADPOOL_SIZE;
  if (threads !== undefined && !(/^\d+$/.test(threads) && Number(threads) >= 4 && Number(threads) <= 16)) {
    problems.push("server.env.UV_THREADPOOL_SIZE must be an integer from 4 to 16");
  }

  try {
    return loadConfig(resolved);
  } catch (error) {
    if (error instanceof ConfigError) {
      for (const problem of error.problems) problems.push(`server.env fails loadConfig(): ${problem}`);
      return null;
    }
    throw error;
  }
}

/** Production invariants on the validated config. */
function checkProductionConfig(
  project: Dict,
  config: ReturnType<typeof loadConfig>,
  problems: string[]
): void {
  const domain = String(project.domain ?? "");
  const appOrigin = `https://${domain}`;
  const server = dict(project.server);

  if (config.NODE_ENV !== "production") problems.push("server.env.NODE_ENV must be production");
  if (config.HOST !== "127.0.0.1") problems.push("server.env.HOST must be 127.0.0.1 (nginx is the only way in)");
  if (config.PORT !== Number(server.port)) problems.push("server.env.PORT must equal server.port");
  if (config.APP_BASE_URL !== appOrigin) problems.push(`APP_BASE_URL must be ${appOrigin}`);
  if (config.CORS_ORIGIN.length !== 1 || config.CORS_ORIGIN[0] !== appOrigin) {
    problems.push(`CORS_ORIGIN must be exactly ${appOrigin} (www redirects to the apex)`);
  }
  if (!Array.isArray(config.TRUST_PROXY) || config.TRUST_PROXY.join(",") !== "loopback") {
    problems.push("TRUST_PROXY must be loopback (nginx on the same host, no CDN)");
  }
  if (!config.COOKIE_SECURE) problems.push("COOKIE_SECURE must be true");
  if (config.MAIL_FROM !== undefined && !config.MAIL_FROM.includes(`@${domain}>`)) {
    problems.push(`MAIL_FROM must send from the verified Resend domain ${domain}`);
  }
  if (!BUCKET_NAME.test(config.S3_BUCKET)) {
    problems.push(`S3_BUCKET "${config.S3_BUCKET}" is not set to a real bucket name (owner: replace <bucket> everywhere)`);
  }
  let endpointHost = "";
  try {
    const endpoint = new URL(config.S3_ENDPOINT);
    endpointHost = endpoint.host;
    if (endpoint.protocol !== "https:" || endpoint.origin !== config.S3_ENDPOINT) {
      problems.push("S3_ENDPOINT must be an https origin with no path");
    }
    if (!endpoint.hostname.startsWith(`${config.S3_REGION}.`)) problems.push("S3_ENDPOINT must be the S3_REGION endpoint");
  } catch {
    problems.push("S3_ENDPOINT is not a URL");
  }

  const buildEnv = dict(dict(project.deploy).build_env);
  for (const [key, value] of Object.entries(buildEnv)) {
    if (!key.startsWith("VITE_")) problems.push(`deploy.build_env.${key}: only public VITE_* values belong in the client build`);
    if (typeof value !== "string" || value.includes("{{")) {
      problems.push(`deploy.build_env.${key} must be a literal string (vault values are not available at build time)`);
    }
  }
  if (buildEnv.VITE_API_BASE_URL !== "/api") problems.push("deploy.build_env.VITE_API_BASE_URL must be /api");
  const uploadOrigin = `https://${config.S3_BUCKET}.${endpointHost}`;
  if (buildEnv.VITE_MEDIA_UPLOAD_ORIGIN !== uploadOrigin) {
    problems.push(`deploy.build_env.VITE_MEDIA_UPLOAD_ORIGIN must be ${uploadOrigin} (the presigner's virtual-host origin)`);
  }
}

/** The deploy contract around the release: bundle mode, migrations, health. */
function checkRelease(project: Dict, serverPackage: unknown, problems: string[]): void {
  const deploy = dict(project.deploy);
  const server = dict(project.server);
  if (deploy.mode !== "bundle") problems.push("deploy.mode must be bundle");
  if (typeof deploy.migrate_tunnel !== "string" || !/^127\.0\.0\.1:\d+$/.test(deploy.migrate_tunnel)) {
    problems.push("deploy.migrate_tunnel must be 127.0.0.1:<port> (the operator's SSH tunnel to Postgres)");
  }
  const build = commandText(deploy.build_command);
  if (/migrate|seed/.test(build)) problems.push("deploy.build_command must not migrate or seed");
  const migrate = commandText(server.migrate_command);
  if (!/@cuencada\/server db:migrate$/.test(migrate)) {
    problems.push("server.migrate_command must run the @cuencada/server db:migrate script");
  }
  if (/seed/.test(migrate)) problems.push("server.migrate_command must not seed (the seed is a one-off manual step)");
  const scripts = dict(dict(serverPackage).scripts);
  if (scripts["db:migrate"] !== "node dist/db/migrate.js") {
    problems.push('apps/server "db:migrate" must be "node dist/db/migrate.js" (the built migrator, no drizzle-kit)');
  }
  if (server.health_path !== "/health") problems.push("server.health_path must be /health (liveness only)");
  if (server.websocket !== true) problems.push("server.websocket must be true (chat)");
  if (project.canonical_redirect !== true) problems.push("canonical_redirect must be true (one origin for CORS/CSRF)");
  if (dict(project.nginx).site_template !== NGINX_SITE_TEMPLATE) {
    problems.push(`nginx.site_template must be ${NGINX_SITE_TEMPLATE}`);
  }
}

/** The nginx site against csp.md and the project. */
function checkNginx(project: Dict, input: PreflightInput, bucket: string, problems: string[]): void {
  const conf = input.nginxConf;
  const domain = String(project.domain ?? "");
  const port = String(dict(project.server).port ?? "");

  if (/\{\{|\{%|\{#/.test(conf)) problems.push("nginx: the site must contain no Jinja markers ({{ {% {#)");

  const documented = headerValues(input.cspDoc, "Content-Security-Policy")[0];
  if (documented === undefined) {
    problems.push("docs/security/csp.md has no add_header Content-Security-Policy line");
  } else {
    const expected = BUCKET_NAME.test(bucket) ? documented.replaceAll("<bucket>", bucket) : documented;
    const csps = headerValues(conf, "Content-Security-Policy");
    if (csps.length === 0) problems.push("nginx: no Content-Security-Policy header");
    if (csps.some((csp) => csp !== expected)) {
      problems.push("nginx: a Content-Security-Policy differs from docs/security/csp.md (paste it verbatim, bucket filled in)");
    }
    if (csps.some((csp) => csp.includes("<bucket>"))) problems.push("nginx: the CSP still has the <bucket> placeholder");
    // Every location that sends the CSP must carry the whole documented set
    // (nginx drops inherited add_header lines in a location with its own).
    for (const header of ["Strict-Transport-Security", "X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy", "Permissions-Policy"]) {
      const documentedValue = headerValues(input.cspDoc, header)[0];
      const values = headerValues(conf, header);
      if (values.length < csps.length || values.some((value) => value !== documentedValue)) {
        problems.push(`nginx: ${header} must accompany every CSP with the value from csp.md`);
      }
    }
  }
  const cacheControls = (conf.match(/add_header\s+Cache-Control\s+\$cuencada_cache_control\s+always;/g) ?? []).length;
  if (cacheControls !== headerValues(conf, "Content-Security-Policy").length) {
    problems.push("nginx: every static location needs add_header Cache-Control $cuencada_cache_control always");
  }

  if (conf.includes("$proxy_add_x_forwarded_for")) problems.push("nginx: X-Forwarded-For must be overwritten with $remote_addr, never appended");
  const proxies = conf.match(/^\s*proxy_pass\s+\S+;/gm) ?? [];
  const xff = conf.match(/^\s*proxy_set_header\s+X-Forwarded-For\s+\$remote_addr;/gm) ?? [];
  const cf = conf.match(/^\s*proxy_set_header\s+CF-Connecting-IP\s+"";/gm) ?? [];
  if (proxies.length === 0) problems.push("nginx: no proxy_pass to the API");
  if (xff.length !== proxies.length) problems.push("nginx: every proxied location must set X-Forwarded-For $remote_addr");
  if (cf.length !== proxies.length) problems.push('nginx: every proxied location must drop CF-Connecting-IP ("")');
  for (const proxy of proxies) {
    if (!proxy.includes(`http://127.0.0.1:${port}`)) problems.push(`nginx: ${proxy.trim()} must target 127.0.0.1:${port}`);
  }

  const logFormat = /log_format\s+cuencada_redacted\s+([\s\S]*?);/.exec(conf)?.[1];
  if (logFormat === undefined) {
    problems.push("nginx: log_format cuencada_redacted is missing");
  } else if (/\$(request|request_uri|args|query_string|http_referer|arg_[a-z_]+)\b/.test(logFormat)) {
    problems.push("nginx: the access log format must not log query strings ($request, $request_uri, $args, raw $http_referer)");
  }
  for (const line of conf.match(/^\s*access_log\s+[^;]+;/gm) ?? []) {
    if (!/access_log\s+off;/.test(line) && !/\scuencada_redacted;/.test(line)) {
      problems.push(`nginx: "${line.trim()}" must use the cuencada_redacted format`);
    }
  }

  const ws = locationBlock(conf, "= /api/chat/ws");
  if (ws === null) {
    problems.push("nginx: location = /api/chat/ws (chat WebSocket upgrade) is missing");
  } else {
    if (!/proxy_set_header\s+Upgrade\s+\$http_upgrade;/.test(ws)) problems.push("nginx: the chat socket must pass Upgrade");
    const timeout = Number(/proxy_read_timeout\s+(\d+)s;/.exec(ws)?.[1] ?? 0);
    if (timeout <= 25) problems.push("nginx: the chat socket proxy_read_timeout must exceed the 25 s ping");
  }
  if (!/location \^~ \/api\/ \{/.test(conf)) problems.push("nginx: the API needs location ^~ /api/");
  if (!/client_max_body_size\s+\d+[km];/.test(conf)) problems.push("nginx: client_max_body_size is missing");
  if (!conf.includes(`server_name ${domain};`)) problems.push(`nginx: no HTTPS server_name ${domain}`);
  const certName = String(dict(project.tls).cert_name ?? domain);
  if (!conf.includes(`/etc/letsencrypt/live/${certName}/fullchain.pem`)) problems.push("nginx: certificate path must use tls.cert_name");
  const root = String(dict(project.frontend).public_root ?? "");
  if (!conf.includes(`root  ${root};`) && !conf.includes(`root ${root};`)) problems.push("nginx: root must be frontend.public_root");
}

/**
 * Check the deploy configuration. Pure: all inputs are passed in.
 *
 * @param input - Repository files (see {@link PreflightInput}).
 * @returns Problems (blocking), warnings and the vault references needed.
 */
export function runPreflight(input: PreflightInput): PreflightResult {
  const problems: string[] = [];
  const warnings: string[] = [];
  const vaultRefs = new Set<string>();
  const project = dict(input.project);

  if (project.id !== "cuencada") problems.push("project.yml id must be cuencada");
  const config = checkServerEnv(project, problems, vaultRefs);
  if (config !== null) checkProductionConfig(project, config, problems);
  checkRelease(project, input.serverPackage, problems);
  const bucket = config?.S3_BUCKET ?? "";
  checkNginx(project, input, bucket, problems);

  if (input.platformNginxTasks === null) {
    warnings.push(
      "Acleron platform checkout not found (set ACLERON_PLATFORM_DIR): can't confirm it renders nginx.site_template"
    );
  } else if (!input.platformNginxTasks.includes("site_template")) {
    const message =
      "the Acleron nginx role ignores nginx.site_template: a deploy renders the stock site (chat WebSocket " +
      "broken, no SPA CSP, appended X-Forwarded-For, query strings in access logs)";
    if (input.manualNginx === true) {
      warnings.push(`${message}. CUENCADA_NGINX_MANUAL=1: install infra/nginx/cuencada.conf by hand right after the deploy.`);
    } else {
      problems.push(`${message}. Apply the platform change in docs/deploy/nginx.md first.`);
    }
  }

  return { problems, warnings, vaultRefs: [...vaultRefs].sort() };
}

/** Vault values the operator needs that are deliberately NOT in project.yml. */
export const OPERATOR_ONLY_VAULT_REFS = [
  "vault_cuencada_migrate_database_url (owner role, through the tunnel)",
  "vault_cuencada_seed_admin_temp_password",
  "vault_cuencada_seed_whatsapp_url / _external_album_url / _lyrics_url / _program_url (rotated links)"
] as const;

function main(): void {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const read = (path: string): string => readFileSync(resolve(repoRoot, path), "utf8");
  const platformDir = process.env.ACLERON_PLATFORM_DIR ?? resolve(repoRoot, "../acleron-platform/acleron-platform");
  let platformNginxTasks: string | null = null;
  try {
    platformNginxTasks = readFileSync(resolve(platformDir, "ansible/roles/nginx/tasks/main.yml"), "utf8");
  } catch {
    platformNginxTasks = null;
  }

  const result = runPreflight({
    project: parseYaml(read("infra/project.yml")),
    nginxConf: read(NGINX_SITE_TEMPLATE),
    cspDoc: read("docs/security/csp.md"),
    serverPackage: JSON.parse(read("apps/server/package.json")),
    platformNginxTasks,
    manualNginx: process.env.CUENCADA_NGINX_MANUAL === "1"
  });

  const out = process.stdout;
  out.write("deploy-preflight: vault values infra/project.yml needs (in ~/.acleron/vault-server_1.yml):\n");
  for (const ref of result.vaultRefs) out.write(`  - ${ref}\n`);
  out.write("operator-only vault values (never on the VPS):\n");
  for (const ref of OPERATOR_ONLY_VAULT_REFS) out.write(`  - ${ref}\n`);
  for (const warning of result.warnings) out.write(`WARN  ${warning}\n`);
  for (const problem of result.problems) out.write(`FAIL  ${problem}\n`);
  out.write(
    result.problems.length === 0
      ? "deploy-preflight: OK\n"
      : `deploy-preflight: ${result.problems.length} problem(s); fix them before building a bundle\n`
  );
  process.exitCode = result.problems.length === 0 ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
