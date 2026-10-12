/**
 * Two-step verification endpoints (WP-7). Injected lazily: only the login
 * code step, the enrollment page and "Sesiones y seguridad" import this file,
 * so it stays out of the initial bundle.
 *
 * [SEC] Everything that carries a password, a code, a challenge token, the
 * secret or recovery codes is dispatched with `{ track: false }`, so none of
 * it lands in `state.api.mutations`. The setup and recovery-code responses
 * are never cached: they live in component state until the wizard closes.
 */
import type {
  AuthTokenResponse,
  TrustedDevice,
  TwoFactorDisableRequest,
  TwoFactorEnabled,
  TwoFactorEnableRequest,
  TwoFactorRecoveryCodes,
  TwoFactorRegenerateRequest,
  TwoFactorSetup,
  TwoFactorSetupRequest,
  TwoFactorStatus,
  TwoFactorVerifyRequest
} from "@cuencada/types";
import { baseApi } from "../../../shared/api/baseApi";

const STATUS = { type: "TwoFactor", id: "STATUS" } as const;
const DEVICES = { type: "TwoFactor", id: "DEVICES" } as const;

export const twoFactorApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    /** `POST /auth/2fa/verify` → session (400 `TWO_FACTOR_INVALID` wrong code · 400 `TOKEN_INVALID` start over). */
    verifyTwoFactor: build.mutation<AuthTokenResponse, TwoFactorVerifyRequest>({
      query: (body) => ({ url: "/auth/2fa/verify", method: "POST", body })
    }),
    /** `GET /auth/2fa/status`. */
    getTwoFactorStatus: build.query<TwoFactorStatus, void>({
      query: () => "/auth/2fa/status",
      providesTags: [STATUS]
    }),
    /** `POST /auth/2fa/setup` → the pending secret (URI, QR, manual key). Never cached. */
    setupTwoFactor: build.mutation<TwoFactorSetup, TwoFactorSetupRequest>({
      query: (body) => ({ url: "/auth/2fa/setup", method: "POST", body })
    }),
    /** `POST /auth/2fa/enable` → recovery codes (once) + a re-issued access token. */
    enableTwoFactor: build.mutation<TwoFactorEnabled, TwoFactorEnableRequest>({
      query: (body) => ({ url: "/auth/2fa/enable", method: "POST", body }),
      invalidatesTags: (_result, error) => (error ? [] : [STATUS, DEVICES, { type: "Session", id: "LIST" }])
    }),
    /** `POST /auth/2fa/recovery-codes` → 10 new codes (the old ones stop working). */
    regenerateRecoveryCodes: build.mutation<TwoFactorRecoveryCodes, TwoFactorRegenerateRequest>({
      query: (body) => ({ url: "/auth/2fa/recovery-codes", method: "POST", body }),
      invalidatesTags: (_result, error) => (error ? [] : [STATUS])
    }),
    /** `POST /auth/2fa/disable` → 204 (members only). */
    disableTwoFactor: build.mutation<void, TwoFactorDisableRequest>({
      query: (body) => ({ url: "/auth/2fa/disable", method: "POST", body }),
      invalidatesTags: (_result, error) => (error ? [] : [STATUS, DEVICES, { type: "Session", id: "LIST" }])
    }),
    /** `GET /auth/2fa/trusted-devices`. */
    listTrustedDevices: build.query<TrustedDevice[], void>({
      query: () => "/auth/2fa/trusted-devices",
      providesTags: [DEVICES]
    }),
    /** `DELETE /auth/2fa/trusted-devices/:id` → 204. */
    revokeTrustedDevice: build.mutation<void, string>({
      query: (id) => ({ url: `/auth/2fa/trusted-devices/${encodeURIComponent(id)}`, method: "DELETE" }),
      invalidatesTags: (_result, error) => (error ? [] : [DEVICES])
    })
  })
});

export const { useGetTwoFactorStatusQuery, useListTrustedDevicesQuery, useRevokeTrustedDeviceMutation } = twoFactorApi;
