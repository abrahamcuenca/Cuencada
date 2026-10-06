import { baseApi } from "../../shared/api/baseApi";

/**
 * Media gallery endpoints, owned by T4. Add them here with
 * `build.query` / `build.mutation`, using the tags declared in `baseApi`.
 * See docs/coordination/WP-0.6.md.
 */
export const galleryApi = baseApi.injectEndpoints({
  endpoints: () => ({})
});
