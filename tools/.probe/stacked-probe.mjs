// Why does the gate's "stacked rig" section see 0 px of light? Reproduce it in isolation.
import { spawn } from "node:child_process";
import { request } from "node:http";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gpuLaunchEnv } from "../../tools/gpu-env.mjs";

const PORT = 5331;
const URL = `http://127.0.0.1:${PORT}/?scene=pbr`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const vite = spawn("npx", ["vite", "--config", "examples/vite.config.ts", "--port", String(PORT), "--strictPort", "--force"], {
  cwd: "/home/user/Forge-Engine", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: String(PORT) },
});
vite.stdout.on("data", () => {}); vite.stderr.on("data", () => {});
for (let i = 0; i < 60; i++) {
  const ok = await new Promise((res) => { const req = request(URL, { method: "GET" }, (r) => { r.resume(); res(true); }); req.on("error", () => res(false)); req.setTimeout(500, () => { req.destroy(); res(false); }); req.end(); });
  if (ok) break; await sleep(500);
}

const { chromium } = await import("playwright-core");
const launchEnvironment = gpuLaunchEnv({ executablePath: "/tmp/chromium", extraLibraryPaths: [join(tmpdir(), "al2023", "lib")] });
const browser = await chromium.launch({
  executablePath: "/tmp/chromium", env: launchEnvironment.env, ignoreDefaultArgs: ["--headless"],
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--headless=new", "--enable-unsafe-webgpu", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--enable-features=Vulkan"],
  timeout: 90000,
});
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const page = await context.newPage();
page.setDefaultTimeout(120000);
await page.goto(URL, { waitUntil: "load" });
await page.waitForFunction(() => window.__forge && window.__forge.stats && window.__forge.stats().running, null, { timeout: 60000 });

const settle = (n = 4) => page.evaluate((n) => new Promise((res) => { let i = 0; const s = () => (++i >= n ? res() : requestAnimationFrame(s)); requestAnimationFrame(s); }), n);
const grab = () => page.evaluate(() => new Promise((res) => requestAnimationFrame(() => {
  const src = document.querySelector("canvas");
  const c = document.createElement("canvas"); c.width = src.width; c.height = src.height;
  const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(src, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const luma = new Float32Array(c.width * c.height); const rgb = new Uint8ClampedArray(d.length);
  rgb.set(d);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) luma[p] = (d[i] + d[i + 1] + d[i + 2]) / 3;
  res({ luma: Array.from(luma), rgb: Array.from(rgb), w: c.width, h: c.height });
})));
const diff = (a, b) => {
  let brighter = 0, darker = 0, max = 0, bx = -1, by = -1;
  for (let p = 0; p < a.luma.length; p++) {
    const d = b.luma[p] - a.luma[p];
    if (d > 1) { brighter++; if (d > max) { max = d; bx = p % a.w; by = (p / a.w) | 0; } }
    else if (d < -1) darker++;
  }
  return { brighter, darker, max, at: [bx, by] };
};

console.log("stats idle:", JSON.stringify((await page.evaluate(() => window.__forge.stats())).render));
await page.evaluate(() => window.__forge.setAnimating(false));
await settle();
const idle = await grab();

for (const [label, fn] of [
  ["tight40", () => window.__forge.setStressLights(40, true)],
  ["spread40", () => window.__forge.setStressLights(40, false)],
  ["tight16", () => window.__forge.setStressLights(16, true)],
  ["tight40-high", () => { window.__forge.setStressLights(0); window.__forge.setStressLights(40, true); }],
]) {
  await page.evaluate(fn);
  await settle(6);
  const r = (await page.evaluate(() => window.__forge.stats())).render;
  const shot = await grab();
  console.log(`${label}: lights=${r.lights} clustered=${r.clusteredLights} cap=${r.maxLightsPerCluster} dropped=${r.lightsDropped} fill=${r.clusterFill} -> vs idle ${JSON.stringify(diff(idle, shot))}`);
  writeFileSync(`/tmp/stacked-${label}.png`, await page.screenshot({ timeout: 90000 }));
}

// Where is the camera looking? Grab a picture with the spread rig for reference, and the crop around
// the centre of the frame where the tight ball should be.
await page.evaluate(() => window.__forge.setStressLights(0));
await settle(4);
writeFileSync("/tmp/stacked-idle.png", await page.screenshot({ timeout: 90000 }));
await browser.close(); vite.kill("SIGKILL");
console.log("done");
