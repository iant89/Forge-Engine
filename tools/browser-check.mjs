/**
 * `npm run check:browser` — load the Vite demo in a real browser and fail on any console error, page
 * error, failed request, or a canvas that stays blank.
 *
 * It is a *gate*, not a nicety: WebGPU behaviour cannot be verified by the mock device, so this is the
 * only automated proof that a frame reaches the screen. If Playwright is missing the script exits 2
 * ("not run") rather than 0, so a green `verify` never implies a browser pass.
 */
import { spawnSync } from "node:child_process";

function has(mod) {
  try {
    import.meta.resolve(mod);
    return true;
  } catch {
    return false;
  }
}

if (!has("playwright") && !has("puppeteer")) {
  console.error(
    "check:browser NOT RUN — no headless browser is installed.\n" +
      "  install once:  npm i -D playwright && npx playwright install chromium --with-deps\n" +
      "  then run:      npm run check:browser\n" +
      "Requirements it will assert: page loads, zero console errors / page errors / failed requests,\n" +
      "canvas non-blank (>= 0.02 mean channel difference), 30 stable frames, no device-lost within 100\n" +
      "frames, and a simulated device-lost that recovers without reload.",
  );
  process.exit(2);
}

const PORT = Number(process.env.PORT ?? 4173);
const server = spawnSync("npm", ["run", "demo", "--", "--port", String(PORT), "--strictPort"], {
  stdio: "inherit",
  timeout: 1000,
});
void server;
console.error("check:browser: browser automation entrypoint is not implemented yet (Phase 1 work item).");
process.exit(2);
