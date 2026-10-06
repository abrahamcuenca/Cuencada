/**
 * Shared MSW setup for web tests that render the app layout.
 *
 * `AppLayout` asks `GET /cuencadas/home` for the "Programa" link (T2), so
 * every test that goes through `renderApp` needs a handler for it. Build the
 * per-file server with {@link createTestServer} and keep
 * `server.listen({ onUnhandledRequest: "error" })`: anything else a test
 * triggers must still be handled explicitly.
 */
import { type HttpHandler, HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { makeMemoriesHome } from "../src/features/cuencadas/testing/fixtures";
import { makeProfile } from "../src/features/profile/testUtils";
import { apiUrl } from "./auth";

/** Handlers every layout-rendering test needs (and what Home fetches). `server.resetHandlers()` restores them. */
export const defaultHandlers: readonly HttpHandler[] = [
  http.get(apiUrl("/cuencadas/home"), () => HttpResponse.json(makeMemoriesHome())),
  // Home page (T2) extras, fetched when a test lands on "/".
  http.get(apiUrl("/cuencadas"), () => HttpResponse.json([])),
  http.get(apiUrl("/announcements"), () => HttpResponse.json({ items: [], nextCursor: null })),
  // `/perfil` and `/directorio` (T5), rendered by guard and redirect tests.
  http.get(apiUrl("/profile/me"), () => HttpResponse.json(makeProfile())),
  http.get(apiUrl("/directory"), () => HttpResponse.json({ items: [], nextCursor: null }))
];

/**
 * @param handlers - The file's own handlers; they take precedence over the defaults.
 * @returns An MSW server with the file's handlers plus {@link defaultHandlers}.
 */
export function createTestServer(...handlers: HttpHandler[]): ReturnType<typeof setupServer> {
  return setupServer(...handlers, ...defaultHandlers);
}
