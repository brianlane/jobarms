import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Strip live credentials (sourced .env) from the unit-test process so no
    // test can reach a real external service - see tests/setup-env.ts.
    setupFiles: ["tests/setup-env.ts"],
    testTimeout: 15000,
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "html"],
      // Coverage scope grows as each layer is fully tested (see README). CI
      // gates on 100% for everything currently in scope.
      include: ["src/lib/**/*.ts"],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100
      }
    }
  }
});
