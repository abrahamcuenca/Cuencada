/**
 * Global error and not-found handling. Every non-2xx response leaves the API
 * in the `ApiError` envelope: `{ error: { code, message, details? } }`.
 *
 * - {@link AppError} → its code, message and details.
 * - Schema validation (type provider) or a `ZodError` thrown by a handler → 400 `VALIDATION`.
 * - Known Fastify client errors (`FST_*`, e.g. bad JSON, body too large) → mapped code.
 * - Anything else → 500 `INTERNAL` with a generic message. The real error is
 *   logged server-side; its message and stack never reach the client.
 */
import {
  API_ERROR_DETAILS_MAX,
  type ApiError,
  type ApiErrorDetail,
  ErrorCode,
  errorHttpStatus
} from "@cuencada/types";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";
import { ZodError } from "zod";
import { AppError, defaultErrorMessages } from "../lib/errors.js";

const DETAIL_PATH_MAX = 200;
const DETAIL_MESSAGE_MAX = 500;

/** A normalized error ready to send. */
interface ResolvedError {
  code: ErrorCode;
  status: number;
  message: string;
  details: ApiErrorDetail[] | undefined;
  headers: Record<string, string> | undefined;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Bound a details list to the contract maximum. Past the cap it keeps the
 * first `max - 1` entries and appends one summary entry, so clients always
 * know more problems exist.
 *
 * @param details - Raw details, possibly unbounded.
 * @returns At most {@link API_ERROR_DETAILS_MAX} entries with bounded strings.
 */
export function capErrorDetails(details: ApiErrorDetail[]): ApiErrorDetail[] {
  const bounded = details.map(
    (detail): ApiErrorDetail => ({
      path: truncate(detail.path, DETAIL_PATH_MAX),
      message: truncate(detail.message, DETAIL_MESSAGE_MAX),
      ...(detail.code === undefined ? {} : { code: detail.code })
    })
  );
  if (bounded.length <= API_ERROR_DETAILS_MAX) return bounded;
  const kept = bounded.slice(0, API_ERROR_DETAILS_MAX - 1);
  const remaining = bounded.length - kept.length;
  kept.push({ path: "", message: `Y ${remaining} problemas más.` });
  return kept;
}

/** `/a/0/b` (JSON pointer) → `a.0.b`. */
function pointerToPath(pointer: string): string {
  return pointer
    .split("/")
    .filter((segment) => segment.length > 0)
    .join(".");
}

function validationError(details: ApiErrorDetail[]): ResolvedError {
  return {
    code: ErrorCode.VALIDATION,
    status: errorHttpStatus.VALIDATION,
    message: defaultErrorMessages.VALIDATION,
    details: capErrorDetails(details),
    headers: undefined
  };
}

function fromCode(code: ErrorCode): ResolvedError {
  return {
    code,
    status: errorHttpStatus[code],
    message: defaultErrorMessages[code],
    details: undefined,
    headers: undefined
  };
}

/** Map a Fastify-core/plugin 4xx status to the closest contract code. */
function codeForClientStatus(status: number): ErrorCode {
  switch (status) {
    case 401:
      return ErrorCode.UNAUTHENTICATED;
    case 403:
      return ErrorCode.FORBIDDEN;
    case 404:
    case 405:
      return ErrorCode.NOT_FOUND;
    case 409:
      return ErrorCode.CONFLICT;
    case 413:
      return ErrorCode.PAYLOAD_TOO_LARGE;
    case 429:
      return ErrorCode.RATE_LIMITED;
    default:
      return ErrorCode.VALIDATION;
  }
}

function isFastifyClientError(error: unknown): error is FastifyError & { statusCode: number } {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; statusCode?: unknown }; // narrowing an unknown object for property checks
  return (
    typeof candidate.code === "string" &&
    candidate.code.startsWith("FST_") &&
    typeof candidate.statusCode === "number" &&
    candidate.statusCode >= 400 &&
    candidate.statusCode < 500
  );
}

/**
 * Normalize any thrown value into a client-safe error.
 *
 * @param error - Whatever was thrown.
 * @returns The code, status, message and details to send.
 */
export function resolveError(error: unknown): ResolvedError {
  if (error instanceof AppError) {
    return {
      code: error.code,
      status: error.statusCode,
      message: error.message,
      details: error.details === undefined ? undefined : capErrorDetails(error.details),
      headers: error.headers
    };
  }
  if (hasZodFastifySchemaValidationErrors(error)) {
    return validationError(
      error.validation.map((issue) => ({
        path: pointerToPath(issue.instancePath),
        message: issue.message ?? defaultErrorMessages.VALIDATION
      }))
    );
  }
  if (error instanceof ZodError) {
    return validationError(
      error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message }))
    );
  }
  if (isFastifyClientError(error)) {
    return fromCode(codeForClientStatus(error.statusCode));
  }
  return fromCode(ErrorCode.INTERNAL);
}

/**
 * Send the `ApiError` envelope for a resolved error.
 *
 * @param reply - The reply to send on.
 * @param resolved - Output of {@link resolveError}.
 */
export function sendApiError(reply: FastifyReply, resolved: ResolvedError): FastifyReply {
  const body: ApiError = {
    error: {
      code: resolved.code,
      message: resolved.message,
      ...(resolved.details === undefined ? {} : { details: resolved.details })
    }
  };
  if (resolved.headers) void reply.headers(resolved.headers);
  return reply.status(resolved.status).send(body);
}

function logError(request: FastifyRequest, error: unknown, resolved: ResolvedError): void {
  if (resolved.status >= 500) {
    request.log.error({ err: error, code: resolved.code }, "request failed");
  } else {
    request.log.info({ code: resolved.code, statusCode: resolved.status }, "request rejected");
  }
}

/**
 * Install the global error handler and the 404 handler on the root instance.
 * Child plugins inherit both unless they override them (they must not).
 *
 * @param app - Root Fastify instance (after `@fastify/rate-limit` is registered).
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const resolved = resolveError(error);
    logError(request, error, resolved);
    if (reply.sent) return;
    return sendApiError(reply, resolved);
  });

  app.setNotFoundHandler(
    // Rate-limit 404s so path scanning cannot be used to probe cheaply.
    { preHandler: app.rateLimit() },
    (_request, reply) => sendApiError(reply, fromCode(ErrorCode.NOT_FOUND))
  );
}
