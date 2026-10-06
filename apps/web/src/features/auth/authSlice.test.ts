import { describe, expect, it } from "vitest";
import { makeUser } from "../../../test/auth";
import {
  type AuthState,
  authReducer,
  credentialsReceived,
  initialAuthState,
  loggedOut,
  passwordChangeRequired,
  selectIsAdmin,
  sessionRestoreStarted,
  tokenRefreshed
} from "./authSlice";

const authenticated: AuthState = {
  accessToken: "token-1",
  user: makeUser(),
  status: "authenticated",
  passwordChangeRequired: false
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
        accessToken: "t2",
        user,
        status: "authenticated",
        passwordChangeRequired: false
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

  it("flags passwordChangeRequired on passwordChangeRequired", () => {
    expect(authReducer(authenticated, passwordChangeRequired()).passwordChangeRequired).toBe(true);
  });

  it("clears the token and user and becomes anonymous on loggedOut", () => {
    expect(authReducer({ ...authenticated, passwordChangeRequired: true }, loggedOut())).toEqual({
      accessToken: null,
      user: null,
      status: "anonymous",
      passwordChangeRequired: false
    });
  });
});

describe("selectIsAdmin", () => {
  it("returns true only for a user whose role is admin", () => {
    expect(selectIsAdmin({ auth: { ...authenticated, user: makeUser({ role: "admin" }) } })).toBe(true);
    expect(selectIsAdmin({ auth: authenticated })).toBe(false);
    expect(selectIsAdmin({ auth: initialAuthState })).toBe(false);
  });
});
