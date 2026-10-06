import { baseApi } from "../../shared/api/baseApi";

/**
 * RSVP and attendance (rendered inside Cuencada pages; no routes yet) endpoints, owned by T3. Add them here with
 * `build.query` / `build.mutation`, using the tags declared in `baseApi`.
 * See docs/coordination/WP-0.6.md.
 */
export const rsvpApi = baseApi.injectEndpoints({
  endpoints: () => ({})
});
