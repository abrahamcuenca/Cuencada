import type {
  AdminUserListItem,
  AdminUserListQueryRequest,
  CreatePersonRequest,
  CreateRelationshipRequest,
  Page,
  Person,
  Relationship,
  UpdatePersonRequest
} from "@cuencada/types";
import { baseApi } from "../../../shared/api/baseApi";
import { FAMILY_TREE_ALL, PERSON_LIST } from "../api";

/** `PATCH /admin/people/:id` args. */
export interface UpdatePersonArgs {
  id: string;
  patch: UpdatePersonRequest;
}

/**
 * Admin people and relationship endpoints (T6), injected only when an admin
 * family screen loads. Every write invalidates every cached tree view, since
 * one edge changes the rings of several people.
 */
export const familyAdminApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    createPerson: build.mutation<Person, CreatePersonRequest>({
      query: (body) => ({ url: "/admin/people", method: "POST", body }),
      invalidatesTags: [PERSON_LIST, FAMILY_TREE_ALL]
    }),
    updatePerson: build.mutation<Person, UpdatePersonArgs>({
      query: ({ id, patch }) => ({
        url: `/admin/people/${encodeURIComponent(id)}`,
        method: "PATCH",
        body: patch
      }),
      invalidatesTags: (_result, _error, { id }) => [{ type: "Person", id }, PERSON_LIST, FAMILY_TREE_ALL]
    }),
    deletePerson: build.mutation<void, string>({
      query: (id) => ({
        url: `/admin/people/${encodeURIComponent(id)}`,
        method: "DELETE"
      }),
      invalidatesTags: (_result, _error, id) => [{ type: "Person", id }, PERSON_LIST, FAMILY_TREE_ALL]
    }),
    createRelationship: build.mutation<Relationship, CreateRelationshipRequest>({
      query: (body) => ({
        url: "/admin/relationships",
        method: "POST",
        body
      }),
      invalidatesTags: [FAMILY_TREE_ALL, { type: "Relationship", id: "LIST" }]
    }),
    deleteRelationship: build.mutation<void, string>({
      query: (id) => ({
        url: `/admin/relationships/${encodeURIComponent(id)}`,
        method: "DELETE"
      }),
      invalidatesTags: [FAMILY_TREE_ALL, { type: "Relationship", id: "LIST" }]
    }),
    /**
     * `GET /admin/users?q=`, used only to pick the account to link to a person.
     * Named for this feature so it never collides with T8's users list.
     */
    searchUsersForPersonLink: build.query<Page<AdminUserListItem>, AdminUserListQueryRequest>({
      query: (params) => ({ url: "/admin/users", params }),
      providesTags: [{ type: "AdminUser", id: "LIST" }]
    })
  })
});

export const {
  useCreatePersonMutation,
  useUpdatePersonMutation,
  useDeletePersonMutation,
  useCreateRelationshipMutation,
  useDeleteRelationshipMutation,
  useSearchUsersForPersonLinkQuery
} = familyAdminApi;
