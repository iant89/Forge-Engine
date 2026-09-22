/**
 * `npm run check:browser` — real WebGPU in a real browser.
 *
 * Starts the Vite demo, loads it in headless Chromium with the software backend, and fails on any
 * console error / page error / failed request, on a canvas that never advances a frame, on zero draw
 * calls, or on a frame that is blank. This is the only gate that proves the engine presents pixels: the
 * mock device and `check:wgsl` cannot.
 *
 * Phase 2 additions (docs/VERIFICATION.md#browser): the frame must have run the cascaded-shadow, HDR
 * forward, bloom and tonemap passes, and readbacks bracketing each toggle must move the way the
 * physics says — bloom adds light, shadows remove it — with zero GPU errors across the HDR, LDR and
 * cascade-debug shader variants. A pass list alone would not catch a shadow map sampled at the wrong
 * coordinates (that renders, validates, and shadows nothing).
 *
 * Phase 6/7 addition: `runParticleGravityCheck` must execute the compute shader on this device and match
 * the analytic curve, and the vehicle playground plus the particle fountain must load with zero GPU
 * errors (the fountain must actually emit). Driving the car is not scripted — the unit suite covers
 * the chassis; this only proves the worlds present.
 *
 * Phase 4 addition: the terrain scene is driven through the real camera controls (wheel, right-drag,
 * scene switching). Nothing else in this repo can catch "the camera cannot zoom or pan and ends up
 * under the terrain": the unit suites never generate a mesh, and a pass list says nothing about where
 * the eye is. The assertions are directional (the wheel must move the distance the way it was
 * scrolled), and the eye is checked against the terrain height the meshes are built from.
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

const vite = spawn("npx", ["vite", "--config", "examples/vite.config.ts", "--port", String(PORT), "--strictPort", "--force"], {
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
      "--enable-features=Vulkan",
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

/** Wait for `frames` animation frames in-page (the engine renders on its own rAF loop). */
const settle = (frames = 4) =>
  page.evaluate(
    (n) =>
      new Promise((resolve) => {
        let i = 0;
        const step = () => (++i >= n ? resolve(undefined) : requestAnimationFrame(step));
        requestAnimationFrame(step);
      }),
    frames,
  );

// Pixels: copy the WebGPU canvas into a 2D surface in-page and measure it. Sampling the WebGPU canvas
// via 2D drawImage must happen inside requestAnimationFrame, before presentation clears the buffer.
const samplePixels = () =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => {
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
          resolve({ min, max, mean: sum / (d.length / 4), distinct: seen.size });
        });
      }),
  );

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
  console.log("BEFORE STATS:", JSON.stringify(before));
  console.log("AFTER STATS:", JSON.stringify(after));
  console.log(`backend=${backend} frame ${before.frame} -> ${after.frame}, drawCalls=${after.drawCalls}, tris=${after.triangles}, fps=${after.fps.toFixed(1)}`);
  if (!(after.frame > before.frame)) throw new Error(`loop stalled at frame ${after.frame}`);
  if (!(after.drawCalls >= 1)) throw new Error(`no draw calls after ${after.frame} frames`);
  if (!(after.triangles >= 12)) throw new Error(`suspiciously few triangles: ${after.triangles}`);
  if (!(after.entities >= 8)) throw new Error(`scene entities missing: ${after.entities}`);
  // Shader compile diagnostics and uncaptured validation errors are recorded by the device; a frame
  // can look right on Chromium's lenient compiler and still carry an error another browser rejects.
  if (after.gpuErrors !== 0 || after.lastError) throw new Error(`GPU errors recorded (${after.gpuErrors}): ${after.lastError}`);

  // Frame structure: the render graph must have executed the Phase 2 chain, not just "a pass".
  const passes = after.renderPasses ?? [];
  const count = (prefix) => passes.filter((p) => p.startsWith(prefix)).length;
  console.log(`passes: ${passes.join(" → ")}`);
  if (!after.render?.hdr) throw new Error("the demo is not rendering through the HDR path");
  if (count("forge.shadow.") < 1) throw new Error(`no shadow cascade pass executed: ${passes.join(", ")}`);
  if (count("forge.main") !== 1 || count("forge.tonemap") !== 1) throw new Error(`expected one forward pass and one tonemap resolve: ${passes.join(", ")}`);
  if (count("forge.bloom.") < 3) throw new Error(`bloom chain missing (prefilter + downsample + upsample): ${passes.join(", ")}`);
  if (!(after.render.shadowsDrawn >= 1)) throw new Error("shadow passes ran but drew nothing (no casters reached the cascades)");
  if (!(after.render.texturesCreated === 0)) throw new Error(`render graph allocated ${after.render.texturesCreated} texture(s) on a steady-state frame (pool is not stable)`);

  // Pixels: require real variation (a black clear colour with no geometry would otherwise pass a
  // "non-blank" byte-size check).
  const pixels = await samplePixels();
  console.log(`pixels: min=${pixels.min} max=${pixels.max} mean=${pixels.mean.toFixed(1)} distinct=${pixels.distinct}`);
  if (pixels.max <= pixels.min + 2) throw new Error("canvas is a single flat colour — nothing was drawn");
  if (pixels.distinct < 8) throw new Error(`only ${pixels.distinct} distinct colours; the scene is not rendering`);
  // The demo's lit ground plane fills the lower half of the frame. A mean this low means the camera is
  // not looking at the scene (this is exactly what the setLookAt world-vs-view bug produced: a black
  // frame with a sliver of cube tops along the bottom edge — which still passed the two checks above).
  if (pixels.mean < 6) throw new Error(`frame is almost entirely black (mean luminance ${pixels.mean.toFixed(1)}); the camera is not looking at the scene`);
  await page.screenshot({ path: "tools/.browser-check.png" });

  // Readback A/B around each toggle, with the animation frozen so only the toggle differs.
  await page.evaluate(() => window.__forge.setAnimating(false));
  await settle();
  const base = await samplePixels();

  await page.evaluate(() => window.__forge.setBloom(false));
  await settle();
  const noBloom = await samplePixels();
  const noBloomStats = await page.evaluate(() => window.__forge.stats());
  await page.evaluate(() => window.__forge.setBloom(true));
  console.log(`bloom: mean ${base.mean.toFixed(2)} (on) vs ${noBloom.mean.toFixed(2)} (off); passes off=${noBloomStats.renderPasses.length}`);
  if (noBloomStats.renderPasses.some((p) => p.startsWith("forge.bloom."))) throw new Error("bloom passes still ran with bloom disabled (graph did not re-plan)");
  if (!(base.mean > noBloom.mean)) throw new Error(`bloom added no light: mean ${base.mean.toFixed(2)} with bloom vs ${noBloom.mean.toFixed(2)} without`);

  await page.evaluate(() => window.__forge.setShadows(false));
  await settle();
  const noShadows = await samplePixels();
  const noShadowStats = await page.evaluate(() => window.__forge.stats());
  await page.evaluate(() => window.__forge.setShadows(true));
  console.log(`shadows: mean ${base.mean.toFixed(2)} (on) vs ${noShadows.mean.toFixed(2)} (off)`);
  if (noShadowStats.renderPasses.some((p) => p.startsWith("forge.shadow."))) throw new Error("shadow passes still ran with shadows disabled");
  if (!(noShadows.mean > base.mean)) throw new Error(`disabling shadows did not brighten the frame (${noShadows.mean.toFixed(2)} vs ${base.mean.toFixed(2)}): the cascades are not landing on the receivers`);

  // The LDR path (forward pass straight into the swapchain, in-shader tone map) must still present.
  await page.evaluate(() => window.__forge.setHdr(false));
  await settle();
  const ldr = await samplePixels();
  const ldrStats = await page.evaluate(() => window.__forge.stats());
  await page.evaluate(() => window.__forge.setHdr(true));
  console.log(`ldr: mean ${ldr.mean.toFixed(2)} distinct=${ldr.distinct}; passes=${ldrStats.renderPasses.join(",")}`);
  if (ldrStats.render.hdr || ldrStats.renderPasses.includes("forge.tonemap")) throw new Error("LDR toggle did not switch the frame off the post chain");
  if (ldr.distinct < 8 || ldr.mean < 6) throw new Error("LDR path rendered a blank frame");

  // Cascade debug tint is a distinct shader path; it must compile and run clean on real WebGPU.
  await page.evaluate(() => window.__forge.setCascadeDebug(true));
  await settle();
  const tinted = await samplePixels();
  await page.evaluate(() => window.__forge.setCascadeDebug(false));
  await page.evaluate(() => window.__forge.setAnimating(true));
  await settle();
  const restored = await page.evaluate(() => window.__forge.stats());
  console.log(`cascade tint: distinct=${tinted.distinct}; after toggles: gpuErrors=${restored.gpuErrors} passes=${restored.renderPasses.length}`);
  if (restored.gpuErrors !== 0 || restored.lastError) throw new Error(`GPU errors after toggling render paths (${restored.gpuErrors}): ${restored.lastError}`);
  if (!restored.render.hdr || restored.render.bloomMips < 1 || restored.render.shadowCascades < 1) throw new Error("render state did not restore after the toggles");

  // Resize must keep presenting (the swapchain/recreate path).
  await page.setViewportSize({ width: 900, height: 500 });
  await sleep(1200);
  const resized = await page.evaluate(() => window.__forge.stats());
  if (!(resized.frame > after.frame)) throw new Error(`loop stalled after resize (frame ${resized.frame})`);
  console.log(`after resize: frame ${resized.frame}`);

  // ---------------------------------------------------------------- terrain scene, real camera input
  // The orbit controller is the only way a user reaches the terrain, so drive it: the wheel must
  // change the distance in the direction it was scrolled (and must not be dead because the preset
  // started outside the controller's limits), a right-drag must move the orbit target, and the eye
  // must stay above the terrain the meshes are built from — `camera().altitude` is eye height minus
  // the terrain query at the eye's XZ.
  await page.setViewportSize({ width: 900, height: 520 }); // software rasteriser: keep this cheap
  await page.evaluate(() => window.__forge.loadScene("terrain"));
  await page.evaluate(() => window.__forge.setAnimating(false));
  await settle(8) // the streaming budget generates a couple of chunks per frame

  const WHEEL_STEPS = 4;
  const wheelAtCentre = async (deltaY, clientX, clientY) => {
    for (let i = 0; i < WHEEL_STEPS; i++) {
      await page.mouse.move(clientX, clientY);
      await page.mouse.wheel(0, deltaY);
      await settle(2);
    }
  };
  const camState = () => page.evaluate(() => window.__forge.camera());

  const terrainStart = await camState();
  if (!terrainStart) throw new Error("terrain scene has no camera state");
  if (!(terrainStart.altitude > 1)) throw new Error(`camera starts under the terrain (altitude ${terrainStart.altitude})`);
  if (!(terrainStart.distance <= terrainStart.maxDistance && terrainStart.distance >= terrainStart.minDistance)) {
    throw new Error(`the scene's starting framing is outside its own zoom range (${terrainStart.distance} not in [${terrainStart.minDistance}, ${terrainStart.maxDistance}])`);
  }
  console.log(`terrain camera: eye=(${terrainStart.eye.map((v) => v.toFixed(1)).join(", ")}) distance=${terrainStart.distance.toFixed(1)} altitude=${terrainStart.altitude.toFixed(1)}`);

  // Wheel away from the target: the camera must actually get further away.
  await wheelAtCentre(200, 450, 300);
  const zoomedOut = await camState();
  console.log(`  wheel out x${WHEEL_STEPS}: distance ${terrainStart.distance.toFixed(1)} -> ${zoomedOut.distance.toFixed(1)}`);
  if (!(zoomedOut.distance <= terrainStart.maxDistance + 1e-3)) throw new Error(`zoom out passed the scene's maximum (${zoomedOut.distance})`);
  if (!(zoomedOut.distance > terrainStart.distance * 1.2)) {
    throw new Error(`scrolling away did not zoom out (${terrainStart.distance} -> ${zoomedOut.distance})`);
  }

  // Wheel toward the target: closer, and the eye must still be above the surface.
  await wheelAtCentre(-200, 450, 300);
  const zoomedIn = await camState();
  console.log(`  wheel in  x${WHEEL_STEPS}: distance ${zoomedOut.distance.toFixed(1)} -> ${zoomedIn.distance.toFixed(1)}, altitude ${zoomedIn.altitude.toFixed(1)}`);
  if (!(zoomedIn.distance < zoomedOut.distance)) throw new Error("scrolling toward the target did not zoom in");
  if (!(zoomedIn.altitude > 1)) throw new Error(`zoom-in drove the camera under the terrain (altitude ${zoomedIn.altitude})`);

  // Right-drag pans the orbit target across the landscape.
  await page.mouse.move(450, 300);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(250, 340, { steps: 8 });
  await page.mouse.up({ button: "right" });
  await settle(3);
  const panned = await camState();
  const targetDelta = Math.hypot(
    panned.target[0] - zoomedIn.target[0],
    panned.target[2] - zoomedIn.target[2],
  );
  console.log(`  right-drag pan: target moved ${targetDelta.toFixed(1)} m, altitude ${panned.altitude.toFixed(1)}`);
  if (!(targetDelta > 1)) throw new Error("right-drag did not pan the camera");
  if (!(panned.altitude > 1)) throw new Error(`panning drove the camera under the terrain (altitude ${panned.altitude})`);

  // Zoom in past the point where the eye would meet the ground: the clamp must hold it above the
  // surface instead of letting it ride through (the original "stuck at ground level, under the map").
  await wheelAtCentre(-400, 450, 300);
  const floor = await camState();
  console.log(`  zoom to the floor: distance ${floor.distance.toFixed(1)}, altitude ${floor.altitude.toFixed(1)}`);
  if (!(floor.distance >= floor.minDistance - 1e-3)) throw new Error(`zoom went below the scene's minimum distance (${floor.distance} < ${floor.minDistance})`);
  if (!(floor.altitude > 1)) throw new Error(`camera ended up under the terrain at the closest zoom (${floor.altitude})`);
  await page.screenshot({ path: "tools/.browser-check-terrain.png" });

  // Switching scenes rebuilds whole worlds; the new scene must not inherit the previous scene's
  // component slots ("already has a Transform component" here means component stores leak across
  // worlds, which is how the demo's scene buttons used to break).
  await page.evaluate(() => window.__forge.loadScene("pbr"));
  await settle(6);
  const switched = await page.evaluate(() => window.__forge.stats());
  await page.evaluate(() => window.__forge.loadScene("terrain"));
  const backToTerrain = await page.evaluate(() => window.__forge.stats());
  console.log(`  scene switch: pbr frame ${switched.frame} gpuErrors ${switched.gpuErrors}, terrain again frame ${backToTerrain.frame}`);
  if (switched.gpuErrors !== 0 || backToTerrain.gpuErrors !== 0) throw new Error("scene switching recorded GPU errors");

  // Phase 7: the compute integrator on this page's real device, compared to the closed-form curve.
  // The mock device records the dispatch and returns gpuExecuted: false; a shader that did not run
  // on SwiftShader does the same, so this is the check that distinguishes "dispatched" from "executed".
  const gravity = await page.evaluate(async () =>
    window.__forge.runParticleGravityCheck({ steps: 30, dt: 1 / 60, count: 64, gravityY: -9.81, y0: 2 }),
  );
  console.log(
    `particle gravity: gpuExecuted=${gravity.gpuExecuted} gpuError=${gravity.gpuError} cpuError=${gravity.cpuError} dispatches=${gravity.dispatches}`,
  );
  if (!gravity.gpuExecuted) throw new Error("particle compute shader did not execute on the real GPU");
  if (!(gravity.gpuError < 1e-2)) throw new Error(`particle GPU gravity error ${gravity.gpuError}`);
  if (!(gravity.cpuError < 1e-4)) throw new Error(`particle CPU gravity error ${gravity.cpuError}`);

  // Phase 6/7 scenes must load, present, and (particles) actually emit. Driving input is the
  // playground's job; this only proves the worlds build and the GPU stays quiet.
  await page.evaluate(() => window.__forge.loadScene("vehicle"));
  await settle(8);
  const vehicle = await page.evaluate(() => window.__forge.vehicleState());
  const vehicleStats = await page.evaluate(() => window.__forge.stats());
  console.log(`vehicle playground: speed=${vehicle?.speed} gear=${vehicle?.gear} gpuErrors=${vehicleStats.gpuErrors}`);
  if (!vehicle) throw new Error("vehicle scene did not expose state");
  if (vehicleStats.gpuErrors !== 0 || vehicleStats.lastError) throw new Error(`vehicle scene GPU errors: ${vehicleStats.lastError}`);
  await page.screenshot({ path: "tools/.browser-check-vehicle.png" });

  await page.evaluate(() => window.__forge.loadScene("particles"));
  await settle(20);
  const particles = await page.evaluate(() => window.__forge.particleState());
  const particleStats = await page.evaluate(() => window.__forge.stats());
  console.log(`particles: alive=${particles?.alive} emitted=${particles?.emitted} gpuErrors=${particleStats.gpuErrors}`);
  if (!particles || !(particles.alive > 0)) throw new Error("particle fountain did not emit");
  if (particleStats.gpuErrors !== 0 || particleStats.lastError) throw new Error(`particle scene GPU errors: ${particleStats.lastError}`);
  await page.screenshot({ path: "tools/.browser-check-particles.png" });
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
