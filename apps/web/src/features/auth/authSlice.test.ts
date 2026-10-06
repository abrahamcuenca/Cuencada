import { describe, expect, it } from "vitest";
import { makeUser } from "../../../test/auth";
import {
  type AuthState,
  authReducer,
  credentialsReceived,
  initialAuthState,
  loggedOut,
  logoutConfirmed,
  logoutUnconfirmed,
  passwordChangeRequired,
  refreshDeferredOffline,
  selectIsAdmin,
  sessionRestoreStarted,
  tokenRefreshed
} from "./authSlice";

const authenticated: AuthState = {
  ...initialAuthState,
  accessToken: "token-1",
  user: makeUser(),
  status: "authenticated",
  passwordChangeRequired: false,
  isOffline: false
};

describe("authReducer", () => {
  it("starts idle with no token, user or forced change", () => {
    expect(authReducer(undefined, { type: "@@init" })).toEqual(initialAuthState);
    expect(initialAuthState.status).toBe("idle");
  });

  it("moves idle and anonymous to restoring when a restore starts, but never an authenticated session", () => {
    expect(authReducer(initialAuthState, sessionRestoreStarted()).status).toBe("restoring");
    expect(authReducer({ ...initialAuthState, status: "anonymous" }, sessionRestoreStarted()).status).toBe("restoring");
    expect(authReducer(authenticated, sessionRestoreStarted())).toEqual(authenticated);
  });

  it("stores the token and user and becomes authenticated on tokenRefreshed and credentialsReceived", () => {
    const user = makeUser({ displayName: "Tío Beto" });
    for (const action of [tokenRefreshed({ accessToken: "t2", user }), credentialsReceived({ accessToken: "t2", user })]) {
      expect(authReducer({ ...initialAuthState, status: "restoring" }, action)).toEqual({
        ...initialAuthState,
        accessToken: "t2",
        user,
        status: "authenticated",
        passwordChangeRequired: false,
        isOffline: false
      });
    }
  });

  it("sets passwordChangeRequired from the user's mustChangePassword flag", () => {
    const user = makeUser({ mustChangePassword: true });
    expect(authReducer(initialAuthState, tokenRefreshed({ accessToken: "t", user })).passwordChangeRequired).toBe(true);
  });

  it("clears passwordChangeRequired when new credentials say the password was changed", () => {
    const flagged = { ...authenticated, passwordChangeRequired: true };
    const next = authReducer(flagged, credentialsReceived({ accessToken: "t3", user: makeUser() }));
    expect(next.passwordChangeRequired).toBe(false);
  });

  it("keeps the session and only sets isOffline on refreshDeferredOffline", () => {
    expect(authReducer(authenticated, refreshDeferredOffline())).toEqual({ ...authenticated, isOffline: true });
    expect(authReducer({ ...initialAuthState, status: "restoring" }, refreshDeferredOffline())).toMatchObject({
      status: "restoring",
      isOffline: true
    });
  });

  it("clears isOffline when a refresh succeeds or the user logs out", () => {
    const offline = { ...authenticated, isOffline: true };
    expect(authReducer(offline, tokenRefreshed({ accessToken: "t9", user: makeUser() })).isOffline).toBe(false);
    expect(authReducer(offline, loggedOut()).isOffline).toBe(false);
  });

  it("flags passwordChangeRequired on passwordChangeRequired", () => {
    expect(authReducer(authenticated, passwordChangeRequired()).passwordChangeRequired).toBe(true);
  });

  it("clears the token and user, becomes anonymous and bumps the session epoch on loggedOut", () => {
    expect(authReducer({ ...authenticated, passwordChangeRequired: true, sessionEpoch: 4 }, loggedOut())).toEqual({
      ...initialAuthState,
      status: "anonymous",
      sessionEpoch: 5
    });
  });

  it("keeps logoutPending across loggedOut and toggles it with logoutUnconfirmed and logoutConfirmed", () => {
    const pending = authReducer(authenticated, logoutUnconfirmed());
    expect(pending.logoutPending).toBe(true);
    expect(authReducer(pending, loggedOut()).logoutPending).toBe(true);
    expect(authReducer(pending, logoutConfirmed()).logoutPending).toBe(false);
  });

  it("clears logoutPending when new credentials arrive", () => {
    const pending = { ...initialAuthState, status: "anonymous" as const, logoutPending: true };
    expect(authReducer(pending, credentialsReceived({ accessToken: "t", user: makeUser() })).logoutPending).toBe(false);
  });
});

describe("selectIsAdmin", () => {
  it("returns true only for a user whose role is admin", () => {
    expect(selectIsAdmin({ auth: { ...authenticated, user: makeUser({ role: "admin" }) } })).toBe(true);
    expect(selectIsAdmin({ auth: authenticated })).toBe(false);
    expect(selectIsAdmin({ auth: initialAuthState })).toBe(false);
  });
});
