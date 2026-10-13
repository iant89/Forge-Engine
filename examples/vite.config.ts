import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

/**
 * The commit the bundle was built from, stamped into the HUD so a device screenshot names its build.
 * Pages serves `index.html` with a 10-minute cache and iOS Safari keeps open tabs alive far longer,
 * so a report can easily describe the previous deploy (fe-17: an iPhone black-sky screenshot that
 * could not be attributed to before or after the #87 sky fix).
 */
function buildId(): string {
  const sha = process.env.GITHUB_SHA;
  if (sha) return sha.slice(0, 7);
  try {
    return execSync("git rev-parse --short=7 HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || "dev";
  } catch {
    return "dev";
  }
}


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
  define: { __FORGE_BUILD__: JSON.stringify(buildId()) },
});
