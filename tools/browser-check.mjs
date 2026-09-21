/**
 * `npm run check:browser` — real WebGPU in a real browser.
 *
 * Starts the Vite demo, loads it in headless Chromium with the software backend, and fails on any
 * console error / page error / failed request, on a canvas that never advances a frame, on zero draw
 * calls, or on a frame that is blank. This is the only gate that proves the engine presents pixels: the
 * mock device and `check:wgsl` cannot.
 *
 * Browser discovery, in order: PLAYWRIGHT_CHROMIUM env, a @sparticuz/chromium binary already extracted
 * in the temp dir (what this sandbox uses, since the Playwright CDN is blocked here), then the normal
 * Playwright-managed install. Exits 2 when nothing can be launched, so `verify` never implies a browser
 * pass.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { request } from "node:http";

const PORT = Number(process.env.PORT ?? 5199);
const URL = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpOk(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = request(url, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

const vite = spawn("npx", ["vite", "--config", "examples/vite.config.ts", "--port", String(PORT), "--strictPort"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PORT: String(PORT) },
});
let viteLog = "";
vite.stdout.on("data", (b) => (viteLog += b));
vite.stderr.on("data", (b) => (viteLog += b));

let ready = false;
for (let i = 0; i < 60; i++) {
  if (await httpOk(URL)) {
    ready = true;
    break;
  }
  await sleep(500);
}
if (!ready) {
  console.error(`vite did not serve ${URL}\n${viteLog.slice(0, 2000)}`);
  vite.kill("SIGKILL");
  process.exit(1);
}

const { chromium } = await import("playwright-core");
const spartan = process.env.PLAYWRIGHT_CHROMIUM ?? (existsSync("/tmp/chromium") ? "/tmp/chromium" : null);
const useEnv = spartan
  ? {
      env: {
        ...process.env,
        LD_LIBRARY_PATH: ["/tmp/al2023/lib", "/tmp", process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
        VK_DRIVER_FILES: existsSync("/tmp/vk_swiftshader_icd.json") ? "/tmp/vk_swiftshader_icd.json" : process.env.VK_DRIVER_FILES,
        VK_ICD_FILENAMES: existsSync("/tmp/vk_swiftshader_icd.json") ? "/tmp/vk_swiftshader_icd.json" : process.env.VK_ICD_FILENAMES,
      },
    }
  : {};

let browser;
try {
  browser = await chromium.launch({
    ...(spartan ? { executablePath: spartan } : {}),
    ...useEnv,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--headless=new",
      "--enable-unsafe-webgpu",
      "--enable-unsafe-swiftshader",
      "--use-gl=angle",
      "--use-angle=swiftshader",
    ],
    timeout: 90000,
  });
} catch (error) {
  console.error(
    `check:browser NOT RUN — no launchable browser (${String(error).split("\n")[0]}).\n` +
      "  install once: npm i -D playwright && npx playwright install chromium --with-deps",
  );
  vite.kill("SIGKILL");
  process.exit(2);
}

const problems = [];
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const page = await context.newPage();
page.on("console", (msg) => {
  if (msg.type() === "error") problems.push(`console.error: ${msg.text()}`);
  else if (msg.type() === "warning") problems.push(`console.warn: ${msg.text()}`);
});
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("requestfailed", (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ""}`));

let exitCode = 0;
try {
  await page.goto(URL, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => window.__forge !== undefined || window.__forgeError !== undefined, null, { timeout: 45000 });
  const boot = await page.evaluate(() => window.__forgeError ?? null);
  if (boot) throw new Error(`engine failed to start:\n${boot}`);

  const backend = await page.evaluate(() => window.__forge.backend);
  if (backend !== "webgpu") throw new Error(`expected the real WebGPU backend, got "${backend}"`);

  const before = await page.evaluate(() => window.__forge.stats());
  await sleep(2500);
  const after = await page.evaluate(() => window.__forge.stats());
  console.log(`backend=${backend} frame ${before.frame} -> ${after.frame}, drawCalls=${after.drawCalls}, tris=${after.triangles}, fps=${after.fps.toFixed(1)}`);
  if (!(after.frame > before.frame)) throw new Error(`loop stalled at frame ${after.frame}`);
  if (!(after.drawCalls >= 1)) throw new Error(`no draw calls after ${after.frame} frames`);
  if (!(after.triangles >= 12)) throw new Error(`suspiciously few triangles: ${after.triangles}`);
  if (!(after.entities >= 8)) throw new Error(`scene entities missing: ${after.entities}`);

  // Pixels: copy the WebGPU canvas into a 2D surface in-page and require real variation (a black
  // clear colour with no geometry would otherwise pass a "non-blank" byte-size check).
  const pixels = await page.evaluate(() => {
    const src = document.querySelector("canvas");
    const c = document.createElement("canvas");
    c.width = 160;
    c.height = 90;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(src, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let min = 255;
    let max = 0;
    let sum = 0;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4) {
      const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
      min = Math.min(min, l);
      max = Math.max(max, l);
      sum += l;
      seen.add(`${d[i] >> 4},${d[i + 1] >> 4},${d[i + 2] >> 4}`);
    }
    return { min, max, mean: sum / (d.length / 4), distinct: seen.size };
  });
  console.log(`pixels: min=${pixels.min} max=${pixels.max} mean=${pixels.mean.toFixed(1)} distinct=${pixels.distinct}`);
  if (pixels.max <= pixels.min + 2) throw new Error("canvas is a single flat colour — nothing was drawn");
  if (pixels.distinct < 8) throw new Error(`only ${pixels.distinct} distinct colours; the scene is not rendering`);
  await page.screenshot({ path: "tools/.browser-check.png" });

  // Resize must keep presenting (the swapchain/recreate path).
  await page.setViewportSize({ width: 900, height: 500 });
  await sleep(1200);
  const resized = await page.evaluate(() => window.__forge.stats());
  if (!(resized.frame > after.frame)) throw new Error(`loop stalled after resize (frame ${resized.frame})`);
  console.log(`after resize: frame ${resized.frame}`);
} catch (error) {
  problems.push(String(error.stack ?? error.message).split("\n").slice(0, 6).join("\n"));
  exitCode = 1;
}

const fatal = problems.filter((p) => !p.startsWith("console.warn:"));
for (const p of problems) console.log(`- ${p}`);
if (exitCode === 0 && fatal.length > 0) {
  console.error(`\ncheck:browser FAILED (${fatal.length} console/page error(s))`);
  exitCode = 1;
} else if (exitCode === 0) {
  console.log("\ncheck:browser passed (real WebGPU, headless Chromium + SwiftShader)");
}
await browser.close();
vite.kill("SIGKILL");
process.exit(exitCode);
