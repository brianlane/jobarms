import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  },
  test: {
    // Default env is node; component/page tests opt into jsdom with a
    // `// @vitest-environment jsdom` docblock so the node suites stay fast.
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // Strip live credentials (sourced .env) from the unit-test process so no
    // test can reach a real external service - see tests/setup-env.ts.
    setupFiles: ["tests/setup-env.ts", "tests/setup-dom.ts"],
    testTimeout: 15000,
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "html"],
      // Coverage scope grows as each layer is fully tested (see README). CI
      // gates on 100% for everything currently in scope.
      include: ["src/**/*.ts", "src/**/*.tsx"],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100
      }
    }
  }
});
