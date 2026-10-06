/**
 * Pino logger options with redaction [SEC].
 *
 * - Every logged object is scrubbed recursively (any depth, case-insensitive):
 *   keys containing `token`, `password`, `ticket`, `secret`, `authorization`,
 *   `cookie`, `hash`, `apikey` or `credential` are replaced with `[REDACTED]`.
 * - Errors go through {@link serializeError}: database errors keep only the
 *   SQL text and the Postgres code/constraint/table/column/schema, never the
 *   bound parameters (`params`, `detail`, `where`), which carry emails,
 *   password hashes and token hashes.
 * - The request serializer logs a scrubbed URL: only allowlisted query
 *   parameters (enums, limits, opaque ids) keep their value; everything else
 *   (the chat WebSocket `ticket`, free-text searches, cursors) is redacted.
 * - Request headers and bodies are not logged at all by default.
 */
import type { FastifyRequest, FastifyServerOptions } from "fastify";
import {
  AnnouncementScope,
  AuditAction,
  AuditEntityType,
  InviteStatus,
  MediaKind,
  MediaUploadStatus,
  ModerationStatus,
  UserRole,
  UserStatus
} from "@cuencada/types";
import type { AppConfig } from "./config.js";

export const REDACTED = "[REDACTED]";

/** Accepts one value of an allowlisted query parameter. */
type QueryValueCheck = (value: string) => boolean;

/** A value from a fixed set (an enum of the contracts). */
function oneOf(...groups: ReadonlyArray<Record<string, string>>): QueryValueCheck {
  const allowed = new Set(groups.flatMap((group) => Object.values(group)));
  return (value) => allowed.has(value);
}

/** Up to six digits (limits, depths, years). */
const digits: QueryValueCheck = (value) => /^\d{1,6}$/.test(value);

/** `true` / `false` query booleans. */
const booleanFlag: QueryValueCheck = (value) => value === "true" || value === "false";

/** Plain base64url (no `.`, `:` or `=`): the chat history cursor. */
const base64url: QueryValueCheck = (value) => /^[A-Za-z0-9_-]{1,512}$/.test(value);

/**
 * Query parameters whose values may be logged [SEC], each with the exact
 * shape its value must have. This is an ALLOWLIST: every other parameter's
 * value becomes `[REDACTED]`, so free text (`q`, `search`, `city`,
 * `familyBranch`), cursors and tokens (`ticket`, `token`, `cursor`) never
 * reach the logs, including parameters added later that nobody remembered
 * to deny. An allowlisted parameter whose value fails its check is redacted
 * too (a client can put any text in any parameter).
 *
 * `before` is the chat history cursor, `(created_at, id)` base64url-encoded,
 * which carries no personal data. Matching is exact (case-sensitive) on the
 * decoded name, because that is how the routes read them; `Limit`, `q[]` or
 * `limit[]` are therefore not allowlisted.
 */
const LOGGABLE_QUERY_PARAMS: ReadonlyMap<string, QueryValueCheck> = new Map([
  ["limit", digits],
  ["year", digits],
  ["depth", digits],
  ["status", oneOf(UserStatus, InviteStatus)],
  ["role", oneOf(UserRole)],
  ["kind", oneOf(MediaKind)],
  ["scope", oneOf(AnnouncementScope)],
  ["entityType", oneOf(AuditEntityType)],
  ["action", oneOf(AuditAction)],
  ["moderationStatus", oneOf(ModerationStatus)],
  ["uploadStatus", oneOf(MediaUploadStatus)],
  ["reported", booleanFlag],
  ["emailVerified", booleanFlag],
  ["before", base64url]
]);

/**
 * Names of the API's other query parameters. Their values are always
 * redacted, but the name is logged (`q=[REDACTED]`) for observability. Any
 * name in neither list is logged as `[param]=[REDACTED]`: a client could
 * put data in a parameter name too.
 */
const KNOWN_QUERY_PARAM_NAMES: ReadonlySet<string> = new Set([
  "q",
  "search",
  "cursor",
  "ticket",
  "token",
  "city",
  "familyBranch",
  "personId",
  "actorUserId",
  "entityId",
  "cuencadaId",
  "from",
  "to"
]);

/** Logged in place of a parameter name that is neither allowlisted nor known. */
export const UNKNOWN_QUERY_PARAM = "[param]";

/** Object keys whose values never reach the logs (case-insensitive, substring). */
export const SENSITIVE_LOG_KEY = /token|password|passwd|ticket|secret|authorization|cookie|hash|api[-_]?key|credential/i;

const MAX_SCRUB_DEPTH = 32;

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-copy a value, replacing the value of every sensitive key (see
 * {@link SENSITIVE_LOG_KEY}) with `[REDACTED]`. Errors are serialized with
 * {@link serializeError}; non-plain objects (class instances, buffers) are
 * reduced to their type name so nothing unexpected is walked or dumped.
 *
 * @param value - Anything about to be logged.
 */
export function scrubForLog(value: unknown): unknown {
  return scrubValue(value, 0, new WeakSet());
}

function scrubValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) return serializeErrorInner(value, depth, seen);
  if (value instanceof Date) return value;
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_SCRUB_DEPTH) return "[TRUNCATED]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1, seen));
  if (!isPlainObject(value)) return `[${value.constructor?.name ?? "Object"}]`;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = SENSITIVE_LOG_KEY.test(key) ? REDACTED : scrubValue(item, depth + 1, seen);
  }
  return result;
}

/** The Postgres error fields that are safe to log (no values). */
const SAFE_PG_FIELDS = {
  code: "code",
  constraint_name: "constraint",
  table_name: "table",
  column_name: "column",
  schema_name: "schema",
  routine: "routine",
  severity: "severity"
} as const;

/** Own properties that are never copied from an error (they can embed bound values). */
const UNSAFE_ERROR_KEYS = new Set([
  "message",
  "stack",
  "name",
  "cause",
  "params",
  "parameters",
  "args",
  "detail",
  "where",
  "hint",
  "internal_query",
  "query",
  "types"
]);

/** A database error: Drizzle's `DrizzleQueryError` or a postgres-js `PostgresError`. */
function isDatabaseError(error: Error): boolean {
  const record = error as unknown as Record<string, unknown>; // reading optional properties of an Error for detection
  return (
    error.name === "DrizzleQueryError" ||
    error.constructor?.name === "DrizzleQueryError" ||
    error.name === "PostgresError" ||
    (typeof record.query === "string" && ("params" in record || "parameters" in record))
  );
}

function stackFrames(stack: string | undefined): string {
  if (stack === undefined) return "";
  return stack
    .split("\n")
    .filter((line) => line.trimStart().startsWith("at "))
    .join("\n");
}

/** Shape of a serialized error (what Fastify's logger types expect). */
export type SerializedError = { [key: string]: unknown; type: string; message: string; stack: string };

function serializeDatabaseError(error: Error): SerializedError {
  const record = error as unknown as Record<string, unknown>; // reading optional properties of an Error
  const cause = record.cause;
  const pgSource: Record<string, unknown> =
    error.name === "PostgresError"
      ? record
      : typeof cause === "object" && cause !== null
        ? (cause as Record<string, unknown>) // the postgres-js error Drizzle wraps
        : {};
  const query =
    typeof record.query === "string" ? record.query : typeof pgSource.query === "string" ? pgSource.query : undefined;
  const result: SerializedError = {
    type: error.constructor?.name ?? error.name,
    // Only the SQL text with $n placeholders; the values are never logged.
    message: query === undefined ? "database error" : `Failed query: ${query}`,
    // Stack frames only: the first line of a Drizzle stack repeats the message with params.
    stack: stackFrames(error.stack)
  };
  for (const [source, target] of Object.entries(SAFE_PG_FIELDS)) {
    const value = pgSource[source];
    if (typeof value === "string") result[target] = value;
  }
  return result;
}

function serializeErrorInner(error: Error, depth: number, seen: WeakSet<object>): SerializedError {
  if (seen.has(error)) return { type: error.name, message: "[Circular]", stack: "" };
  seen.add(error);
  if (isDatabaseError(error)) return serializeDatabaseError(error);

  const result: SerializedError = {
    type: error.constructor?.name ?? error.name,
    message: error.message,
    stack: `${error.name}: ${error.message}\n${stackFrames(error.stack)}`
  };
  for (const [key, value] of Object.entries(error)) {
    if (UNSAFE_ERROR_KEYS.has(key)) continue;
    result[key] = SENSITIVE_LOG_KEY.test(key) ? REDACTED : scrubValue(value, depth + 1, seen);
  }
  const cause: unknown = error.cause;
  if (cause !== undefined && depth < MAX_SCRUB_DEPTH) {
    result.cause = cause instanceof Error ? serializeErrorInner(cause, depth + 1, seen) : scrubValue(cause, depth + 1, seen);
  }
  return result;
}

/**
 * Pino `err` serializer. Database errors keep only `{ type, message: <SQL
 * without params>, code, constraint, table, column, schema, routine,
 * severity, stack frames }`. Other errors keep `type`, `message`, `stack`
 * and their own properties with sensitive keys redacted at any depth, plus
 * a serialized `cause`.
 *
 * @param error - Usually an `Error`; anything else is scrubbed as data.
 */
export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) return serializeErrorInner(error, 0, new WeakSet());
  return { type: typeof error, message: "non-error value thrown", stack: "", value: scrubForLog(error) };
}

/** Keys whose values Fastify passes raw and dedicated serializers handle. */
const SERIALIZED_KEYS = new Set(["req", "res", "err", "error"]);

/**
 * Pino `formatters.log`: scrub every key of the merging object except the
 * ones handled by serializers (`req`, `res`, `err`, `error`).
 *
 * @param object - The object passed to `log.info(object, msg)`.
 */
export function scrubLogObject(object: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(object)) {
    if (SENSITIVE_LOG_KEY.test(key)) result[key] = REDACTED;
    else if (SERIALIZED_KEYS.has(key)) result[key] = value;
    else result[key] = scrubForLog(value);
  }
  return result;
}

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

/** Decode a query-string component (`+` is a space), or `undefined` if malformed. */
function decodeQueryComponent(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return undefined;
  }
}

/** Scrub one `name=value` pair of a query string (see {@link scrubUrl}). */
function scrubQueryPair(pair: string): string {
  if (pair === "") return pair;
  const separator = pair.indexOf("=");
  const rawName = separator === -1 ? pair : pair.slice(0, separator);
  const name = decodeQueryComponent(rawName);
  const check = name === undefined ? undefined : LOGGABLE_QUERY_PARAMS.get(name);
  if (name === undefined || (check === undefined && !KNOWN_QUERY_PARAM_NAMES.has(name))) {
    // Unknown or undecodable name: it could itself be data, so hide it too.
    return `${UNKNOWN_QUERY_PARAM}=${REDACTED}`;
  }
  if (check === undefined) return `${rawName}=${REDACTED}`;
  if (separator === -1) return pair;
  const value = decodeQueryComponent(pair.slice(separator + 1));
  return value !== undefined && check(value) ? pair : `${rawName}=${REDACTED}`;
}

/**
 * Redact query parameter values from a request URL using an allowlist [SEC].
 * Only the parameters in {@link LOGGABLE_QUERY_PARAMS} keep their value, and
 * only when it passes that parameter's check (digits, a contract enum value,
 * plain base64url). Known API parameters keep their (raw) name with the
 * value `[REDACTED]`; any other or undecodable name is logged as
 * `[param]=[REDACTED]`. Repeated parameters are handled pair by pair.
 *
 * @param rawUrl - Path plus query, e.g. `/api/chat/ws?ticket=abc`.
 * @returns The scrubbed URL, e.g. `/api/chat/ws?ticket=[REDACTED]`.
 */
export function scrubUrl(rawUrl: string): string {
  const queryStart = rawUrl.indexOf("?");
  if (queryStart === -1) return rawUrl;
  const path = rawUrl.slice(0, queryStart);
  const query = rawUrl.slice(queryStart + 1);
  return `${path}?${query.split("&").map(scrubQueryPair).join("&")}`;
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
    serializers: { req: serializeRequest, err: serializeError, error: serializeError },
    formatters: { log: scrubLogObject }
  };
  if (overrides.stream !== undefined) return { ...base, stream: overrides.stream };
  if (config.NODE_ENV === "development") {
    return { ...base, transport: { target: "pino-pretty", options: { translateTime: "SYS:HH:MM:ss" } } };
  }
  return base;
}
