import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Pins config env before any module reads it (config is import-time).
    setupFiles: ["tests/setup-env.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary"],
      include: ["src/**/*.ts"],
      // index.ts is the listen-and-signal-handlers entry: covering it would mean
      // binding a real port and killing the process from a test, which tells us
      // nothing the app factory tests do not already prove.
      exclude: ["src/index.ts"],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 }
    }
  }
});
