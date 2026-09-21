import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Vitest workspace for the engine: unit + integration tests run in Node against the strict mock GPU
 * device (no browser, no real GPU). `test:gpu` uses a separate config that drives a real browser.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@forge/engine": fileURLToPath(new URL("./engine/src/index.ts", import.meta.url)),
      "@forge/editor": fileURLToPath(new URL("./editor/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Two workers: the box has 2 cores, and mock-device tests are CPU-bound.
    maxWorkers: 2,
    minWorkers: 1,
    testTimeout: 20000,
    hookTimeout: 20000,
    // Leak assertion helper relies on the mock counting outstanding resources per test.
    isolate: true,
    reporters: process.env.CI ? ["default"] : ["default"],
  },
});
