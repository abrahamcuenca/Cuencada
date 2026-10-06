import { baseApi } from "../../shared/api/baseApi";

/**
 * PWA (service worker, update prompt; no routes) endpoints, owned by T9. Add them here with
 * `build.query` / `build.mutation`, using the tags declared in `baseApi`.
 * See docs/coordination/WP-0.6.md.
 */
export const pwaApi = baseApi.injectEndpoints({
  endpoints: () => ({})
});
