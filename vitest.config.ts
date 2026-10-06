import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/**
 * Resolve the shared contracts straight from source so tests never depend on
 * a prior `pnpm build` of packages/types.
 */
const sharedAlias = {
  "@cuencada/types": fromRoot("./packages/types/src/index.ts")
};

/** The server also renders emails; resolve them from source too (no `pnpm build` needed). */
const serverAlias = {
  ...sharedAlias,
  "@cuencada/emails": fromRoot("./packages/emails/src/index.ts")
};

// Each project's root is its own package directory. Vite resolves SSR
// externals (drizzle-orm, postgres, argon2, ...) from the project root, and
// with pnpm those packages are only linked under the package that depends on
// them, so a repo-root project root would fail to resolve them.
/**
 * Worker cap shared by every project (Vitest 4: top-level `maxWorkers`,
 * replacing `poolOptions`). Half the cores by default: the server project
 * runs argon2 and real Postgres, the web project jsdom, and on a shared
 * machine or a 4-vCPU CI runner the default (cores - 1) starved them into
 * timeouts. Override with VITEST_MAX_WORKERS (a number or a percentage).
 */
const maxWorkers = process.env.VITEST_MAX_WORKERS ?? "50%";

export default defineConfig({
  test: {
    maxWorkers,
    projects: [
      {
        root: fromRoot("./apps/server"),
        resolve: { alias: serverAlias },
        // packages/emails is TSX.
        esbuild: { jsx: "automatic" },
        test: {
          name: "server",
          environment: "node",
          include: ["**/*.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**"],
          globalSetup: ["./test/globalSetup.ts"],
          setupFiles: ["./test/setup.ts"],
          // argon2 + real Postgres are slower than pure unit tests.
          testTimeout: 15_000,
          hookTimeout: 30_000
        }
      },
      {
        root: fromRoot("./apps/web"),
        resolve: { alias: sharedAlias },
        test: {
          name: "web",
          environment: "jsdom",
          include: ["**/*.test.{ts,tsx}"],
          exclude: ["**/node_modules/**", "**/dist/**"],
          setupFiles: ["./test/setup.ts"],
          // Lazy routes + jsdom under a loaded machine: the 5 s default flaked (WP-0.8a).
          testTimeout: 15_000,
          hookTimeout: 30_000
        }
      },
      {
        root: fromRoot("./packages/types"),
        resolve: { alias: sharedAlias },
        test: {
          name: "types",
          environment: "node",
          include: ["**/*.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**"]
        }
      },
      {
        // Pure guards of the e2e harness (tests/e2e/harness/*.test.ts); the
        // Playwright specs (*.spec.ts) run with `pnpm e2e`, not Vitest.
        root: fromRoot("./tests/e2e"),
        test: {
          name: "e2e-harness",
          environment: "node",
          include: ["harness/**/*.test.ts"]
        }
      },
      {
        root: fromRoot("./packages/emails"),
        // Templates are .tsx; compile JSX with the automatic runtime like tsc does.
        esbuild: { jsx: "automatic" },
        test: {
          name: "emails",
          environment: "node",
          include: ["**/*.test.{ts,tsx}"],
          exclude: ["**/node_modules/**", "**/dist/**"]
        }
      }
    ]
  }
});
