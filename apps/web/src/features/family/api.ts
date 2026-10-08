import type {
  FamilyTreeQueryRequest,
  FamilyTreeView,
  MemberCreatePersonRequest,
  MemberUpdatePersonRequest,
  Page,
  PeopleQueryRequest,
  Person,
  PersonDetails,
  PersonSummary,
  SelfEditPersonRequest
} from "@cuencada/types";
import { baseApi } from "../../shared/api/baseApi";

/** Cache tag for every tree view: any people/relationship change invalidates it. */
export const FAMILY_TREE_ALL = { type: "FamilyTree", id: "ALL" } as const;
/** Cache tag for every people search page. */
export const PERSON_LIST = { type: "Person", id: "LIST" } as const;
/**
 * Cache tag for the admin revision lists (history and activity). A `Person`
 * tag with a reserved id, so the shared tag list (`baseApi.ts`) stays untouched.
 */
export const REVISION_LIST = { type: "Person", id: "REVISIONS" } as const;

/** `PATCH /family/people/:id` args. */
export interface UpdateFamilyPersonArgs {
  id: string;
  patch: MemberUpdatePersonRequest;
}

/**
 * Member family endpoints (T6, WP-4.1). Tree data is PII: these reads are
 * member-only on the server (403 for unverified accounts, see ADR 0001 /
 * WP-T6-FE). Writes are re-checked on the server (own-family circle).
 */
export const familyApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    /** `GET /family/tree`. Without `personId` the caller's own node is the focus (404 if not linked). */
    getFamilyTree: build.query<FamilyTreeView, FamilyTreeQueryRequest>({
      query: (params) => ({ url: "/family/tree", params }),
      providesTags: (result) => [FAMILY_TREE_ALL, ...(result ? [{ type: "Person" as const, id: result.focus.id }] : [])]
    }),
    /** `GET /family/people?q=`: search by name or nickname. */
    searchPeople: build.query<Page<PersonSummary>, PeopleQueryRequest>({
      query: (params) => ({ url: "/family/people", params }),
      providesTags: (result) => [
        PERSON_LIST,
        ...(result?.items ?? []).map((person) => ({
          type: "Person" as const,
          id: person.id
        }))
      ]
    }),
    /** `GET /family/people/:id`: the person's card (`PersonDetails`: dates, permissions, photo, contacts). */
    getPerson: build.query<PersonDetails, string>({
      query: (id) => `/family/people/${encodeURIComponent(id)}`,
      providesTags: (_result, _error, id) => [{ type: "Person", id }]
    }),
    /** `PATCH /family/me`: limited self-edit of the caller's linked person. */
    updateMyPerson: build.mutation<Person, SelfEditPersonRequest>({
      query: (body) => ({ url: "/family/me", method: "PATCH", body }),
      invalidatesTags: (result) => [FAMILY_TREE_ALL, PERSON_LIST, REVISION_LIST, ...(result ? [{ type: "Person" as const, id: result.id }] : [])]
    }),
    /** `POST /family/people`: add a new relative attached to someone in the member's circle. */
    createFamilyPerson: build.mutation<PersonDetails, MemberCreatePersonRequest>({
      query: (body) => ({ url: "/family/people", method: "POST", body }),
      invalidatesTags: (_result, _error, body) => [FAMILY_TREE_ALL, PERSON_LIST, REVISION_LIST, { type: "Person", id: body.relateTo.personId }]
    }),
    /** `PATCH /family/people/:id`: edit someone in the member's circle. */
    updateFamilyPerson: build.mutation<PersonDetails, UpdateFamilyPersonArgs>({
      query: ({ id, patch }) => ({ url: `/family/people/${encodeURIComponent(id)}`, method: "PATCH", body: patch }),
      invalidatesTags: (_result, _error, { id }) => [{ type: "Person", id }, FAMILY_TREE_ALL, PERSON_LIST, REVISION_LIST]
    }),
    /** `DELETE /family/people/:id`: remove the member's own unlinked addition. */
    deleteFamilyPerson: build.mutation<void, string>({
      query: (id) => ({ url: `/family/people/${encodeURIComponent(id)}`, method: "DELETE" }),
      invalidatesTags: (_result, _error, id) => [{ type: "Person", id }, FAMILY_TREE_ALL, PERSON_LIST, REVISION_LIST]
    })
  })
});

export const {
  useGetFamilyTreeQuery,
  useSearchPeopleQuery,
  useGetPersonQuery,
  useUpdateMyPersonMutation,
  useCreateFamilyPersonMutation,
  useUpdateFamilyPersonMutation,
  useDeleteFamilyPersonMutation
} = familyApi;
