/**
 * Base query with transparent access-token refresh [SEC].
 *
 * Flow for every RTK Query request:
 * 1. Send it with `credentials: "include"` and `Authorization: Bearer <in-memory token>`.
 * 2. On 401 `TOKEN_EXPIRED`, refresh once (see {@link refreshAccessToken}) and retry
 *    the original request **once**. A second failure is returned as-is (no loops).
 * 3. On 403 `PASSWORD_CHANGE_REQUIRED`, flag the session so the router forces
 *    `/cambiar-contrasena`.
 * 4. On 401 `UNAUTHENTICATED` while holding a token (session revoked, user
 *    disabled), drop the local session.
 */
import { CSRF_HEADER, ErrorCode, refreshResponseSchema } from "@cuencada/types";
import {
  type BaseQueryApi,
  type BaseQueryFn,
  type FetchArgs,
  type FetchBaseQueryError,
  type FetchBaseQueryMeta,
  fetchBaseQuery
} from "@reduxjs/toolkit/query";
import {
  loggedOut,
  passwordChangeRequired,
  refreshDeferredOffline,
  selectAccessToken,
  selectSessionEpoch,
  tokenRefreshed,
  type WithAuthState
} from "../../features/auth/authSlice";
import { env } from "../lib/env";
import { reportUnexpected } from "../lib/reportUnexpected";
import { getApiErrorCode } from "./errors";

/** Name of the Web Locks lock that serializes refreshes across tabs. */
export const REFRESH_LOCK_NAME = "cuencada-refresh";
/** Path (relative to the API base) of the cookie-authenticated refresh endpoint. */
export const REFRESH_PATH = "/auth/refresh";
/** Path of the cookie-authenticated logout endpoint. */
export const LOGOUT_PATH = "/auth/logout";
/** Headers every cookie-authenticated call (refresh, logout) must send. */
export const CSRF_HEADERS: Readonly<Record<string, string>> = { [CSRF_HEADER]: "1" };
/** Pause before retrying a refresh that lost a `REFRESH_RACE`, letting the winner finish. */
export const REFRESH_RACE_RETRY_DELAY_MS = 150;

type ApiBaseQuery = BaseQueryFn<string | FetchArgs, unknown, FetchBaseQueryError, object, FetchBaseQueryMeta>;
type QueryResult = Awaited<ReturnType<ApiBaseQuery>>;

function authState(api: Pick<BaseQueryApi, "getState">): WithAuthState {
  // Safe: the store always mounts `authReducer` under `auth` (see app/store.ts).
  return api.getState() as WithAuthState;
}

/**
 * Plain `fetchBaseQuery`: same-origin cookies included, Bearer token from the
 * in-memory auth state. No retry logic; use {@link baseQueryWithReauth}.
 */
export const rawBaseQuery: ApiBaseQuery = fetchBaseQuery({
  baseUrl: env.apiBaseUrl,
  credentials: "include",
  prepareHeaders: (headers, { getState }) => {
    const token = selectAccessToken(authState({ getState }));
    if (token !== null && !headers.has("authorization")) {
      headers.set("authorization", `Bearer ${token}`);
    }
    return headers;
  }
});

/**
 * Runs `task` while holding the cross-tab `cuencada-refresh` Web Lock, so two
 * tabs never present the same refresh cookie at once (which the server would
 * treat as reuse). Falls back to running `task` directly where the Web Locks
 * API is missing (older Safari, jsdom); the in-tab mutex still applies there,
 * and the server's `REFRESH_RACE` grace window covers the cross-tab case.
 *
 * @param task - The work to run under the lock.
 * @returns Whatever `task` resolves to.
 */
export async function withRefreshLock<TResult>(task: () => Promise<TResult>): Promise<TResult> {
  const locks: LockManager | undefined = typeof navigator !== "undefined" && "locks" in navigator ? navigator.locks : undefined;
  if (locks === undefined || typeof locks.request !== "function") return task();
  return locks.request(REFRESH_LOCK_NAME, { mode: "exclusive" }, () => task());
}

/**
 * Builds a `BaseQueryApi` with its own abort signal, for calls made outside an
 * endpoint (boot refresh, logout) and so that aborting the request that
 * triggered a refresh never aborts the shared refresh.
 *
 * @param api - Supplies `dispatch` and `getState`.
 * @param endpoint - Label used by RTK Query internals.
 * @returns A standalone `BaseQueryApi`.
 */
export function detachedApi(api: Pick<BaseQueryApi, "dispatch" | "getState">, endpoint: string): BaseQueryApi {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    abort: (reason?: string) => controller.abort(reason),
    dispatch: api.dispatch,
    getState: api.getState,
    extra: undefined,
    endpoint,
    type: "mutation"
  };
}

function requestRefresh(api: BaseQueryApi): Promise<QueryResult> {
  return withRefreshLock(async () =>
    rawBaseQuery({ url: REFRESH_PATH, method: "POST", headers: { ...CSRF_HEADERS } }, api, {})
  );
}

function isRefreshRace(result: QueryResult): boolean {
  return result.error?.status === 409 && getApiErrorCode(result.error) === ErrorCode.REFRESH_RACE;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runRefresh(api: BaseQueryApi): Promise<boolean> {
  try {
    return await refreshOnce(api);
  } catch (error) {
    // Never leave the app stuck in "restoring": drop the session, then surface the bug.
    api.dispatch(loggedOut());
    throw error;
  }
}

async function refreshOnce(api: BaseQueryApi): Promise<boolean> {
  // [SEC] A logout (here or broadcast from another tab) bumps the epoch; a result that
  // lands after it is discarded so it cannot revive the session.
  const epoch = selectSessionEpoch(authState(api));
  const loggedOutMeanwhile = (): boolean => selectSessionEpoch(authState(api)) !== epoch;

  let result = await requestRefresh(api);
  if (loggedOutMeanwhile()) return false;
  if (isRefreshRace(result)) {
    // Another tab rotated the cookie inside the grace window; retry exactly once.
    await delay(REFRESH_RACE_RETRY_DELAY_MS);
    if (loggedOutMeanwhile()) return false;
    result = await requestRefresh(api);
    if (loggedOutMeanwhile()) return false;
  }

  if (result.error === undefined) {
    const parsed = refreshResponseSchema.safeParse(result.data);
    if (parsed.success) {
      cancelOnlineRefreshRetry();
      api.dispatch(tokenRefreshed({ accessToken: parsed.data.accessToken, user: parsed.data.user }));
      return true;
    }
  }

  if (result.error === undefined || isUnreachable(result.error)) {
    // No usable answer (offline, 5xx, or a 200 that is not our JSON, e.g. a hotel captive
    // portal): keep the session and try again when back online.
    api.dispatch(refreshDeferredOffline());
    scheduleOnlineRefreshRetry(api);
    return false;
  }

  // The server answered with a refusal (401, 403 CSRF_FAILED, 409 after the retry, other 4xx).
  cancelOnlineRefreshRetry();
  api.dispatch(loggedOut());
  return false;
}

/** HTTP status of a `fetchBaseQuery` error, or `null` when there was no HTTP answer. */
function httpStatusOf(error: FetchBaseQueryError): number | null {
  if (typeof error.status === "number") return error.status;
  return "originalStatus" in error ? error.originalStatus : null;
}

/**
 * True when there was no usable answer from our API: no HTTP response
 * (offline, DNS, timeout), a 5xx, or a body that is not JSON (captive portal
 * HTML, `PARSING_ERROR`). Those never log the user out.
 */
export function isUnreachable(error: FetchBaseQueryError): boolean {
  if (error.status === "FETCH_ERROR" || error.status === "TIMEOUT_ERROR" || error.status === "PARSING_ERROR") return true;
  const status = httpStatusOf(error);
  return status === null || status >= 500;
}

/** Outcome of {@link requestServerLogout}. */
export type ServerLogoutOutcome = "confirmed" | "unconfirmed";

/**
 * `POST /auth/logout` with the CSRF header, under the same cross-tab lock as
 * refresh so it never interleaves with a rotation of the same cookie.
 * A 2xx, or a 401 (the session is already dead), counts as confirmed.
 *
 * @param api - Supplies `dispatch`/`getState`.
 * @returns Whether the server confirmed the logout.
 */
export async function requestServerLogout(api: Pick<BaseQueryApi, "dispatch" | "getState">): Promise<ServerLogoutOutcome> {
  const result = await withRefreshLock(async () =>
    rawBaseQuery({ url: LOGOUT_PATH, method: "POST", headers: { ...CSRF_HEADERS } }, detachedApi(api, "logout"), {})
  );
  if (result.error === undefined) return "confirmed";
  return httpStatusOf(result.error) === 401 && !isUnreachable(result.error) ? "confirmed" : "unconfirmed";
}

let onlineRetry: (() => void) | null = null;

function scheduleOnlineRefreshRetry(api: Pick<BaseQueryApi, "dispatch" | "getState">): void {
  if (onlineRetry !== null || typeof window === "undefined") return;
  const retry = (): void => {
    onlineRetry = null;
    refreshAccessToken(api).catch(reportUnexpected);
  };
  onlineRetry = retry;
  window.addEventListener("online", retry, { once: true });
}

/** Cancels a pending "retry the refresh when back online" (after success, logout, and between tests). */
export function cancelOnlineRefreshRetry(): void {
  if (onlineRetry === null) return;
  window.removeEventListener("online", onlineRetry);
  onlineRetry = null;
}

let refreshInFlight: Promise<boolean> | null = null;

/**
 * Exchanges the HttpOnly refresh cookie for a new access token.
 *
 * Single-flight: concurrent callers in this tab share one request. Across
 * tabs the request runs under {@link withRefreshLock}. On 409 `REFRESH_RACE`
 * it retries once. Success dispatches `tokenRefreshed`. No usable answer
 * (network error, 5xx, non-JSON or off-contract 200) keeps the session,
 * dispatches `refreshDeferredOffline` and retries on the next `online` event.
 * A refusal (401, 403 `CSRF_FAILED`, 409 after the retry) dispatches
 * `loggedOut`. A result that arrives after a logout is discarded.
 *
 * @param api - Supplies `dispatch`/`getState`; its abort signal is not used.
 * @returns `true` when a new token is in the store.
 */
export function refreshAccessToken(api: Pick<BaseQueryApi, "dispatch" | "getState">): Promise<boolean> {
  if (refreshInFlight === null) {
    refreshInFlight = runRefresh(detachedApi(api, "refreshAccessToken")).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/**
 * The base query of `baseApi`: {@link rawBaseQuery} plus refresh-and-retry
 * and auth error side effects (see the module comment).
 */
export const baseQueryWithReauth: ApiBaseQuery = async (args, api, extraOptions) => {
  const tokenSent = selectAccessToken(authState(api));
  let result = await rawBaseQuery(args, api, extraOptions);

  if (result.error?.status === 401 && getApiErrorCode(result.error) === ErrorCode.TOKEN_EXPIRED) {
    const tokenNow = selectAccessToken(authState(api));
    // If another request already refreshed while this one was in flight, just retry with the new token.
    const alreadyRefreshed = refreshInFlight === null && tokenNow !== null && tokenNow !== tokenSent;
    const canRetry = alreadyRefreshed || (await refreshAccessToken(api));
    if (!canRetry) return result;
    result = await rawBaseQuery(args, api, extraOptions);
  }

  if (result.error !== undefined) {
    const code = getApiErrorCode(result.error);
    if (result.error.status === 403 && code === ErrorCode.PASSWORD_CHANGE_REQUIRED) {
      api.dispatch(passwordChangeRequired());
    } else if (
      result.error.status === 401 &&
      code === ErrorCode.UNAUTHENTICATED &&
      selectAccessToken(authState(api)) !== null
    ) {
      api.dispatch(loggedOut());
    }
  }

  return result;
};
