/**
 * Reports an unexpected error without crashing the caller. The single place
 * to hook Sentry later.
 *
 * Uses `reportError` (fires window `error` listeners) where it exists, and
 * falls back to rethrowing in a microtask on browsers without it (Safari
 * < 15.4), which reaches the same listeners as an uncaught error.
 *
 * @param error - Whatever was thrown or rejected.
 */
export function reportUnexpected(error: unknown): void {
  if (typeof globalThis.reportError === "function") {
    globalThis.reportError(error);
    return;
  }
  queueMicrotask(() => {
    throw error;
  });
}
