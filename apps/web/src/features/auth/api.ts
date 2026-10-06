import { baseApi } from "../../shared/api/baseApi";

/**
 * Auth and sessions endpoints, owned by T1. Add them here with
 * `build.query` / `build.mutation`, using the tags declared in `baseApi`.
 * See docs/coordination/WP-0.6.md.
 */
export const authApi = baseApi.injectEndpoints({
  endpoints: () => ({})
});
