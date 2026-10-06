import type { FamilyTreeQueryRequest, FamilyTreeView, Page, PeopleQueryRequest, Person, PersonSummary, SelfEditPersonRequest } from "@cuencada/types";
import { baseApi } from "../../shared/api/baseApi";

/** Cache tag for every tree view: any people/relationship change invalidates it. */
export const FAMILY_TREE_ALL = { type: "FamilyTree", id: "ALL" } as const;
/** Cache tag for every people search page. */
export const PERSON_LIST = { type: "Person", id: "LIST" } as const;

/**
 * Member family endpoints (T6). Tree data is PII: these reads are member-only
 * on the server (403 for unverified accounts, see ADR 0001 / WP-T6-FE).
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
    /** `GET /family/people/:id`: the full `Person` (years, branch). */
    getPerson: build.query<Person, string>({
      query: (id) => `/family/people/${encodeURIComponent(id)}`,
      providesTags: (_result, _error, id) => [{ type: "Person", id }]
    }),
    /** `PATCH /family/me`: limited self-edit of the caller's linked person. */
    updateMyPerson: build.mutation<Person, SelfEditPersonRequest>({
      query: (body) => ({ url: "/family/me", method: "PATCH", body }),
      invalidatesTags: (result) => [FAMILY_TREE_ALL, PERSON_LIST, ...(result ? [{ type: "Person" as const, id: result.id }] : [])]
    })
  })
});

export const { useGetFamilyTreeQuery, useSearchPeopleQuery, useGetPersonQuery, useUpdateMyPersonMutation } = familyApi;
