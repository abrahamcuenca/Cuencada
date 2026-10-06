/**
 * Session thunks owned by the web foundation (WP-0.6): boot restore and
 * logout. Login, magic link, invite accept and change-password belong to T1
 * and finish by dispatching `credentialsReceived`.
 */
import type { ThunkAction, UnknownAction } from "@reduxjs/toolkit";
import type { RootState } from "../../app/store";
import { CSRF_HEADERS, detachedApi, LOGOUT_PATH, rawBaseQuery, refreshAccessToken } from "../../shared/api/reauth";
import { loggedOut, sessionRestoreStarted } from "./authSlice";
import { broadcastLogout } from "./authSync";

/** A thunk for this store. */
export type AppThunk<TResult> = ThunkAction<TResult, RootState, unknown, UnknownAction>;

/**
 * Silent boot refresh: status goes `restoring`, then `authenticated` (the
 * HttpOnly refresh cookie was valid) or `anonymous`. Guards render a spinner
 * until it settles, so a reload never bounces a logged-in user to `/entrar`.
 *
 * @returns A thunk resolving to `true` when a session was restored.
 */
export function restoreSession(): AppThunk<Promise<boolean>> {
  return async (dispatch, getState) => {
    dispatch(sessionRestoreStarted());
    return refreshAccessToken({ dispatch, getState });
  };
}

/** Outcome of {@link logout}. */
export interface LogoutResult {
  /** False when the server could not be reached; the local session is cleared anyway. */
  serverConfirmed: boolean;
}

/**
 * Logs out everywhere this browser knows about:
 * 1. `POST /auth/logout` with the CSRF header (revokes the session, clears the cookie);
 * 2. clears the in-memory session and the RTK Query cache (`loggedOut`);
 * 3. tells other tabs over `BroadcastChannel` to do the same.
 *
 * Local state is cleared even if the request fails: the user asked to leave.
 *
 * @returns A thunk resolving to whether the server confirmed the logout.
 */
export function logout(): AppThunk<Promise<LogoutResult>> {
  return async (dispatch, getState) => {
    const result = await rawBaseQuery(
      { url: LOGOUT_PATH, method: "POST", headers: { ...CSRF_HEADERS } },
      detachedApi({ dispatch, getState }, "logout"),
      {}
    );
    dispatch(loggedOut());
    broadcastLogout();
    return { serverConfirmed: result.error === undefined };
  };
}
