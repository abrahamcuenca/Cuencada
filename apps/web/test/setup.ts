// Vitest setup for the web project (jsdom).
// - Registers jest-dom matchers (toBeInTheDocument, toHaveAccessibleName, ...).
// - Unmounts rendered trees after each test; Testing Library only does this
//   automatically when Vitest globals are enabled, which we keep off.
// MSW servers are created per feature test with `setupServer` from "msw/node".
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
