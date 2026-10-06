/**
 * HTTP security headers (helmet + a strict CSP) and credentialed CORS.
 *
 * The CSP here applies to API responses. The SPA's HTML is served by nginx,
 * so WP-2.4 must send the same policy there; {@link contentSecurityPolicy}
 * renders the header value for that purpose.
 */
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { CSRF_HEADER } from "@cuencada/types";
import type { FastifyInstance } from "fastify";
import { type AppConfig, allowedOrigins } from "../config.js";

/** Origins of the legacy weather widget (script + iframe). */
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
 * Origins the browser loads media from and uploads to: the S3 endpoint, its
 * virtual-hosted bucket origin (what presigned URLs use) and any public base URL.
 */
export function storageOrigins(config: Pick<CspConfig, "S3_ENDPOINT" | "S3_BUCKET" | "S3_PUBLIC_BASE_URL">): string[] {
  const origins = new Set<string>();
  const endpoint = originOf(config.S3_ENDPOINT);
  if (endpoint !== null) {
    origins.add(endpoint);
    if (config.S3_BUCKET !== "") {
      const url = new URL(endpoint);
      origins.add(`${url.protocol}//${config.S3_BUCKET}.${url.host}`);
    }
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
 * CSP directives (helmet format). `default-src 'self'`, no plugins, no
 * framing, scripts only from self and the weather widget, media from the
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
    "script-src": ["'self'", WEATHER_WIDGET_ORIGIN],
    "style-src": ["'self'"],
    "font-src": ["'self'"],
    "img-src": ["'self'", "data:", "blob:", ...storage],
    "media-src": ["'self'", "blob:", ...storage],
    "connect-src": ["'self'", ...socketOrigins, ...storage, ...devOrigins],
    "frame-src": [WEATHER_WIDGET_ORIGIN],
    "worker-src": ["'self'"],
    "manifest-src": ["'self'"]
  };
  if (production) directives["upgrade-insecure-requests"] = [];
  return directives;
}

/**
 * Render the directives as a `Content-Security-Policy` header value (for nginx).
 *
 * @param config - Validated config.
 */
export function contentSecurityPolicy(config: CspConfig): string {
  return Object.entries(contentSecurityPolicyDirectives(config))
    .map(([name, values]) => [name, ...new Set(values)].join(" "))
    .join("; ");
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
