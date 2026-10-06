// Vitest setup for the web project (jsdom).
// - Registers jest-dom matchers (toBeInTheDocument, toHaveAccessibleName, ...).
// - Unmounts rendered trees after each test; Testing Library only does this
//   automatically when Vitest globals are enabled, which we keep off.
// MSW servers are created per feature test with `setupServer` from "msw/node".
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom replaces the global AbortController/AbortSignal, but fetch and Request
// still come from Node (undici), whose brand check rejects jsdom signals with
// "Expected signal to be an instance of AbortSignal". RTK Query's
// fetchBaseQuery always passes a signal, so tests drop it. Nothing under test
// relies on aborting an in-flight fetch. (WP-0.6)
const NodeRequest = globalThis.Request;
globalThis.Request = class JsdomSafeRequest extends NodeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    if (init?.signal === undefined || init.signal === null) {
      super(input, init);
      return;
    }
    const { signal: _jsdomSignal, ...rest } = init;
    super(input, rest);
  }
};

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
