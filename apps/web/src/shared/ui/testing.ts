/**
 * Test-only setup for UI primitive tests (WP-0.7). Imported at the top of each
 * `*.test.tsx` so the tests run under both the root `vitest run` (no config) and
 * the web package. Once WP-0.1 lands a shared jsdom project with a setup file,
 * this can move there.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
