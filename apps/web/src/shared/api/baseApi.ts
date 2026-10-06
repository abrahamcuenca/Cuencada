/**
 * The single RTK Query API slice for the whole app (Phase 0 owned; frozen).
 *
 * Phase-1 tracks never edit this file. They add endpoints from their own
 * `features/<f>/api.ts` with `baseApi.injectEndpoints(...)` and use the tag
 * types declared here. See docs/coordination/WP-0.6.md.
 */
import { createApi } from "@reduxjs/toolkit/query/react";
import { baseQueryWithReauth } from "./reauth";

/**
 * Every cache tag in the app, declared up front so tracks never need to edit
 * this file. Grouped by owning track.
 */
export const API_TAG_TYPES = [
  // T1 auth
  "CurrentUser",
  "Session",
  "Invite",
  // T2 cuencadas
  "Cuencada",
  "CuencadaHome",
  "Itinerary",
  "Location",
  "DailyMessage",
  "Announcement",
  // T3 rsvp
  "Rsvp",
  "RsvpSummary",
  "Attendee",
  "Attendance",
  // T4 media
  "Media",
  "MediaReport",
  // T5 profile and directory
  "Profile",
  "Directory",
  // T6 family
  "Person",
  "Relationship",
  "FamilyTree",
  // T7 chat
  "ChatRoom",
  "ChatMessage",
  // T8 admin
  "AdminUser",
  "AuditLog"
] as const;

/** Union of every declared cache tag. */
export type ApiTagType = (typeof API_TAG_TYPES)[number];

/** The app-wide API slice. Endpoints are injected per feature. */
export const baseApi = createApi({
  reducerPath: "api",
  baseQuery: baseQueryWithReauth,
  tagTypes: API_TAG_TYPES,
  // Refetch active queries when the browser comes back online (needs `setupListeners`, wired in bootstrap).
  // Pairs with the offline refresh retry: queries that failed while offline recover by themselves.
  refetchOnReconnect: true,
  endpoints: () => ({})
});
