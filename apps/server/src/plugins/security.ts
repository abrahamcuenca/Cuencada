/**
 * HTTP security headers (helmet + a strict CSP) and credentialed CORS.
 *
 * The CSP here applies to API responses. The SPA's HTML is served by nginx,
 * so WP-2.4 must send the same policy there: {@link contentSecurityPolicy}
 * renders the header value. The third-party weather widget is NOT allowed by
 * that policy; it lives in an isolated page under `/widgets/` with its own
 * policy, {@link widgetContentSecurityPolicy}.
 */
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { CSRF_HEADER } from "@cuencada/types";
import type { FastifyInstance } from "fastify";
import { type AppConfig, allowedOrigins } from "../config.js";

/** Origin of the legacy weather widget (script + its own iframe). Only `/widgets/*` may load it. */
export const WEATHER_WIDGET_ORIGIN = "https://weatherwidget.io";

type CspConfig = Pick<
  AppConfig,
  "NODE_ENV" | "APP_BASE_URL" | "CORS_ORIGIN" | "DEV_ALLOWED_ORIGINS" | "S3_ENDPOINT" | "S3_BUCKET" | "S3_PUBLIC_BASE_URL"
>;

function originOf(value: string): string | null {
  if (value === "") return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Origins the browser loads media from and uploads to: the bucket's own
 * virtual-hosted origin (`https://<bucket>.<region>.linodeobjects.com`, what
 * presigned URLs use) and any public base URL. The bare regional endpoint is
 * deliberately excluded: it is shared by every customer, so allowing it would
 * open an exfiltration channel to anyone's bucket via path-style URLs.
 */
export function storageOrigins(config: Pick<CspConfig, "S3_ENDPOINT" | "S3_BUCKET" | "S3_PUBLIC_BASE_URL">): string[] {
  const origins = new Set<string>();
  const endpoint = originOf(config.S3_ENDPOINT);
  if (endpoint !== null && config.S3_BUCKET !== "") {
    const url = new URL(endpoint);
    origins.add(`${url.protocol}//${config.S3_BUCKET}.${url.host}`);
  }
  const publicBase = originOf(config.S3_PUBLIC_BASE_URL);
  if (publicBase !== null) origins.add(publicBase);
  return [...origins];
}

/** `https://host` → `wss://host`, `http://host` → `ws://host`. */
function webSocketOrigin(origin: string): string {
  return origin.replace(/^http/, "ws");
}

/**
 * CSP directives (helmet format) for the app (API responses and the SPA
 * HTML). `default-src 'self'`, no plugins, no third-party script, framing only
 * of our own pages (`frame-src 'self'` for `/widgets/*`), media from the
 * bucket, and `connect-src` for the API, the chat WebSocket and direct
 * uploads. Dev origins (Vite) are added only outside production.
 *
 * @param config - Validated config.
 */
export function contentSecurityPolicyDirectives(config: CspConfig): Record<string, string[]> {
  const production = config.NODE_ENV === "production";
  const storage = storageOrigins(config);
  const appOrigins = [new URL(config.APP_BASE_URL).origin, ...config.CORS_ORIGIN];
  const devOrigins = production ? [] : config.DEV_ALLOWED_ORIGINS;
  const socketOrigins = [...new Set([...appOrigins, ...devOrigins].map(webSocketOrigin))];

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "base-uri": ["'self'"],
    "object-src": ["'none'"],
    "frame-ancestors": ["'none'"],
    "form-action": ["'self'"],
    "script-src": ["'self'"],
    "style-src": ["'self'"],
    "font-src": ["'self'"],
    "img-src": ["'self'", "data:", "blob:", ...storage],
    "media-src": ["'self'", "blob:", ...storage],
    "connect-src": ["'self'", ...socketOrigins, ...storage, ...devOrigins],
    "frame-src": ["'self'"],
    "worker-src": ["'self'"],
    "manifest-src": ["'self'"]
  };
  if (production) directives["upgrade-insecure-requests"] = [];
  return directives;
}

function renderPolicy(directives: Record<string, string[]>): string {
  return Object.entries(directives)
    .map(([name, values]) => [name, ...new Set(values)].join(" "))
    .join("; ");
}

/**
 * Render the app directives as a `Content-Security-Policy` header value (for
 * nginx on every SPA response except `/widgets/*`).
 *
 * @param config - Validated config.
 */
export function contentSecurityPolicy(config: CspConfig): string {
  return renderPolicy(contentSecurityPolicyDirectives(config));
}

/**
 * CSP directives for the isolated widget pages under `/widgets/*` (e.g.
 * `/widgets/clima.html`), which nginx serves with this policy instead of the
 * app policy. Verified against weatherwidget.io's loader in headless Chromium
 * (no violations): it only needs its script and its own iframe
 * (`https://weatherwidget.io/w/`), which fetches the forecast itself. The
 * loader sets styles through the CSSOM, which `style-src` does not govern, so
 * no `'unsafe-inline'` is needed as long as the page uses an external
 * `<script src>` (not the inline loader snippet) and no inline styles.
 */
export function widgetContentSecurityPolicyDirectives(): Record<string, string[]> {
  return {
    "default-src": ["'none'"],
    "script-src": [WEATHER_WIDGET_ORIGIN],
    "frame-src": [WEATHER_WIDGET_ORIGIN],
    "base-uri": ["'none'"],
    "form-action": ["'none'"],
    "frame-ancestors": ["'self'"]
  };
}

/** Render {@link widgetContentSecurityPolicyDirectives} as a header value (nginx, `/widgets/*` only). */
export function widgetContentSecurityPolicy(): string {
  return renderPolicy(widgetContentSecurityPolicyDirectives());
}

/**
 * Register helmet (strict CSP) and CORS for exactly the allowed origins with
 * credentials.
 *
 * @param app - Root instance.
 */
export async function registerSecurity(app: FastifyInstance): Promise<void> {
  await app.register(helmet, {
    contentSecurityPolicy: { useDefaults: false, directives: contentSecurityPolicyDirectives(app.config) },
    // Media is served from the bucket, not the API; keep the API same-origin only.
    crossOriginResourcePolicy: { policy: "same-origin" },
    referrerPolicy: { policy: "no-referrer" },
    // Matches CSP frame-ancestors 'none' for browsers that only honour X-Frame-Options.
    frameguard: { action: "deny" }
  });
  await app.register(cors, {
    origin: allowedOrigins(app.config),
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["content-type", "authorization", CSRF_HEADER],
    maxAge: 600
  });
}
