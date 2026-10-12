import type {
  CreateTreeLinkProposalRequest,
  DisconnectedBranchReport,
  DisconnectedBranchesQueryRequest,
  ExtendedFamily,
  FamilySettings,
  Page,
  ResolveTreeLinkProposalRequest,
  TreeLinkProposal,
  TreeLinkProposalGroup,
  TreeLinkProposalListQueryRequest,
  TreeOverview,
  TreeOverviewPath,
  TreeOverviewQueryRequest,
  UpdateFamilySettingsRequest
} from "@cuencada/types";
import { baseApi } from "../../../shared/api/baseApi";
import { FAMILY_TREE_ALL, PERSON_LIST, REVISION_LIST } from "../api";

/**
 * Cache tags (reserved `Person` ids, so the shared tag list in `baseApi.ts`
 * stays untouched): proposals (own and admin queue), the root setting and
 * the "Ramas sin conectar" report. Tree reads use {@link FAMILY_TREE_ALL},
 * which every family write already invalidates.
 */
export const PROPOSAL_LIST = { type: "Person", id: "PROPOSALS" } as const;
export const FAMILY_SETTINGS = { type: "Person", id: "SETTINGS" } as const;
export const BRANCH_REPORT = { type: "Person", id: "BRANCHES" } as const;

/** `POST /admin/family/proposals/:id/resolve` args. */
export interface ResolveProposalArgs extends ResolveTreeLinkProposalRequest {
  id: string;
}

/**
 * "One family tree" endpoints (WP-6.4), injected only when a lazy screen
 * that needs them loads (the tree page's bands, "Árbol completo", the
 * proposal dialog and the admin pages), so none of this is in the initial JS.
 */
export const oneTreeApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    /** `GET /family/tree/extended`: tíos, primos, tíos abuelos. */
    getExtendedFamily: build.query<ExtendedFamily, string | undefined>({
      query: (personId) => ({ url: "/family/tree/extended", params: personId === undefined ? {} : { personId } }),
      providesTags: [FAMILY_TREE_ALL]
    }),
    /** `GET /family/overview`: "Árbol completo", one slice of generations. */
    getTreeOverview: build.query<TreeOverview, TreeOverviewQueryRequest>({
      query: (params) => ({ url: "/family/overview", params }),
      providesTags: [FAMILY_TREE_ALL, FAMILY_SETTINGS]
    }),
    /** `GET /family/overview/path`: root → person ("Ir a mí", search). */
    getTreeOverviewPath: build.query<TreeOverviewPath, string>({
      query: (personId) => ({ url: "/family/overview/path", params: { personId } }),
      providesTags: [FAMILY_TREE_ALL, FAMILY_SETTINGS]
    }),
    /** `GET /family/settings`: the root ancestor. */
    getFamilySettings: build.query<FamilySettings, void>({
      query: () => "/family/settings",
      providesTags: [FAMILY_SETTINGS]
    }),
    /** `GET /family/proposals`: "Mis propuestas". */
    getMyProposals: build.query<Page<TreeLinkProposal>, TreeLinkProposalListQueryRequest>({
      query: (params) => ({ url: "/family/proposals", params }),
      providesTags: [PROPOSAL_LIST]
    }),
    /** `POST /family/proposals`: "Es la misma persona…" / "Conectar con…". */
    createProposal: build.mutation<TreeLinkProposal, CreateTreeLinkProposalRequest>({
      query: (body) => ({ url: "/family/proposals", method: "POST", body }),
      invalidatesTags: [PROPOSAL_LIST]
    }),
    /** `DELETE /family/proposals/:id`: "Retirar". */
    withdrawProposal: build.mutation<void, string>({
      query: (id) => ({ url: `/family/proposals/${encodeURIComponent(id)}`, method: "DELETE" }),
      invalidatesTags: [PROPOSAL_LIST]
    }),
    /** `GET /admin/family/proposals`: "Propuestas del árbol", grouped by pair. */
    getProposalGroups: build.query<Page<TreeLinkProposalGroup>, TreeLinkProposalListQueryRequest>({
      query: (params) => ({ url: "/admin/family/proposals", params }),
      providesTags: [PROPOSAL_LIST]
    }),
    /** `POST /admin/family/proposals/:id/resolve`: an approval merges or links, so every tree view changes. */
    resolveProposal: build.mutation<TreeLinkProposal, ResolveProposalArgs>({
      query: ({ id, ...body }) => ({ url: `/admin/family/proposals/${encodeURIComponent(id)}/resolve`, method: "POST", body }),
      invalidatesTags: [PROPOSAL_LIST, BRANCH_REPORT, FAMILY_SETTINGS, FAMILY_TREE_ALL, PERSON_LIST, REVISION_LIST, "Person", { type: "Relationship", id: "LIST" }]
    }),
    /** `GET /admin/family/settings`. */
    getAdminFamilySettings: build.query<FamilySettings, void>({
      query: () => "/admin/family/settings",
      providesTags: [FAMILY_SETTINGS]
    }),
    /** `PUT /admin/family/settings`: "Raíz del árbol". */
    updateFamilySettings: build.mutation<FamilySettings, UpdateFamilySettingsRequest>({
      query: (body) => ({ url: "/admin/family/settings", method: "PUT", body }),
      invalidatesTags: [FAMILY_SETTINGS, BRANCH_REPORT]
    }),
    /** `GET /admin/family/branches`: "Ramas sin conectar". */
    getDisconnectedBranches: build.query<DisconnectedBranchReport, DisconnectedBranchesQueryRequest>({
      query: (params) => ({ url: "/admin/family/branches", params }),
      providesTags: [BRANCH_REPORT, FAMILY_TREE_ALL]
    })
  })
});

export const {
  useGetExtendedFamilyQuery,
  useGetTreeOverviewQuery,
  useLazyGetTreeOverviewQuery,
  useLazyGetTreeOverviewPathQuery,
  useGetFamilySettingsQuery,
  useGetMyProposalsQuery,
  useCreateProposalMutation,
  useWithdrawProposalMutation,
  useGetProposalGroupsQuery,
  useResolveProposalMutation,
  useGetAdminFamilySettingsQuery,
  useUpdateFamilySettingsMutation,
  useGetDisconnectedBranchesQuery
} = oneTreeApi;
