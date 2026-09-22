import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * `test:gpu` — suites that need a *real* WebGPU adapter instead of the strict mock device.
 *
 * As of Phase 9 there are no files matching `tests/**\/*.gpu.test.ts`: real-adapter validation is
 * done by `npm run check:browser` (headless Chromium + SwiftShader), which exercises the same code
 * over the browser's own WebGPU implementation. This config exists so that a future suite can be
 * added by naming it `*.gpu.test.ts` — and so `npm run test:gpu` is an honest no-op rather than a
 * broken script (`passWithNoTests`), because a missing config looked like a passing gate.
 *
 * Anything added here must skip itself when no adapter is available rather than failing CI, since
 * GitHub's runners have no GPU.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@forge/engine": fileURLToPath(new URL("./engine/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.gpu.test.ts"],
    environment: "node",
    passWithNoTests: true,
    maxWorkers: 1,
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
