import { baseApi } from "../../shared/api/baseApi";

/**
 * Family directory endpoints, owned by T5. Add them here with
 * `build.query` / `build.mutation`, using the tags declared in `baseApi`.
 * See docs/coordination/WP-0.6.md.
 */
export const directoryApi = baseApi.injectEndpoints({
  endpoints: () => ({})
});
