/**
 * Shared fixtures for web auth tests: users, token bodies, error envelopes and
 * absolute API URLs for MSW handlers.
 */
import type { ApiError, AuthTokenResponse, CurrentUser, ErrorCode } from "@cuencada/types";
import type { RootState } from "../src/app/store";
import { type AuthState, initialAuthState } from "../src/features/auth/authSlice";
import { env } from "../src/shared/lib/env";

/** Absolute URL of an API path, matching what `fetchBaseQuery` requests. */
export function apiUrl(path: string): string {
  return `${env.apiBaseUrl}${path}`;
}

/** A valid `CurrentUser` (member, password already changed). */
export function makeUser(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b",
    email: "prima@example.com",
    displayName: "Prima Cuenca",
    role: "member",
    status: "active",
    mustChangePassword: false,
    emailVerified: true,
    personId: null,
    avatarUrl: null,
    ...overrides
  };
}

/** A valid `AuthTokenResponse` body. */
export function tokenBody(accessToken: string, user: CurrentUser = makeUser()): AuthTokenResponse {
  return {
    accessToken,
    accessTokenExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    user
  };
}

/** A contract error envelope. */
export function errorBody(code: ErrorCode, message = "Error de prueba."): ApiError {
  return { error: { code, message } };
}

/** Preloaded `auth` state for a logged-in user. */
export function authenticatedState(user: CurrentUser = makeUser(), accessToken = "token-1"): Pick<RootState, "auth"> {
  const auth: AuthState = {
    ...initialAuthState,
    accessToken,
    user,
    status: "authenticated",
    passwordChangeRequired: user.mustChangePassword
  };
  return { auth };
}

/** Preloaded `auth` state with a given status and no session. */
export function statusState(status: AuthState["status"]): Pick<RootState, "auth"> {
  return { auth: { ...initialAuthState, status } };
}
