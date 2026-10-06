import type {
  AdminAttendanceBulkRequest,
  AdminRsvpRow,
  Attendee,
  AttendanceRecord,
  MyRsvp,
  MyRsvpResponse,
  Page,
  PeopleQueryRequest,
  PersonSummary,
  RsvpSummary,
  UpsertRsvpRequest
} from "@cuencada/types";
import { baseApi } from "../../shared/api/baseApi";

/** Arguments of {@link rsvpApi} `putMyRsvp`. */
export interface PutMyRsvpArgs {
  year: number;
  body: UpsertRsvpRequest;
  /**
   * The RSVP to show while the request is in flight. The cache is patched
   * with it right away (optimistic) and rolled back if the server refuses.
   */
  optimistic: MyRsvp;
}

/** Arguments of {@link rsvpApi} `saveAdminAttendance`. */
export interface SaveAttendanceArgs {
  cuencadaId: string;
  body: AdminAttendanceBulkRequest;
}

const yearPath = (year: number): string => `/cuencadas/${encodeURIComponent(String(year))}`;
const adminPath = (id: string): string => `/admin/cuencadas/${encodeURIComponent(id)}`;

/**
 * RSVP and attendance endpoints (T3).
 *
 * - Member reads (`rsvp/me`, `rsvp/summary`, `attendees`) are keyed by year.
 * - Admin reads/writes are keyed by the Cuencada id and only imported by the
 *   lazy admin page, so they cost nothing for members.
 * - The CSV export is fetched with the normal authenticated base query
 *   (Bearer header, no token in any URL) and returned as text; the page turns
 *   it into a Blob download and resets the mutation so the PII does not stay
 *   in the store.
 */
export const rsvpApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    getMyRsvp: build.query<MyRsvpResponse, number>({
      query: (year) => `${yearPath(year)}/rsvp/me`,
      providesTags: (_result, _error, year) => [{ type: "Rsvp", id: `me:${year}` }]
    }),
    putMyRsvp: build.mutation<MyRsvp, PutMyRsvpArgs>({
      query: ({ year, body }) => ({ url: `${yearPath(year)}/rsvp/me`, method: "PUT", body }),
      async onQueryStarted({ year, optimistic }, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          rsvpApi.util.updateQueryData("getMyRsvp", year, (draft) => {
            draft.rsvp = optimistic;
          })
        );
        try {
          const { data } = await queryFulfilled;
          dispatch(
            rsvpApi.util.updateQueryData("getMyRsvp", year, (draft) => {
              draft.rsvp = data;
            })
          );
        } catch {
          // The caller shows the error; here we only roll the optimistic patch back.
          patch.undo();
        }
      },
      invalidatesTags: (_result, error, { year }) =>
        error
          ? []
          : [
              { type: "RsvpSummary", id: year },
              { type: "Attendee", id: year }
            ]
    }),
    getRsvpSummary: build.query<RsvpSummary, number>({
      query: (year) => `${yearPath(year)}/rsvp/summary`,
      providesTags: (_result, _error, year) => [{ type: "RsvpSummary", id: year }]
    }),
    listAttendees: build.query<Attendee[], number>({
      query: (year) => `${yearPath(year)}/attendees`,
      providesTags: (_result, _error, year) => [{ type: "Attendee", id: year }]
    }),

    /* ------------------------------- Admin -------------------------------- */
    getAdminAttendance: build.query<AttendanceRecord[], string>({
      query: (id) => `${adminPath(id)}/attendance`,
      providesTags: (_result, _error, id) => [{ type: "Attendance", id }]
    }),
    saveAdminAttendance: build.mutation<AttendanceRecord[], SaveAttendanceArgs>({
      query: ({ cuencadaId, body }) => ({ url: `${adminPath(cuencadaId)}/attendance`, method: "POST", body }),
      async onQueryStarted({ cuencadaId }, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;
          dispatch(rsvpApi.util.upsertQueryData("getAdminAttendance", cuencadaId, data));
        } catch {
          // Nothing was patched; the page reports the error.
        }
      },
      // Attendee strips of every year may change; they are keyed by year, which we don't have here.
      invalidatesTags: (_result, error) => (error ? [] : ["Attendee"])
    }),
    listAdminRsvps: build.query<AdminRsvpRow[], string>({
      query: (id) => `${adminPath(id)}/rsvps`,
      providesTags: (_result, _error, id) => [{ type: "Rsvp", id: `admin:${id}` }]
    }),
    /** `text/csv` as a string. Never cached: callers `reset()` after the download. */
    exportRsvpsCsv: build.mutation<string, string>({
      query: (id) => ({ url: `${adminPath(id)}/rsvps.csv`, responseHandler: "content-type" })
    }),
    /**
     * Family people for the attendance checklist (`GET /family/people`, T6's
     * contract). Named for this use so it never collides with T6's own endpoint.
     */
    listAttendancePeople: build.query<Page<PersonSummary>, PeopleQueryRequest>({
      query: (params) => ({ url: "/family/people", params }),
      providesTags: [{ type: "Person", id: "LIST" }]
    })
  })
});

export const {
  useGetMyRsvpQuery,
  usePutMyRsvpMutation,
  useGetRsvpSummaryQuery,
  useListAttendeesQuery,
  useGetAdminAttendanceQuery,
  useSaveAdminAttendanceMutation,
  useListAdminRsvpsQuery,
  useExportRsvpsCsvMutation,
  useListAttendancePeopleQuery
} = rsvpApi;
