import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

/**
 * Demo host. The engine is aliased to its TypeScript sources so the demo always runs the working tree
 * (no build-before-run step to drift out of sync), and `host: 0.0.0.0` keeps it reachable from outside
 * the sandbox.
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: {
      "@forge/engine": fileURLToPath(new URL("../engine/src/index.ts", import.meta.url)),
    },
  },
  server: { host: "0.0.0.0", port: Number(process.env.PORT ?? 5173), strictPort: false, allowedHosts: true },
  preview: { host: "0.0.0.0" },
  build: { target: "es2022", outDir: fileURLToPath(new URL("dist", import.meta.url)), emptyOutDir: true },
  worker: { format: "es" },
});
