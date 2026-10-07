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
  /**
   * Incremented by every `loggedOut`. A refresh captures it before its request
   * and discards its result if it changed meanwhile, so a refresh that lands
   * after a logout (this tab or a broadcast) can never revive the session.
   */
  sessionEpoch: number;
  /**
   * The user logged out but the server has not confirmed it yet (offline or
   * 5xx). The layout shows a notice; the logout is retried on `online` and at
   * the next boot (see `pendingLogout.ts`).
   */
  logoutPending: boolean;
}

/** Credentials as returned by login, refresh, magic link, invite accept and change-password. */
export type Credentials = Pick<AuthTokenResponse, "accessToken" | "user">;

export const initialAuthState: AuthState = {
  accessToken: null,
  user: null,
  status: "idle",
  passwordChangeRequired: false,
  isOffline: false,
  sessionEpoch: 0,
  logoutPending: false
};

function applyCredentials(state: AuthState, action: PayloadAction<Credentials>): void {
  // [SEC] A different account replaced the session without a logout (Security M1):
  // bump the epoch like `loggedOut` does, so an in-flight refresh for the previous
  // user is discarded. The store listener also resets the API cache.
  if (state.user !== null && state.user.id !== action.payload.user.id) state.sessionEpoch += 1;
  state.accessToken = action.payload.accessToken;
  state.user = action.payload.user;
  state.status = "authenticated";
  state.passwordChangeRequired = action.payload.user.mustChangePassword;
  state.isOffline = false;
  // A successful login replaced the refresh cookie, so the old unconfirmed logout no longer matters.
  state.logoutPending = false;
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
    /**
     * A fresh `GET /me` (T1). Updates the in-memory user (e.g. `emailVerified`
     * after verification) without touching the token. Ignored without a
     * session or for a different user, so a late response after a logout or
     * account switch cannot resurrect or mix up state.
     */
    currentUserLoaded(state, action: PayloadAction<CurrentUser>) {
      if (state.status !== "authenticated" || state.user?.id !== action.payload.id) return;
      state.user = action.payload;
      state.passwordChangeRequired = action.payload.mustChangePassword;
    },
    /** The server answered 403 `PASSWORD_CHANGE_REQUIRED`. */
    passwordChangeRequired(state) {
      state.passwordChangeRequired = true;
    },
    /**
     * Clears the session: explicit logout, another tab's logout, or a refused
     * refresh. Bumps `sessionEpoch`; keeps `logoutPending`.
     */
    loggedOut(state) {
      return {
        ...initialAuthState,
        status: "anonymous",
        sessionEpoch: state.sessionEpoch + 1,
        logoutPending: state.logoutPending
      };
    },
    /** The server has not confirmed the logout yet. */
    logoutUnconfirmed(state) {
      state.logoutPending = true;
    },
    /** The server confirmed the logout (2xx, or 401 because the session was already dead). */
    logoutConfirmed(state) {
      state.logoutPending = false;
    }
  }
});

export const {
  sessionRestoreStarted,
  credentialsReceived,
  tokenRefreshed,
  currentUserLoaded,
  refreshDeferredOffline,
  passwordChangeRequired,
  loggedOut,
  logoutUnconfirmed,
  logoutConfirmed
} = authSlice.actions;

/** Reducer for the `auth` key of the store. */
export const authReducer = authSlice.reducer;

/**
 * @param previous - Auth state before the action.
 * @param next - Auth state after it.
 * @returns Whether the logged-in account changed from one user to another (A → B, no logout in between).
 */
export function didSwitchUser(previous: AuthState, next: AuthState): boolean {
  return previous.user !== null && next.user !== null && previous.user.id !== next.user.id;
}

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
/** @returns The logout epoch (see {@link AuthState.sessionEpoch}). */
export const selectSessionEpoch = (state: WithAuthState): number => state.auth.sessionEpoch;
/** @returns Whether a logout still awaits the server's confirmation. */
export const selectLogoutPending = (state: WithAuthState): boolean => state.auth.logoutPending;
/** @returns Whether the router must force `/cambiar-contrasena`. */
export const selectPasswordChangeRequired = (state: WithAuthState): boolean => state.auth.passwordChangeRequired;
/**
 * UX hint only (e.g. show the Admin link). **Never** a security decision: the
 * server enforces roles on every `/api/admin/*` request.
 *
 * @returns Whether the in-memory user claims the admin role.
 */
export const selectIsAdmin = (state: WithAuthState): boolean => state.auth.user?.role === "admin";

/**
 * Who the navigation is for, from the in-memory session:
 * - `pending`: the boot refresh has not answered yet (`idle`/`restoring`).
 *   Render only public destinations, so a returning member never sees the
 *   anonymous nav flash before their own.
 * - `anonymous`: no session.
 * - `member`: logged in (verified or not; member pages show the verify state).
 * - `admin`: logged in with the admin role.
 */
export type SessionAudience = "pending" | "anonymous" | "member" | "admin";

/**
 * UX hint only (which links to show). **Never** a security decision: the
 * server enforces authentication and roles on every request.
 *
 * @returns The {@link SessionAudience} of the current session.
 */
export const selectSessionAudience = (state: WithAuthState): SessionAudience => {
  const { status, user } = state.auth;
  if (status === "authenticated" && user !== null) return user.role === "admin" ? "admin" : "member";
  if (status === "idle" || status === "restoring") return "pending";
  return "anonymous";
};
