import { baseApi } from "../../shared/api/baseApi";

/**
 * Admin console (`/admin/*` lets the admin page own nested routes) endpoints, owned by T8. Add them here with
 * `build.query` / `build.mutation`, using the tags declared in `baseApi`.
 * See docs/coordination/WP-0.6.md.
 */
export const adminApi = baseApi.injectEndpoints({
  endpoints: () => ({})
});
