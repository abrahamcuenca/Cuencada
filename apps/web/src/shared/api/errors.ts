import { type ApiError, apiErrorSchema, type ErrorCode } from "@cuencada/types";
import type { FetchBaseQueryError } from "@reduxjs/toolkit/query";

/**
 * Narrows an unknown RTK Query error to a `fetchBaseQuery` error.
 *
 * @param error - Anything a query or mutation returned as `error`.
 * @returns Whether it carries a `status` like `FetchBaseQueryError`.
 */
export function isFetchBaseQueryError(error: unknown): error is FetchBaseQueryError {
  return typeof error === "object" && error !== null && "status" in error;
}

/**
 * Parses an error response body with the contract `apiErrorSchema`.
 *
 * Bodies that do not match (proxies, HTML error pages, network failures)
 * return `null` rather than a guessed shape, so callers branch on a real
 * `code` or fall back to a generic Spanish message.
 *
 * @param error - The `error` from an RTK Query result.
 * @returns The validated envelope, or `null`.
 */
export function parseApiError(error: unknown): ApiError | null {
  if (!isFetchBaseQueryError(error)) return null;
  const parsed = apiErrorSchema.safeParse(error.data);
  return parsed.success ? parsed.data : null;
}

/**
 * @param error - The `error` from an RTK Query result.
 * @returns The machine-readable `ErrorCode`, or `null` when the body is not an `ApiError`.
 */
export function getApiErrorCode(error: unknown): ErrorCode | null {
  return parseApiError(error)?.error.code ?? null;
}

/** Shown when the server gave no usable message (network down, proxy page, etc.). */
export const GENERIC_ERROR_MESSAGE = "Algo salió mal. Revisa tu conexión e inténtalo de nuevo.";

/**
 * @param error - The `error` from an RTK Query result.
 * @returns The server's Spanish message, or a generic one.
 */
export function getApiErrorMessage(error: unknown): string {
  return parseApiError(error)?.error.message ?? GENERIC_ERROR_MESSAGE;
}
