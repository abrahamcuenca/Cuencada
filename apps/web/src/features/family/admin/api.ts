import type {
  AdminCreatePersonRequest,
  AdminUpdatePersonRequest,
  AdminUserListItem,
  AdminUserListQueryRequest,
  CreateRelationshipRequest,
  FamilyActivityItem,
  FamilyActivityQueryRequest,
  Page,
  Person,
  PersonRevision,
  PersonRevisionsQueryRequest,
  PurgePersonRevisionsResponse,
  Relationship
} from "@cuencada/types";
import { baseApi } from "../../../shared/api/baseApi";
import { FAMILY_TREE_ALL, PERSON_LIST, REVISION_LIST } from "../api";

/** `PATCH /admin/people/:id` args. */
export interface UpdatePersonArgs {
  id: string;
  patch: AdminUpdatePersonRequest;
}

/** `DELETE /admin/people/:id` args. */
export interface DeletePersonArgs {
  id: string;
  /** "Borrar también el historial": purge the person's revisions first. */
  purgeHistory: boolean;
}

/** `GET /admin/people/:id/revisions` args. */
export interface PersonRevisionsArgs extends PersonRevisionsQueryRequest {
  personId: string;
}

/**
 * Admin people, relationship and revision endpoints (T6, WP-4.1), injected
 * only when an admin family screen loads. Every write invalidates every
 * cached tree view (one edge changes the rings of several people) and the
 * revision lists.
 */
export const familyAdminApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    createPerson: build.mutation<Person, AdminCreatePersonRequest>({
      query: (body) => ({ url: "/admin/people", method: "POST", body }),
      invalidatesTags: (_result, _error, body) => [
        PERSON_LIST,
        FAMILY_TREE_ALL,
        REVISION_LIST,
        ...(body.relateTo ? [{ type: "Person" as const, id: body.relateTo.personId }] : [])
      ]
    }),
    updatePerson: build.mutation<Person, UpdatePersonArgs>({
      query: ({ id, patch }) => ({
        url: `/admin/people/${encodeURIComponent(id)}`,
        method: "PATCH",
        body: patch
      }),
      invalidatesTags: (_result, _error, { id }) => [{ type: "Person", id }, PERSON_LIST, FAMILY_TREE_ALL, REVISION_LIST]
    }),
    deletePerson: build.mutation<void, DeletePersonArgs>({
      query: ({ id, purgeHistory }) => ({
        url: `/admin/people/${encodeURIComponent(id)}`,
        method: "DELETE",
        ...(purgeHistory ? { params: { purgeHistory: "true" } } : {})
      }),
      invalidatesTags: (_result, _error, { id }) => [{ type: "Person", id }, PERSON_LIST, FAMILY_TREE_ALL, REVISION_LIST]
    }),
    createRelationship: build.mutation<Relationship, CreateRelationshipRequest>({
      query: (body) => ({
        url: "/admin/relationships",
        method: "POST",
        body
      }),
      invalidatesTags: (_result, _error, body) => [
        FAMILY_TREE_ALL,
        REVISION_LIST,
        { type: "Relationship", id: "LIST" },
        { type: "Person", id: body.fromPersonId },
        { type: "Person", id: body.toPersonId }
      ]
    }),
    deleteRelationship: build.mutation<void, string>({
      query: (id) => ({
        url: `/admin/relationships/${encodeURIComponent(id)}`,
        method: "DELETE"
      }),
      invalidatesTags: [FAMILY_TREE_ALL, REVISION_LIST, { type: "Relationship", id: "LIST" }]
    }),
    /**
     * `GET /admin/users?q=`, used only to pick the account to link to a person.
     * Named for this feature so it never collides with T8's users list.
     */
    searchUsersForPersonLink: build.query<Page<AdminUserListItem>, AdminUserListQueryRequest>({
      query: (params) => ({ url: "/admin/users", params }),
      providesTags: [{ type: "AdminUser", id: "LIST" }]
    }),
    /** `GET /admin/people/:id/revisions`: the person's "Historial", newest first. */
    getPersonRevisions: build.query<Page<PersonRevision>, PersonRevisionsArgs>({
      query: ({ personId, ...params }) => ({ url: `/admin/people/${encodeURIComponent(personId)}/revisions`, params }),
      providesTags: [REVISION_LIST]
    }),
    /** `GET /admin/family/activity`: every family change ("Actividad del árbol"). */
    getFamilyActivity: build.query<Page<FamilyActivityItem>, FamilyActivityQueryRequest>({
      query: (params) => ({ url: "/admin/family/activity", params }),
      providesTags: [REVISION_LIST]
    }),
    /** `POST /admin/revisions/:revisionId/revert` ("Deshacer"). */
    revertRevision: build.mutation<PersonRevision, string>({
      query: (revisionId) => ({ url: `/admin/revisions/${encodeURIComponent(revisionId)}/revert`, method: "POST" }),
      // An undo can change any person, edge or tree view.
      invalidatesTags: [REVISION_LIST, FAMILY_TREE_ALL, PERSON_LIST, "Person", { type: "Relationship", id: "LIST" }]
    }),
    /** `POST /admin/people/:id/revisions/purge` ("Borrar historial"). */
    purgePersonRevisions: build.mutation<PurgePersonRevisionsResponse, string>({
      query: (personId) => ({
        url: `/admin/people/${encodeURIComponent(personId)}/revisions/purge`,
        method: "POST",
        body: { confirm: true }
      }),
      invalidatesTags: [REVISION_LIST]
    })
  })
});

export const {
  useCreatePersonMutation,
  useUpdatePersonMutation,
  useDeletePersonMutation,
  useCreateRelationshipMutation,
  useDeleteRelationshipMutation,
  useSearchUsersForPersonLinkQuery,
  useGetPersonRevisionsQuery,
  useGetFamilyActivityQuery,
  useRevertRevisionMutation,
  usePurgePersonRevisionsMutation
} = familyAdminApi;
