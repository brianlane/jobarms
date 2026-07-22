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
    // test can reach a real external service — see tests/setup-env.ts.
    setupFiles: ["tests/setup-env.ts"],
    testTimeout: 15000,
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "html"],
      include: ["src/lib/**/*.ts"]
    }
  }
});
