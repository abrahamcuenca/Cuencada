import { baseApi } from "../../shared/api/baseApi";

/**
 * Profile endpoints, owned by T5. Add them here with
 * `build.query` / `build.mutation`, using the tags declared in `baseApi`.
 * See docs/coordination/WP-0.6.md.
 */
export const profileApi = baseApi.injectEndpoints({
  endpoints: () => ({})
});
