/**
 * Session thunks owned by the web foundation (WP-0.6): boot restore, logout
 * and completing an unconfirmed logout. Login, magic link, invite accept and
 * change-password belong to T1 and finish by dispatching `credentialsReceived`.
 */
import type { ThunkAction, UnknownAction } from "@reduxjs/toolkit";
import type { RootState } from "../../app/store";
import { refreshAccessToken, requestServerLogout } from "../../shared/api/reauth";
import { reportUnexpected } from "../../shared/lib/reportUnexpected";
import { loggedOut, logoutConfirmed, logoutUnconfirmed, sessionRestoreStarted } from "./authSlice";
import { broadcastLogout } from "./authSync";
import { clearPendingLogout, hasPendingLogout, markPendingLogout } from "./pendingLogout";

/** A thunk for this store. */
export type AppThunk<TResult> = ThunkAction<TResult, RootState, unknown, UnknownAction>;

/** Outcome of {@link logout}. */
export interface LogoutResult {
  /** False when the server could not be reached; it is retried on `online` and at the next boot. */
  serverConfirmed: boolean;
}

let onlineLogoutRetry: (() => void) | null = null;

/** Cancels a pending "finish the logout when back online" (after confirmation, a new login, or between tests). */
export function cancelOnlineLogoutRetry(): void {
  if (onlineLogoutRetry === null) return;
  window.removeEventListener("online", onlineLogoutRetry);
  onlineLogoutRetry = null;
}

/**
 * Sends the pending `POST /auth/logout` (under the refresh lock). On
 * confirmation (2xx or 401) the durable marker is cleared; otherwise the
 * notice stays up and the call is retried on the next `online` event.
 *
 * @returns A thunk resolving to whether the server confirmed the logout.
 */
export function completePendingLogout(): AppThunk<Promise<boolean>> {
  return async (dispatch, getState) => {
    const outcome = await requestServerLogout({ dispatch, getState });
    if (outcome === "confirmed") {
      cancelOnlineLogoutRetry();
      clearPendingLogout();
      dispatch(logoutConfirmed());
      return true;
    }

    dispatch(logoutUnconfirmed());
    if (onlineLogoutRetry === null && typeof window !== "undefined") {
      const retry = (): void => {
        onlineLogoutRetry = null;
        dispatch(completePendingLogout()).catch(reportUnexpected);
      };
      onlineLogoutRetry = retry;
      window.addEventListener("online", retry, { once: true });
    }
    return false;
  };
}

/**
 * Boot: if an earlier logout was never confirmed by the server, finish it
 * **instead of** refreshing (the still-valid cookie must not log the previous
 * user back in) and stay anonymous. Otherwise run the silent refresh: status
 * goes `restoring`, then `authenticated`, or `anonymous`, or stays
 * `restoring` with `isOffline` when the server is unreachable.
 *
 * @returns A thunk resolving to `true` when a session was restored.
 */
export function restoreSession(): AppThunk<Promise<boolean>> {
  return async (dispatch, getState) => {
    if (hasPendingLogout()) {
      dispatch(loggedOut());
      await dispatch(completePendingLogout());
      return false;
    }
    dispatch(sessionRestoreStarted());
    return refreshAccessToken({ dispatch, getState });
  };
}

/**
 * Logs out everywhere this browser knows about:
 * 1. clears the in-memory session and the RTK Query cache (`loggedOut`, which
 *    also bumps the epoch so an in-flight refresh cannot revive the session);
 * 2. tells other tabs over `BroadcastChannel` to do the same;
 * 3. records a durable "pending logout" marker, then sends `POST /auth/logout`
 *    under the refresh lock. The marker is cleared only when the server
 *    confirms; until then the layout shows a notice and the call is retried
 *    on `online` and at the next boot.
 *
 * @returns A thunk resolving to whether the server confirmed the logout.
 */
export function logout(): AppThunk<Promise<LogoutResult>> {
  return async (dispatch) => {
    dispatch(loggedOut());
    broadcastLogout();
    markPendingLogout();
    const serverConfirmed = await dispatch(completePendingLogout());
    return { serverConfirmed };
  };
}
