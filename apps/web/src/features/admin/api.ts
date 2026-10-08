import type {
  AdminForcePasswordResetResult,
  AdminInviteCandidate,
  AdminInviteCandidates,
  AdminInviteCandidatesQueryRequest,
  AdminInviteCreated,
  AdminInviteCreateRequest,
  AdminInviteListItem,
  AdminSummary,
  AdminUserListItem,
  AdminUserPatchRequest,
  AuditLogEntry,
  InviteStatus,
  Page,
  UserRole,
  UserStatus
} from "@cuencada/types";
import { baseApi } from "../../shared/api/baseApi";

/** Rows per keyset page in the admin lists. */
export const ADMIN_PAGE_SIZE = 25;

/** Every invite list (all filters). */
const INVITE_LIST = { type: "Invite", id: "LIST" } as const;
/** Invite picker rows and per-person invite status (WP-4.2): any invite write can change `pendingInvite`. */
const INVITE_CANDIDATES = { type: "Invite", id: "CANDIDATES" } as const;
/** Every admin users list; T6's account picker provides the same tag, so it refreshes too. */
const USER_LIST = { type: "AdminUser", id: "LIST" } as const;
/** The dashboard counters. They depend on users and invites, so their writes invalidate it. */
const SUMMARY = { type: "AdminUser", id: "SUMMARY" } as const;
/** Every audit log page: each admin write adds a row. */
const AUDIT_LIST = { type: "AuditLog", id: "LIST" } as const;

/** Filters of the invite list (`GET /admin/invites`). */
export interface InviteListFilter {
  status?: InviteStatus;
}

/** Filters of the users list (`GET /admin/users`). */
export interface UserListFilter {
  q?: string;
  role?: UserRole;
  status?: UserStatus;
  /** `false`: only unverified emails (`GET /admin/users?emailVerified=false`, WP-0.8b). */
  emailVerified?: boolean;
}

/** Filters of the audit log (`GET /admin/audit-logs`); dates are ISO instants. */
export interface AuditLogFilter {
  action?: string;
  entityType?: string;
  actorUserId?: string;
  from?: string;
  to?: string;
}

/** `PATCH /admin/users/:id` args. */
export interface UpdateAdminUserArgs {
  id: string;
  patch: AdminUserPatchRequest;
}

/** Query params for one keyset page: the filter, the page size and the cursor (omitted on the first page). */
function pageParams<TFilter extends object>(filter: TFilter, cursor: string | null): TFilter & { limit: number; cursor?: string } {
  return cursor === null ? { ...filter, limit: ADMIN_PAGE_SIZE } : { ...filter, limit: ADMIN_PAGE_SIZE, cursor };
}

/**
 * Admin console endpoints (T8): dashboard summary, invites (T1-BE), users and
 * the read-only audit log (T8-BE). Lists are RTK infinite queries over the
 * server's keyset cursors ("Cargar más").
 */
export const adminApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    /** `GET /admin/summary`: dashboard counters. */
    getAdminSummary: build.query<AdminSummary, void>({
      query: () => ({ url: "/admin/summary" }),
      providesTags: [SUMMARY]
    }),

    /** `GET /admin/invites`, newest first. */
    listAdminInvites: build.infiniteQuery<Page<AdminInviteListItem>, InviteListFilter, string | null>({
      infiniteQueryOptions: { initialPageParam: null, getNextPageParam: (lastPage) => lastPage.nextCursor },
      query: ({ queryArg, pageParam }) => ({ url: "/admin/invites", params: pageParams(queryArg, pageParam) }),
      providesTags: [INVITE_LIST]
    }),
    /** `POST /admin/invites`. The result may carry the one-time `inviteUrl`: never cache or log it. */
    createAdminInvite: build.mutation<AdminInviteCreated, AdminInviteCreateRequest>({
      query: (body) => ({ url: "/admin/invites", method: "POST", body }),
      invalidatesTags: (_result, error) => (error ? [] : [INVITE_LIST, INVITE_CANDIDATES, SUMMARY, AUDIT_LIST])
    }),
    /** `POST /admin/invites/:id/revoke` (idempotent; 409 once accepted). */
    revokeAdminInvite: build.mutation<AdminInviteListItem, string>({
      query: (id) => ({ url: `/admin/invites/${encodeURIComponent(id)}/revoke`, method: "POST" }),
      invalidatesTags: (_result, error) => (error ? [] : [INVITE_LIST, INVITE_CANDIDATES, SUMMARY, AUDIT_LIST])
    }),
    /** `GET /admin/invites/people?q=` (WP-4.2): living people without an account, for the invite picker. */
    searchInviteCandidates: build.query<AdminInviteCandidates, AdminInviteCandidatesQueryRequest>({
      query: (params) => ({ url: "/admin/invites/people", params }),
      providesTags: [INVITE_CANDIDATES]
    }),
    /** `GET /admin/invites/people/:id` (WP-4.2): one person's invite status (linked, deceased, pending). */
    getInviteCandidate: build.query<AdminInviteCandidate, string>({
      query: (id) => ({ url: `/admin/invites/people/${encodeURIComponent(id)}` }),
      providesTags: [INVITE_CANDIDATES]
    }),
    /** `POST /admin/invites/:id/resend`: new token by email; the previous link stops working. */
    resendAdminInvite: build.mutation<AdminInviteListItem, string>({
      query: (id) => ({ url: `/admin/invites/${encodeURIComponent(id)}/resend`, method: "POST" }),
      invalidatesTags: (_result, error) => (error ? [] : [INVITE_LIST, AUDIT_LIST])
    }),

    /** `GET /admin/users`, newest first. `q` matches name or email. */
    listAdminUsers: build.infiniteQuery<Page<AdminUserListItem>, UserListFilter, string | null>({
      infiniteQueryOptions: { initialPageParam: null, getNextPageParam: (lastPage) => lastPage.nextCursor },
      query: ({ queryArg, pageParam }) => ({ url: "/admin/users", params: pageParams(queryArg, pageParam) }),
      providesTags: [USER_LIST]
    }),
    /** `PATCH /admin/users/:id`: role, status (disabling revokes every session). */
    updateAdminUser: build.mutation<AdminUserListItem, UpdateAdminUserArgs>({
      query: ({ id, patch }) => ({ url: `/admin/users/${encodeURIComponent(id)}`, method: "PATCH", body: patch }),
      invalidatesTags: (_result, error) => (error ? [] : [USER_LIST, SUMMARY, AUDIT_LIST])
    }),
    /** `POST /admin/users/:id/revoke-sessions` (204). */
    revokeAdminUserSessions: build.mutation<void, string>({
      query: (id) => ({ url: `/admin/users/${encodeURIComponent(id)}/revoke-sessions`, method: "POST" }),
      invalidatesTags: (_result, error) => (error ? [] : [USER_LIST, AUDIT_LIST])
    }),
    /** `POST /admin/users/:id/force-password-reset`; `emailQueued` says whether the reset email went out. */
    forceAdminPasswordReset: build.mutation<AdminForcePasswordResetResult, string>({
      query: (id) => ({ url: `/admin/users/${encodeURIComponent(id)}/force-password-reset`, method: "POST" }),
      invalidatesTags: (_result, error) => (error ? [] : [USER_LIST, AUDIT_LIST])
    }),
    /** `POST /admin/users/:id/verify-email` (idempotent). */
    verifyAdminUserEmail: build.mutation<AdminUserListItem, string>({
      query: (id) => ({ url: `/admin/users/${encodeURIComponent(id)}/verify-email`, method: "POST" }),
      invalidatesTags: (_result, error) => (error ? [] : [USER_LIST, SUMMARY, AUDIT_LIST])
    }),

    /** `GET /admin/audit-logs`, newest first (read-only: there is no write endpoint). */
    listAuditLogs: build.infiniteQuery<Page<AuditLogEntry>, AuditLogFilter, string | null>({
      infiniteQueryOptions: { initialPageParam: null, getNextPageParam: (lastPage) => lastPage.nextCursor },
      query: ({ queryArg, pageParam }) => ({ url: "/admin/audit-logs", params: pageParams(queryArg, pageParam) }),
      providesTags: [AUDIT_LIST]
    })
  })
});

export const {
  useGetAdminSummaryQuery,
  useListAdminInvitesInfiniteQuery,
  useCreateAdminInviteMutation,
  useRevokeAdminInviteMutation,
  useResendAdminInviteMutation,
  useSearchInviteCandidatesQuery,
  useGetInviteCandidateQuery,
  useListAdminUsersInfiniteQuery,
  useUpdateAdminUserMutation,
  useRevokeAdminUserSessionsMutation,
  useForceAdminPasswordResetMutation,
  useVerifyAdminUserEmailMutation,
  useListAuditLogsInfiniteQuery
} = adminApi;
