// DOM test setup: registers jest-dom matchers and auto-cleans the render
// tree after each test. Applies to every test file, but the cleanup is
// guarded so node-environment tests (no document) are unaffected.
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

afterEach(async () => {
  if (typeof document !== "undefined") {
    const { cleanup } = await import("@testing-library/react");
    cleanup();
  }
});
