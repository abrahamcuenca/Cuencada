import type { AuthTokenResponse, CurrentUser } from "@cuencada/types";
import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

/**
 * Session lifecycle:
 * - `idle`: app just loaded, the boot refresh has not started yet.
 * - `restoring`: the silent boot `POST /auth/refresh` is in flight.
 * - `authenticated`: an access token and user are in memory.
 * - `anonymous`: no session (never had one, logged out, or the server rejected the refresh).
 *
 * A refresh that fails without an HTTP answer (offline, DNS, 5xx) does not
 * change `status`; it sets `isOffline` instead and is retried later.
 */
export type AuthStatus = "idle" | "restoring" | "authenticated" | "anonymous";

/**
 * Auth state. **Memory only** [SEC]: the access token and user are never
 * written to localStorage/sessionStorage/IndexedDB, so an XSS payload cannot
 * read a long-lived credential from storage and a shared device keeps nothing
 * after the tab closes. The session survives reloads through the HttpOnly
 * refresh cookie instead.
 */
export interface AuthState {
  accessToken: string | null;
  user: CurrentUser | null;
  status: AuthStatus;
  /**
   * Set when the server answered 403 `PASSWORD_CHANGE_REQUIRED`, or when the
   * user payload says `mustChangePassword`. The router sends the user to
   * `/cambiar-contrasena` while it is true.
   */
  passwordChangeRequired: boolean;
  /**
   * The last refresh could not reach the server (network error or 5xx). The
   * session is kept as it was and the refresh is retried on the `online`
   * event; only an HTTP 4xx answer logs the user out.
   */
  isOffline: boolean;
}

/** Credentials as returned by login, refresh, magic link, invite accept and change-password. */
export type Credentials = Pick<AuthTokenResponse, "accessToken" | "user">;

export const initialAuthState: AuthState = {
  accessToken: null,
  user: null,
  status: "idle",
  passwordChangeRequired: false,
  isOffline: false
};

function applyCredentials(state: AuthState, action: PayloadAction<Credentials>): void {
  state.accessToken = action.payload.accessToken;
  state.user = action.payload.user;
  state.status = "authenticated";
  state.passwordChangeRequired = action.payload.user.mustChangePassword;
  state.isOffline = false;
}

const authSlice = createSlice({
  name: "auth",
  initialState: initialAuthState,
  reducers: {
    /** The silent boot refresh started. Guards show a spinner instead of redirecting. */
    sessionRestoreStarted(state) {
      if (state.status === "idle" || state.status === "anonymous") state.status = "restoring";
    },
    /** New credentials from login, magic link, invite accept or change-password. */
    credentialsReceived: applyCredentials,
    /** A `POST /auth/refresh` succeeded (boot or after `TOKEN_EXPIRED`). */
    tokenRefreshed: applyCredentials,
    /** A refresh could not reach the server; keep the session and retry when back online. */
    refreshDeferredOffline(state) {
      state.isOffline = true;
    },
    /** The server answered 403 `PASSWORD_CHANGE_REQUIRED`. */
    passwordChangeRequired(state) {
      state.passwordChangeRequired = true;
    },
    /** Clears everything: explicit logout, another tab's logout, or a failed refresh. */
    loggedOut() {
      return { ...initialAuthState, status: "anonymous" };
    }
  }
});

export const {
  sessionRestoreStarted,
  credentialsReceived,
  tokenRefreshed,
  refreshDeferredOffline,
  passwordChangeRequired,
  loggedOut
} = authSlice.actions;

/** Reducer for the `auth` key of the store. */
export const authReducer = authSlice.reducer;

/** Minimal state shape the auth selectors need (avoids importing the store type). */
export interface WithAuthState {
  auth: AuthState;
}

/** @returns The in-memory access token, or `null`. */
export const selectAccessToken = (state: WithAuthState): string | null => state.auth.accessToken;
/** @returns The logged-in user, or `null`. */
export const selectCurrentUser = (state: WithAuthState): CurrentUser | null => state.auth.user;
/** @returns The session lifecycle status. */
export const selectAuthStatus = (state: WithAuthState): AuthStatus => state.auth.status;
/** @returns Whether the last refresh could not reach the server. */
export const selectIsOffline = (state: WithAuthState): boolean => state.auth.isOffline;
/** @returns Whether the router must force `/cambiar-contrasena`. */
export const selectPasswordChangeRequired = (state: WithAuthState): boolean => state.auth.passwordChangeRequired;
/**
 * UX hint only (e.g. show the Admin link). **Never** a security decision: the
 * server enforces roles on every `/api/admin/*` request.
 *
 * @returns Whether the in-memory user claims the admin role.
 */
export const selectIsAdmin = (state: WithAuthState): boolean => state.auth.user?.role === "admin";
