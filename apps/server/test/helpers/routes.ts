/**
 * Route inventory for the security suite (WP-2.3). `buildApp` registers every
 * module before it returns, so an `onRoute` hook added afterwards would miss
 * them. A test file instead mocks `fastify` with {@link recordingFastify},
 * which installs the collector on the root instance before any plugin runs:
 *
 * ```ts
 * vi.mock("fastify", async (importOriginal) => {
 *   const actual = await importOriginal<typeof import("fastify")>();
 *   const { recordingFastify } = await import("../../../test/helpers/routes.js");
 *   const factory = recordingFastify(actual.default);
 *   return { ...actual, default: factory, fastify: factory };
 * });
 * ```
 */
import type { RouteOptions } from "fastify";

/** One registered route (one entry per method) as the auth guard sees it. */
export interface RouteRecord {
  method: string;
  url: string;
  /** `config.auth`, or `null` when the route did not declare it (the guard then defaults to `"user"`). */
  auth: string | null;
  requireVerifiedEmail: boolean;
  allowPendingPasswordChange: boolean;
  websocket: boolean;
}

/** Routes collected by every app built while the mock is active (append-only). */
export const recordedRoutes: RouteRecord[] = [];

/** The guard-relevant keys of a route's `config`. */
interface GuardConfig {
  auth?: unknown;
  requireVerifiedEmail?: unknown;
  allowPendingPasswordChange?: unknown;
}

/**
 * Record `route` into {@link recordedRoutes}.
 *
 * @param route - Options passed to the `onRoute` hook.
 */
export function recordRoute(route: RouteOptions): void {
  // `config` is the app's FastifyContextConfig; only the guard keys are read, as unknowns.
  const config: GuardConfig = (route.config ?? {}) as GuardConfig;
  const methods = Array.isArray(route.method) ? route.method : [route.method];
  for (const method of methods) {
    recordedRoutes.push({
      method,
      url: route.url,
      auth: typeof config.auth === "string" ? config.auth : null,
      requireVerifiedEmail: config.requireVerifiedEmail === true,
      allowPendingPasswordChange: config.allowPendingPasswordChange === true,
      websocket: (route as { websocket?: unknown }).websocket === true
    });
  }
}

/** The part of a Fastify instance the recorder needs. */
interface HookTarget {
  addHook(name: "onRoute", hook: (route: RouteOptions) => void): unknown;
}

/**
 * Wrap the real Fastify factory so every instance records its routes.
 *
 * @param factory - The real `fastify` default export.
 * @returns A factory with the same signature.
 */
export function recordingFastify<TFactory extends (...args: never[]) => unknown>(factory: TFactory): TFactory {
  const wrapped = (...args: Parameters<TFactory>): ReturnType<TFactory> => {
    const app = factory(...args);
    // The real factory returns a FastifyInstance, which has addHook.
    (app as HookTarget).addHook("onRoute", recordRoute);
    return app as ReturnType<TFactory>;
  };
  // Same call signature as the wrapped factory.
  return wrapped as unknown as TFactory;
}
