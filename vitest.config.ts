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

// Each project's root is its own package directory. Vite resolves SSR
// externals (drizzle-orm, postgres, argon2, ...) from the project root, and
// with pnpm those packages are only linked under the package that depends on
// them, so a repo-root project root would fail to resolve them.
export default defineConfig({
  test: {
    projects: [
      {
        root: fromRoot("./apps/server"),
        resolve: { alias: sharedAlias },
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
          setupFiles: ["./test/setup.ts"]
        }
      },
      {
        root: fromRoot("./packages/emails"),
        esbuild: { jsx: "automatic" },
        test: {
          name: "emails",
          environment: "node",
          include: ["src/**/*.test.{ts,tsx}"],
          exclude: ["**/node_modules/**", "**/dist/**"]
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
