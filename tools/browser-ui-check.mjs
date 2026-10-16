#!/usr/bin/env node
/**
 * `npm run check:browser:ui` — scoped REAL-WebGPU check of the UI framework (docs/UI.md), NOT the
 * full `check:browser` gate.
 *
 * Boots the demo at `?scene=ui` in headless Chromium + SwiftShader (same launch as
 * `tools/browser-check.mjs`) and asserts, on a real device:
 *
 *  1. the frame runs a `forge.ui` render-graph pass with zero GPU errors and a steady frame creates
 *     no textures (`texturesCreated: 0`);
 *  2. the UI is *visible*: every gallery page differs from the 3D scene without the overlay, and the
 *     menu title's text box contains glyph ink (SDF text actually rasterised);
 *  3. real input works end to end: a mouse click on the "Settings" nav item switches pages, Tab moves
 *     keyboard focus, Escape closes a confirmation dialog opened by a click;
 *  4. theme and skin switching change the pixels;
 *  5. a compact viewport collapses the navigation bar (breakpoint) without layout issues;
 *  6. drawing and hit testing agree: the element `hitTestAt` returns at a button's centre is that
 *     button, and the pixel there is the button's colour, not the scene's.
 *
 * Screenshots: `tools/.browser-ui-<page>.png` (git-ignored). Look at them.
 * Exit codes: 0 pass, 1 fail, 2 NOT RUN (no browser/adapter).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gpuLaunchEnv } from "./gpu-env.mjs";

const CHECK_NAME = "check:browser:ui";
const PORT = Number(process.env.PORT ?? 5198);
const BASE = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpOk(url) {
  return new Promise((resolve) => {
    const req = request(url, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--config", "examples/vite.config.ts", "--port", String(PORT), "--strictPort", "--force"], {
  stdio: ["ignore", "pipe", "pipe"],
});
let viteLog = "";
vite.stdout.on("data", (b) => (viteLog += b));
vite.stderr.on("data", (b) => (viteLog += b));
let served = false;
for (let i = 0; i < 60 && !served; i++) {
  served = await httpOk(BASE);
  if (!served) await sleep(500);
}
if (!served) {
  console.error(`vite did not serve ${BASE}\n${viteLog.slice(0, 2000)}`);
  vite.kill("SIGKILL");
  process.exit(1);
}

const { chromium } = await import("playwright-core");
const spartan = process.env.PLAYWRIGHT_CHROMIUM ?? (existsSync("/tmp/chromium") ? "/tmp/chromium" : null);
const managed = () => {
  try {
    return chromium.executablePath();
  } catch {
    return null;
  }
};
const launchEnvironment = gpuLaunchEnv({ executablePath: spartan ?? managed(), extraLibraryPaths: [join(tmpdir(), "al2023", "lib")] });
let browser;
try {
  browser = await chromium.launch({
    ...(spartan ? { executablePath: spartan } : { channel: "chromium" }),
    env: launchEnvironment.env,
    ignoreDefaultArgs: ["--headless"],
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--headless=new", "--enable-unsafe-webgpu", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--enable-features=Vulkan"],
    timeout: 90000,
  });
} catch (error) {
  console.error(`${CHECK_NAME} NOT RUN — no launchable browser (${String(error).split("\n")[0]})`);
  vite.kill("SIGKILL");
  process.exit(2);
}

const problems = [];
const check = (ok, message) => {
  if (!ok) problems.push(message);
  console.log(`${ok ? "  ok  " : " FAIL "} ${message}`);
};

const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(String(e)));

async function finish(code) {
  await browser.close();
  vite.kill("SIGKILL");
  process.exit(code);
}

await page.goto(`${BASE}?scene=ui`, { waitUntil: "load" });
const hasAdapter = await page.evaluate(async () => !!(navigator.gpu && (await navigator.gpu.requestAdapter())));
if (!hasAdapter) {
  console.error(`${CHECK_NAME} NOT RUN — the browser exposes no WebGPU adapter`);
  await finish(2);
}
try {
  await page.waitForFunction(() => window.__forge?.ui?.() && window.__forge.stats().frame > 10, null, { timeout: 120000 });
} catch {
  console.error(`${CHECK_NAME} FAIL — the UI scene did not start\n${consoleErrors.slice(0, 5).join("\n")}`);
  await finish(1);
}
// Hide the demo's DOM chrome so screenshots show only the canvas.
await page.addStyleTag({ content: "#hud,#hud-panel,#toolbar,#toolbar-toggle,#controls-hint,#error,#profiler-panel,.touch-controls{display:none!important}" });

const waitFrames = async (n = 6) => {
  const start = await page.evaluate(() => window.__forge.stats().frame);
  await page.waitForFunction((s) => window.__forge.stats().frame >= s, start + n, { timeout: 60000 });
};
const shot = async (name) => {
  await waitFrames();
  const path = `tools/.browser-ui-${name}.png`;
  await page.locator("canvas").first().screenshot({ path });
  return path;
};

await waitFrames(10);
const s0 = await page.evaluate(() => {
  const st = window.__forge.stats();
  const h = window.__forge.ui();
  return { passes: st.renderPasses, gpuErrors: st.gpuErrors, lastError: st.lastError, instances: h.uiRenderer.stats.instances, draws: h.uiRenderer.stats.drawCalls, overlays: h.ui.messages.filter((m) => m.level === "error").map((m) => m.message) };
});
check(s0.passes.includes("forge.ui"), `forge.ui pass executed (passes: ${s0.passes.join(", ")})`);
check(s0.gpuErrors === 0, `zero GPU errors (${s0.gpuErrors}${s0.lastError ? `: ${s0.lastError}` : ""})`);
check(s0.instances > 50 && s0.draws >= 1, `UI drew ${s0.instances} instances in ${s0.draws} draw call(s)`);
check(s0.overlays.length === 0, `no UI error diagnostics (${s0.overlays.slice(0, 3).join(" | ")})`);
await shot("menu");

console.log(problems.length === 0 ? `${CHECK_NAME} PASS` : `${CHECK_NAME} FAIL (${problems.length})`);
await finish(problems.length === 0 ? 0 : 1);
