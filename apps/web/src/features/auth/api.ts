/**
 * Auth, sessions and invite endpoints (T1). Contract: docs/coordination/WP-0.2.md.
 *
 * Logout is **not** here: use the `logout()` thunk from `./session`, which
 * owns the epoch, the cross-tab broadcast and the pending-logout marker.
 *
 * [SEC] Mutations that carry a password or a single-use token are started
 * with `dispatch(authApi.endpoints.x.initiate(arg, { track: false }))`, so
 * their arguments never land in `state.api.mutations` (where DevTools or a
 * state dump could read them). Pages keep the pending flag locally.
 */
import type {
  AuthTokenResponse,
  ChangePasswordRequest,
  CurrentUser,
  EmailVerifyConfirmRequest,
  InviteAcceptRequest,
  InviteInspectRequest,
  InviteInspectResponse,
  LoginRequest,
  MagicLinkConsumeRequest,
  MagicLinkRequestRequest,
  OkResponse,
  PasswordResetConfirmRequest,
  PasswordResetRequestRequest,
  SessionListItem
} from "@cuencada/types";
import { baseApi } from "../../shared/api/baseApi";
import { currentUserLoaded } from "./authSlice";
import type { AppThunk } from "./session";

/** `id` path parameter of a session. */
export interface SessionIdArg {
  id: string;
}

export const authApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    /** `POST /auth/login` → `AuthTokenResponse` (generic 401 `INVALID_CREDENTIALS`). */
    login: build.mutation<AuthTokenResponse, LoginRequest>({
      query: (body) => ({ url: "/auth/login", method: "POST", body })
    }),
    /** `GET /me`. Keeps the in-memory user in sync (e.g. after verifying the email). */
    getMe: build.query<CurrentUser, void>({
      query: () => "/me",
      providesTags: [{ type: "CurrentUser", id: "ME" }],
      async onQueryStarted(_arg, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;
          dispatch(currentUserLoaded(data));
        } catch {
          // The error is already on the query result; the base query handles 401/403.
        }
      }
    }),
    /** `POST /auth/change-password` → new `AuthTokenResponse` (other sessions revoked). */
    changePassword: build.mutation<AuthTokenResponse, ChangePasswordRequest>({
      query: (body) => ({ url: "/auth/change-password", method: "POST", body }),
      invalidatesTags: [{ type: "Session", id: "LIST" }]
    }),
    /** `POST /auth/magic-link/request` → always 202 `OkResponse`. */
    requestMagicLink: build.mutation<OkResponse, MagicLinkRequestRequest>({
      query: (body) => ({ url: "/auth/magic-link/request", method: "POST", body })
    }),
    /** `POST /auth/magic-link/consume` → `AuthTokenResponse` · 400 `TOKEN_INVALID`. */
    consumeMagicLink: build.mutation<AuthTokenResponse, MagicLinkConsumeRequest>({
      query: (body) => ({ url: "/auth/magic-link/consume", method: "POST", body })
    }),
    /** `POST /auth/password-reset/request` → always 202 `OkResponse`. */
    requestPasswordReset: build.mutation<OkResponse, PasswordResetRequestRequest>({
      query: (body) => ({ url: "/auth/password-reset/request", method: "POST", body })
    }),
    /** `POST /auth/password-reset/confirm` → 204 · 400 `TOKEN_INVALID`. Revokes every session. */
    confirmPasswordReset: build.mutation<void, PasswordResetConfirmRequest>({
      query: (body) => ({ url: "/auth/password-reset/confirm", method: "POST", body })
    }),
    /** `POST /auth/email/verify-request` → 202. Sends a new verification email to the logged-in user. */
    requestEmailVerification: build.mutation<OkResponse, void>({
      query: () => ({ url: "/auth/email/verify-request", method: "POST" })
    }),
    /** `POST /auth/email/verify` → 204 · 400 `TOKEN_INVALID`. */
    verifyEmail: build.mutation<void, EmailVerifyConfirmRequest>({
      query: (body) => ({ url: "/auth/email/verify", method: "POST", body }),
      invalidatesTags: [{ type: "CurrentUser", id: "ME" }]
    }),
    /** `POST /invites/inspect` → masked invite details · 400 `INVITE_INVALID`. */
    inspectInvite: build.mutation<InviteInspectResponse, InviteInspectRequest>({
      query: (body) => ({ url: "/invites/inspect", method: "POST", body })
    }),
    /** `POST /invites/accept` → 201 `AuthTokenResponse` · 400 `INVITE_INVALID` · 409 `CONFLICT`. */
    acceptInvite: build.mutation<AuthTokenResponse, InviteAcceptRequest>({
      query: (body) => ({ url: "/invites/accept", method: "POST", body })
    }),
    /** `GET /auth/sessions` → the caller's own sessions. */
    listSessions: build.query<SessionListItem[], void>({
      query: () => "/auth/sessions",
      providesTags: (result) => [
        { type: "Session", id: "LIST" },
        ...(result ?? []).map((session) => ({ type: "Session" as const, id: session.id }))
      ]
    }),
    /** `DELETE /auth/sessions/:id` → 204 (own sessions only, otherwise 404). */
    revokeSession: build.mutation<void, SessionIdArg>({
      query: ({ id }) => ({ url: `/auth/sessions/${encodeURIComponent(id)}`, method: "DELETE" }),
      invalidatesTags: (_result, _error, { id }) => [
        { type: "Session", id: "LIST" },
        { type: "Session", id }
      ]
    }),
    /**
     * `POST /auth/logout-all` → 204: revokes every session of the user, this one
     * included, and clears the refresh cookie (T1-BE, contract amendment on
     * `wp/t1-be-auth`).
     * TODO(T1-BE merge): switch "Cerrar sesión en todos los dispositivos" to this
     * endpoint (then finish with a local `loggedOut` + broadcast); until then
     * SessionsPage keeps revoke-others + `logout()`.
     */
    logoutAll: build.mutation<void, void>({
      query: () => ({ url: "/auth/logout-all", method: "POST" }),
      invalidatesTags: [{ type: "Session", id: "LIST" }]
    }),
    /** `POST /auth/sessions/revoke-others` → 204. Every session except this one ends. */
    revokeOtherSessions: build.mutation<void, void>({
      query: () => ({ url: "/auth/sessions/revoke-others", method: "POST" }),
      invalidatesTags: [{ type: "Session", id: "LIST" }]
    })
  })
});

export const {
  useGetMeQuery,
  useListSessionsQuery,
  useRevokeSessionMutation,
  useRevokeOtherSessionsMutation,
  useRequestEmailVerificationMutation
} = authApi;

/**
 * Refetches `GET /me` when there is a session (e.g. after verifying the
 * email), so `emailVerified` and the banner update without a reload.
 *
 * @returns A thunk; does nothing for anonymous visitors.
 */
export function refreshCurrentUser(): AppThunk<void> {
  return (dispatch, getState) => {
    if (getState().auth.status !== "authenticated") return;
    void dispatch(authApi.endpoints.getMe.initiate(undefined, { subscribe: false, forceRefetch: true }));
  };
}
