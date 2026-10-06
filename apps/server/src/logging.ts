/**
 * Pino logger options with redaction [SEC].
 *
 * - Credentials in headers (`authorization`, `cookie`, `set-cookie`) and any
 *   `token`/`password`/`ticket`-like field are replaced with `[REDACTED]`.
 * - The request serializer logs a scrubbed URL: sensitive query parameters
 *   (the chat WebSocket `ticket`, any `token`) are redacted, so the one token
 *   that travels in a URL never reaches the logs.
 * - Request headers and bodies are not logged at all by default.
 */
import type { FastifyRequest, FastifyServerOptions } from "fastify";
import type { AppConfig } from "./config.js";

export const REDACTED = "[REDACTED]";

/** Query parameters whose values are always redacted from logged URLs. */
const SENSITIVE_QUERY_PARAMS = new Set(["ticket", "token", "t", "code", "key", "signature", "x-amz-signature"]);

/** Field names redacted wherever they appear (top level and two levels deep). */
const SENSITIVE_FIELDS = [
  "token",
  "accessToken",
  "refreshToken",
  "ticket",
  "password",
  "currentPassword",
  "newPassword",
  "passwordHash",
  "tokenHash",
  "secret",
  "authorization",
  "cookie"
];

/** Pino `redact.paths`. */
export const REDACT_PATHS: string[] = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-cuencada-csrf"]',
  'res.headers["set-cookie"]',
  "headers.authorization",
  "headers.cookie",
  'headers["set-cookie"]',
  ...SENSITIVE_FIELDS,
  ...SENSITIVE_FIELDS.map((field) => `*.${field}`),
  ...SENSITIVE_FIELDS.map((field) => `*.*.${field}`)
];

/**
 * Redact sensitive query parameter values from a request URL.
 *
 * @param rawUrl - Path plus query, e.g. `/api/chat/ws?ticket=abc`.
 * @returns The same URL with sensitive values replaced, e.g. `/api/chat/ws?ticket=[REDACTED]`.
 */
export function scrubUrl(rawUrl: string): string {
  const queryStart = rawUrl.indexOf("?");
  if (queryStart === -1) return rawUrl;
  const path = rawUrl.slice(0, queryStart);
  const query = rawUrl.slice(queryStart + 1);
  const scrubbed = query
    .split("&")
    .map((pair) => {
      const separator = pair.indexOf("=");
      const rawName = separator === -1 ? pair : pair.slice(0, separator);
      let name: string;
      try {
        name = decodeURIComponent(rawName.replace(/\+/g, " ")).toLowerCase();
      } catch {
        // Undecodable name: redact the whole pair rather than risk leaking it.
        return REDACTED;
      }
      return SENSITIVE_QUERY_PARAMS.has(name) ? `${rawName}=${REDACTED}` : pair;
    })
    .join("&");
  return `${path}?${scrubbed}`;
}

/** Request fields that are logged (no headers, no body). */
type LoggedRequest = {
  method: string;
  url: string;
  remoteAddress: string;
  remotePort: number;
};

/**
 * Fastify request serializer: method, scrubbed URL and client address.
 *
 * @param request - The Fastify request.
 */
export function serializeRequest(request: FastifyRequest): LoggedRequest {
  return {
    method: request.method,
    url: scrubUrl(request.url),
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort ?? 0
  };
}

/** A writable log sink (pino `DestinationStream`). */
export interface LogStream {
  write(message: string): void;
}

/** Options for {@link loggerOptions}. */
export interface LoggerOverrides {
  /** Write logs here instead of stdout (tests capture output this way). */
  stream?: LogStream;
}

/**
 * Fastify `logger` option for the environment. Tests get no logger unless a
 * stream is passed; development gets `pino-pretty` (a dev dependency).
 *
 * @param config - Needs `NODE_ENV` and `LOG_LEVEL`.
 * @param overrides - Optional capture stream.
 */
export function loggerOptions(
  config: Pick<AppConfig, "NODE_ENV" | "LOG_LEVEL">,
  overrides: LoggerOverrides = {}
): Exclude<FastifyServerOptions["logger"], undefined> {
  if (config.NODE_ENV === "test" && overrides.stream === undefined) return false;
  const base = {
    level: config.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    serializers: { req: serializeRequest }
  };
  if (overrides.stream !== undefined) return { ...base, stream: overrides.stream };
  if (config.NODE_ENV === "development") {
    return { ...base, transport: { target: "pino-pretty", options: { translateTime: "SYS:HH:MM:ss" } } };
  }
  return base;
}
