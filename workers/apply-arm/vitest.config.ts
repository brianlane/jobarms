import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // The virtual Cloudflare modules can't load under node; point them at test
      // stubs (tests mock behavior per-case). No Playwright stub any more: the
      // browser lives in the sidecar, and this worker only speaks HTTP to it.
      "cloudflare:workers": fileURLToPath(new URL("./tests/stubs/cloudflare-workers.ts", import.meta.url)),
      "cloudflare:workflows": fileURLToPath(new URL("./tests/stubs/cloudflare-workflows.ts", import.meta.url))
    }
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary"],
      include: ["src/**/*.ts"],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100
      }
    }
  }
});
