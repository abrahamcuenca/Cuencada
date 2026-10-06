import { baseApi } from "../../shared/api/baseApi";

/**
 * Family tree endpoints, owned by T6. Add them here with
 * `build.query` / `build.mutation`, using the tags declared in `baseApi`.
 * See docs/coordination/WP-0.6.md.
 */
export const familyApi = baseApi.injectEndpoints({
  endpoints: () => ({})
});
