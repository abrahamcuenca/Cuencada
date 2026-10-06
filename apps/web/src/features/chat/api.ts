import { baseApi } from "../../shared/api/baseApi";

/**
 * Chat endpoints, owned by T7. Add them here with
 * `build.query` / `build.mutation`, using the tags declared in `baseApi`.
 * See docs/coordination/WP-0.6.md.
 */
export const chatApi = baseApi.injectEndpoints({
  endpoints: () => ({})
});
