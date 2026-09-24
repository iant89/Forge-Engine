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
 * errors (the fountain must become ready, emit, and run particle.sim/sort/render/resolve). Driving the car is not scripted — the unit suite covers
 * the chassis; this only proves the worlds present.
 *
 * Phase 4 addition: the terrain scene is driven through the real camera controls (wheel, right-drag,
 * scene switching). Nothing else in this repo can catch "the camera cannot zoom or pan and ends up
 * under the terrain": the unit suites never generate a mesh, and a pass list says nothing about where
 * the eye is. The assertions are directional (the wheel must move the distance the way it was
 * scrolled), and the eye is checked against the terrain height the meshes are built from.
 *
 * Phase 8b addition: the weather scene must present the cloud deck, the water and lightning on real
 * WebGPU. Overcast noon is brighter than clear noon (the deck whitens the sky while the sun still
 * lights the ground), pinning the deck coverage to 1 on a clear night darkens the frame (the unlit
 * deck occludes the stars — the storm preset cannot prove this because its fog outshines the deck),
 * the underwater toggle removes `forge.sky` from the graph, and a triggered strike registers.
 *
 * Demo-UI addition: every demo whose actions used to need keys shows buttons instead (the vehicle
 * keeps its keyboard). The sky panel (`-1h`/`+1h`/`Pause`/`Mars`) must be shown at a desktop width
 * and each button must move the scene state the way its key does and mark itself pressed. The
 * weather panel is driven at a phone width too — each of its buttons must move the state its key
 * moves (`1..4`, `L`, `U`, `[`/`]`, `T`) and mark itself pressed (the panel is painted from that
 * state, and the two can only disagree if the buttons were wired to something else) — and it must
 * still be shown when the window goes back to a desktop width.
 *
 * Parking-brake addition: on the vehicle playground `P` must latch the parking brake (state 1, and
 * the pad's P/PARK lamp lit), full throttle with it latched must not move the car — the wheels are
 * locked, so a parked car whose visual wheels used to keep turning stays put — and a second press
 * must release it and give the drive back. The lock rule itself is unit-tested in
 * `tests/vehicles.test.ts`; this is the key/input/lamp wiring on a real device. That section drives
 * the car through the scene's own `update`, so it resumes the demo loop the earlier pixel A/Bs froze
 * and asserts `animating()` — a frozen loop applies no input, and the parked half of the check would
 * pass for the wrong reason (a car that cannot move looks exactly like a car held by a brake).
 *
 * Rain/showcase addition: the storm preset must spawn visible rain (`weatherState().rainDrops >
 * 0`), the landing-page scene selector must default to Mars Showcase, and the showcase must load the
 * Perseverance GLB, settle its six wheels into terrain contact, then drive forward under W far enough
 * to prove the drivetrain and produce wheel-kick dust — all with no new GPU errors. These waits
 * use wall-clock caps because the showcase presents well under 1 fps on the software rasteriser, and
 * a frame-count settle would
 * either race the model fetch or stall the gate for minutes.
 *
 * Browser discovery, in order: PLAYWRIGHT_CHROMIUM env, a @sparticuz/chromium binary already extracted
 * in the temp dir (what this sandbox uses, since the Playwright CDN is blocked here), then the normal
 * Playwright-managed install — launched as `channel: "chromium"`, the *full* build. Playwright's
 * default headless launch uses `chromium-headless-shell`, and that binary has no WebGPU at all: with it
 * the page boots into "no adapter" and this gate reports a product bug that is really a browser choice.
 * The full build in new headless mode (with the flags below) is the only configuration that presents
 * pixels here.
 *
 * WebGPU needs a Vulkan device on top of that, and `tools/gpu-env.mjs` is what supplies it: the ICD
 * bundled next to the browser when the build has one (VK_ICD_FILENAMES/VK_DRIVER_FILES, plus the
 * binary's own directory on LD_LIBRARY_PATH), otherwise nothing at all and the system loader finds
 * Mesa's lavapipe, which `scripts/setup-deps.sh` installs. Both are printed before the adapter probe,
 * so "no adapter here" can be told apart from "the engine failed".
 *
 * Exits 2 when nothing can be launched or the browser has no WebGPU adapter at all, so `verify` never
 * implies a browser pass and a GPU-less runner is not blamed on the change.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gpuLaunchEnv, ICD_SOURCE_TEXT, LOADER_SOURCE_TEXT } from "./gpu-env.mjs";

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
// The browser this gate launches, in the order the setup script provisions them: an explicit
// PLAYWRIGHT_CHROMIUM, the @sparticuz payload extracted into the temp dir, then Playwright's own
// build. Asking for `channel: "chromium"` is not decoration — Playwright's default headless launch is
// `chromium-headless-shell`, which has no WebGPU at all (tools/gpu-env.mjs resolves the same path, so
// what it reports is what gets launched).
const spartan = process.env.PLAYWRIGHT_CHROMIUM ?? (existsSync("/tmp/chromium") ? "/tmp/chromium" : null);
const managedChromium = () => {
  try {
    return chromium.executablePath(); // the full build, not the headless shell
  } catch {
    return null;
  }
};
const launchEnvironment = gpuLaunchEnv({
  executablePath: spartan ?? managedChromium(),
  extraLibraryPaths: [join(tmpdir(), "al2023", "lib")],
});

let browser;
try {
  browser = await chromium.launch({
    // `executablePath` and `channel` are mutually exclusive; when we have our own binary, use it.
    ...(spartan ? { executablePath: spartan } : { channel: "chromium" }),
    env: launchEnvironment.env,
    // Playwright also passes `--headless`, which on Chromium 131 selects the *old* headless mode.
    // Whether the last duplicate wins is not something to bet the gate on, so drop it and pass the
    // new mode ourselves.
    ignoreDefaultArgs: ["--headless"],
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
  // Print what the browser was given, next to the adapter probe below: "no adapter" with an ICD that
  // does not exist and "no adapter" with a valid one mean very different things.
  console.log(
    `gpu: ICD ${launchEnvironment.icd ?? "(none — the loader picks)"} (${ICD_SOURCE_TEXT[launchEnvironment.icdSource]})` +
      `; loader ${launchEnvironment.loader ?? "(not found)"} (${LOADER_SOURCE_TEXT[launchEnvironment.loaderSource]})`,
  );
} catch (error) {
  console.error(
    `check:browser NOT RUN — no launchable browser (${String(error).split("\n")[0]}).\n` +
      "  install the build that matches the installed playwright-core, then retry:\n" +
      "  npx playwright@$(node -p \"require('playwright-core/package.json').version\") install --with-deps chromium",
  );
  vite.kill("SIGKILL");
  process.exit(2);
}

const problems = [];
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const page = await context.newPage();
page.on("console", (msg) => {
  // The source URL matters: "Failed to load resource: 404" without it cost a CI round trip.
  const where = msg.location()?.url ? ` @ ${msg.location().url}` : "";
  if (msg.type() === "error") problems.push(`console.error: ${msg.text()}${where}`);
  else if (msg.type() === "warning") problems.push(`console.warn: ${msg.text()}${where}`);
});
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("requestfailed", (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ""}`));
page.on("response", (r) => {
  if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`);
});

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

/**
 * Ask the *browser* whether a WebGPU adapter exists at all, independently of the engine. This is the
 * question that tells the two failure modes apart: "`navigator.gpu` exists but `requestAdapter()`
 * returns null" is the signature of a headless-shell launch or a missing SwiftShader (a browser
 * choice), while an engine that fails its own adapter request on a machine where this probe succeeds
 * is a product bug and must fail the gate. Either way the text goes into the log.
 */
const probeGpu = () =>
  page
    .evaluate(async () => {
      if (!navigator.gpu) return { ok: false, text: "gpu: navigator.gpu is undefined (this browser has no WebGPU at all)" };
      const adapter = await navigator.gpu.requestAdapter().catch(() => null);
      if (!adapter) {
        return {
          ok: false,
          text: "gpu: navigator.gpu exists but requestAdapter() returned null (the headless shell, or SwiftShader is not enabled)",
        };
      }
      const info = adapter.info ?? {};
      return {
        ok: true,
        text: `gpu: adapter ok (${info.vendor ?? "?"} / ${info.architecture ?? "?"}${info.description ? ` — ${info.description}` : ""})`,
      };
    })
    .catch((error) => ({ ok: false, text: `gpu: probe failed (${String(error).split("\n")[0]})` }));

const describeGpu = async () => (await probeGpu()).text;

/** Stop the run the way the "cannot run here" path does: report, tear the harness down, exit 2. */
async function notRun(headline, lines) {
  console.error(`check:browser NOT RUN — ${headline}\n${lines.map((l) => `  ${l}`).join("\n")}`);
  await browser.close();
  vite.kill("SIGKILL");
  process.exit(2);
}

const GPU_HINT =
  'the gate needs the full Chromium build (channel: "chromium") launched with --headless=new ' +
  "--enable-unsafe-webgpu --enable-unsafe-swiftshader --enable-features=Vulkan.";

let exitCode = 0;
try {
  // Most product visits use `/` and land on Mars Showcase. Start this rendering-foundation suite on
  // its lightweight PBR fixture explicitly; the showcase is exercised below after the other scenes.
  await page.goto(`${URL}?scene=pbr`, { waitUntil: "load", timeout: 60000 });
  let boot;
  try {
    await page.waitForFunction(() => window.__forge !== undefined || window.__forgeError !== undefined, null, { timeout: 45000 });
    boot = await page.evaluate(() => window.__forgeError ?? null);
  } catch (waitError) {
    boot = `the demo never signalled a boot result (${String(waitError.message).split("\n")[0]})`;
  }

  // Ask the browser, not the engine, whether WebGPU exists at all. A missing adapter is a browser
  // choice (headless shell, no SwiftShader) and the gate can prove nothing about rendering without
  // one, so it reports "did not run" (exit 2). An engine that fails its own adapter request on a
  // machine where this probe succeeds is a product bug and falls through to the normal failure path.
  const gpu = await probeGpu();
  if (boot !== null && !gpu.ok) {
    await notRun("the demo did not start and this browser cannot present WebGPU, so the failure cannot be attributed to the engine.", [
      `the engine said: ${boot.split("\n")[0]}`,
      gpu.text,
      GPU_HINT,
    ]);
  }
  console.log(gpu.text);
  if (boot) throw new Error(`engine failed to start:\n${boot}`);
  if (!gpu.ok) await notRun("this browser cannot present WebGPU.", [gpu.text, GPU_HINT]);

  const backend = await page.evaluate(() => window.__forge.backend);
  if (backend !== "webgpu") throw new Error(`expected the real WebGPU backend, got "${backend}"\n${await describeGpu()}`);
  const landingOption = await page.evaluate(
    () => document.querySelector("#scene-select option[selected]")?.getAttribute("value") ?? null,
  );
  if (landingOption !== "mars-showcase") throw new Error(`expected Mars Showcase as the landing-page default, got "${landingOption}"`);
  const requestedScene = await page.evaluate(() => window.__forge.sceneName);
  if (requestedScene !== "pbr") throw new Error(`?scene=pbr did not select the PBR fixture (active scene "${requestedScene}")`);
  console.log(`landing default: ${landingOption}; browser fixture: ${requestedScene}`);

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
  //
  // The render-path and terrain sections above freeze the demo loop for their pixel A/Bs, and that
  // freeze outlives them: the scene's `update` is where a scene writes its inputs, so a frozen loop
  // means `vehicle.input` is never written and the car cannot move however hard this gate presses W.
  // A parked car hides that (it is meant to stand still); the drive back does not. Resume it here,
  // and assert it, so a failure below can only be about the car.
  await page.evaluate(() => window.__forge.setAnimating(true));
  await page.evaluate(() => window.__forge.loadScene("vehicle"));
  await settle(8);
  const demoAnimating = await page.evaluate(() => window.__forge.animating?.() ?? null);
  if (demoAnimating !== true) {
    throw new Error("the demo's update loop is frozen; vehicle input would never reach the car");
  }
  const vehicle = await page.evaluate(() => window.__forge.vehicleState());
  const vehicleStats = await page.evaluate(() => window.__forge.stats());
  console.log(`vehicle playground: speed=${vehicle?.speed} gear=${vehicle?.gear} gpuErrors=${vehicleStats.gpuErrors}`);
  if (!vehicle) throw new Error("vehicle scene did not expose state");
  if (vehicleStats.gpuErrors !== 0 || vehicleStats.lastError) throw new Error(`vehicle scene GPU errors: ${vehicleStats.lastError}`);
  await page.screenshot({ path: "tools/.browser-check-vehicle.png" });

  // Parking brake: `P` (the touch pad's P/PARK button) latches it, and a latched brake has to hold
  // the car — wheels locked, so full throttle on a flat pad must not move it. Release and the drive
  // comes back. The unit suites pin the lock rule; this proves the scene/key/input wiring on a real
  // device, and that the visual odometer is not left turning (a parked car used to creep).
  const parkFrom = await page.evaluate(() => window.__forge.vehicleState());
  await page.keyboard.press("KeyP");
  const parkLatched = await page.evaluate(() => window.__forge.vehicleState());
  const parkLamp = await page.evaluate(() => document.getElementById("veh-park")?.classList.contains("active"));
  console.log(`parking brake: latched=${parkLatched?.parkingBrake} lamp=${parkLamp}`);
  if (parkLatched?.parkingBrake !== 1) throw new Error("P did not latch the parking brake");
  if (parkLamp !== true) throw new Error("PARK pad button did not light while the brake is engaged");
  let parkedMaxSpeed = 0;
  await page.keyboard.down("KeyW");
  try {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const held = await page.evaluate(() => window.__forge.vehicleState());
      parkedMaxSpeed = Math.max(parkedMaxSpeed, held?.speed ?? 0);
      await page.waitForTimeout(500);
    }
  } finally {
    await page.keyboard.up("KeyW");
  }
  const parkedNow = await page.evaluate(() => window.__forge.vehicleState());
  const parkedDz = Math.abs((parkedNow?.z ?? 0) - (parkFrom?.z ?? 0));
  console.log(`parking brake hold: maxSpeed=${parkedMaxSpeed.toFixed(4)} dz=${parkedDz.toFixed(4)}m`);
  if (!(parkedMaxSpeed < 0.05)) {
    throw new Error(`parking brake let the car move under full throttle (${parkedMaxSpeed.toFixed(3)} m/s)`);
  }
  if (!(parkedDz < 0.02)) throw new Error(`parking brake let the car creep (${parkedDz.toFixed(3)}m)`);
  await page.keyboard.press("KeyP");
  const parkReleased = await page.evaluate(() => window.__forge.vehicleState());
  if (parkReleased?.parkingBrake !== 0) throw new Error("P did not release the parking brake");
  let drove = null;
  await page.keyboard.down("KeyW");
  try {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      drove = await page.evaluate(() => window.__forge.vehicleState());
      if (Math.abs((drove?.z ?? 0) - (parkFrom?.z ?? 0)) > 0.5) break;
      await page.waitForTimeout(500);
    }
  } finally {
    await page.keyboard.up("KeyW");
  }
  const droveDz = Math.abs((drove?.z ?? 0) - (parkFrom?.z ?? 0));
  console.log(`parking brake released: drove ${droveDz.toFixed(2)}m under W`);
  if (!(droveDz > 0.5)) throw new Error(`released parking brake did not give the drive back (dz ${droveDz.toFixed(3)}m)`);
  const vehicleStatsAfter = await page.evaluate(() => window.__forge.stats());
  if (vehicleStatsAfter.gpuErrors !== 0 || vehicleStatsAfter.lastError) {
    throw new Error(`vehicle scene GPU errors while parking: ${vehicleStatsAfter.lastError}`);
  }

  await page.evaluate(() => window.__forge.loadScene("particles"));
  // Wait for GpuParticleWorld.attachDevice/init (not fire-and-forget race) then for emission.
  await page.waitForFunction(
    () => {
      const p = window.__forge.particleState();
      return Boolean(p && p.ready && p.emitted > 0);
    },
    null,
    { timeout: 45000, polling: 100 },
  );
  await settle(12);
  const particles = await page.evaluate(() => window.__forge.particleState());
  const particleStats = await page.evaluate(() => window.__forge.stats());
  const requiredPasses = ["particle.sim", "particle.sort", "particle.render", "particle.resolve"];
  console.log(
    `particles: ready=${particles?.ready} emitted=${particles?.emitted} capacity=${particles?.capacity} ` +
      `passes=${particleStats.renderPasses?.join(",")} gpuErrors=${particleStats.gpuErrors}`,
  );
  if (!particles || !particles.ready) throw new Error("particle fountain system not ready");
  if (!(particles.emitted > 0)) throw new Error("particle fountain did not emit");
  for (const pass of requiredPasses) {
    if (!particleStats.renderPasses?.includes(pass)) {
      throw new Error(`particle pass missing: ${pass} (ran ${particleStats.renderPasses?.join(", ")})`);
    }
  }
  if (particleStats.gpuErrors !== 0 || particleStats.lastError) throw new Error(`particle scene GPU errors: ${particleStats.lastError}`);
  await page.screenshot({ path: "tools/.browser-check-particles.png" });

  // Phase 8a: the sky pass compiles and runs on the real GPU, and the day/night cycle changes what
  // it draws. Noon must be brighter than midnight (sun disc + scattered light vs stars), the pass
  // must disappear when the sky is switched off, and the Mars preset must still render cleanly.
  await page.evaluate(() => window.__forge.loadScene("sky"));
  await settle(8);
  await page.evaluate(() => window.__forge.setAnimating(false));
  await page.evaluate(() => window.__forge.setTimeOfDay(12));
  await settle(6);
  const noon = await samplePixels();
  const noonState = await page.evaluate(() => window.__forge.environmentState());
  const noonStats = await page.evaluate(() => window.__forge.stats());
  await page.screenshot({ path: "tools/.browser-check-sky-noon.png" });
  console.log(
    `sky noon: mean ${noon.mean.toFixed(2)} distinct=${noon.distinct} el=${noonState?.elevationDeg?.toFixed(1)}° ` +
      `light=${noonState?.lightIntensity?.toFixed(2)} passes=${noonStats.renderPasses.join(",")}`,
  );
  if (!noonState || !noonState.isDay) throw new Error("day/night cycle did not report daytime at 12:00");
  if (!noonStats.renderPasses.includes("forge.sky")) throw new Error(`sky pass did not run: ${noonStats.renderPasses.join(", ")}`);
  if (noonStats.gpuErrors !== 0 || noonStats.lastError) throw new Error(`sky scene GPU errors: ${noonStats.lastError}`);
  const mainIndex = noonStats.renderPasses.indexOf("forge.main");
  if (noonStats.renderPasses.indexOf("forge.sky") !== mainIndex + 1) throw new Error("forge.sky must directly follow forge.main");

  await page.evaluate(() => window.__forge.setTimeOfDay(1));
  await settle(6);
  const night = await samplePixels();
  const nightState = await page.evaluate(() => window.__forge.environmentState());
  await page.screenshot({ path: "tools/.browser-check-sky-night.png" });
  console.log(`sky night: mean ${night.mean.toFixed(2)} distinct=${night.distinct} el=${nightState?.elevationDeg?.toFixed(1)}° light=${nightState?.lightIntensity}`);
  if (!nightState || nightState.isDay || nightState.lightIntensity !== 0) throw new Error("day/night cycle did not turn the sun off at 01:00");
  if (!(noon.mean > night.mean * 2)) throw new Error(`sky did not darken between noon (${noon.mean.toFixed(1)}) and night (${night.mean.toFixed(1)})`);

  await page.evaluate(() => window.__forge.setTimeOfDay(12));
  await page.evaluate(() => window.__forge.setSky(false));
  await settle(6);
  const skyOffStats = await page.evaluate(() => window.__forge.stats());
  if (skyOffStats.renderPasses.includes("forge.sky")) throw new Error("sky pass still ran with the sky disabled (graph did not re-plan)");
  await page.evaluate(() => window.__forge.setSky(true));
  await page.evaluate(() => window.__forge.setPlanet("mars"));
  await settle(6);
  const mars = await samplePixels();
  const marsStats = await page.evaluate(() => window.__forge.stats());
  await page.screenshot({ path: "tools/.browser-check-sky-mars.png" });
  console.log(`sky mars: mean ${mars.mean.toFixed(2)} distinct=${mars.distinct} gpuErrors=${marsStats.gpuErrors}`);
  if (!marsStats.renderPasses.includes("forge.sky")) throw new Error("sky pass did not come back after re-enabling");
  if (marsStats.gpuErrors !== 0 || marsStats.lastError) throw new Error(`mars sky GPU errors: ${marsStats.lastError}`);
  await page.evaluate(() => window.__forge.setPlanet("earth"));

  // The sky scene's actions used to be keys only (`[`/`]`, `T`, `M`); the buttons are the interface
  // now, on every device. At this desktop width the panel must be up (the hint gone), and each
  // button must move the state its key moves — `+1h` scrubs the clock, `Pause` stops it (and the
  // second tap restarts it), `Mars` swaps the planet — while marking itself pressed. A press paints
  // itself synchronously, so these hold even though the frame loop is frozen above.
  const skyPanel = await page.evaluate(() => {
    const el = document.getElementById("sky-touch");
    const hint = document.getElementById("controls-hint");
    return {
      display: el ? getComputedStyle(el).display : "missing",
      hint: hint ? getComputedStyle(hint).display : "missing",
      buttons: el ? [...el.querySelectorAll("button")].map((b) => b.id) : [],
    };
  });
  console.log(`sky touch @desktop: display=${skyPanel.display} hint=${skyPanel.hint} buttons=${skyPanel.buttons.join(",")}`);
  if (skyPanel.display !== "block") throw new Error(`sky button panel is not shown at desktop width (display ${skyPanel.display})`);
  if (skyPanel.hint !== "none") throw new Error("the keyboard hint is still shown over the sky button panel");
  for (const id of ["sk-time-back", "sk-time-fwd", "sk-pause", "sk-mars"]) {
    if (!skyPanel.buttons.includes(id)) throw new Error(`sky button panel is missing #${id}`);
  }
  const skyButtonActive = (id) => page.evaluate((sel) => document.getElementById(sel)?.classList.contains("active") ?? false, id);

  const skyClockBefore = await page.evaluate(() => window.__forge.environmentState().time);
  await page.click("#sk-time-fwd");
  const skyClockAfter = await page.evaluate(() => window.__forge.environmentState().time);
  console.log(`  tap +1h: ${skyClockBefore.toFixed(2)}h -> ${skyClockAfter.toFixed(2)}h`);
  if (!(skyClockAfter >= skyClockBefore + 0.9)) {
    throw new Error(`the sky +1h button did not scrub the clock (${skyClockBefore} -> ${skyClockAfter})`);
  }

  await page.click("#sk-pause");
  const skyPaused = await page.evaluate(() => window.__forge.environmentState());
  if (!(skyPaused.paused && skyPaused.timeScale === 0)) {
    throw new Error(`the sky Pause button did not stop the clock (timeScale ${skyPaused.timeScale})`);
  }
  if (!(await skyButtonActive("sk-pause"))) throw new Error("the sky Pause button did not mark itself pressed");
  await page.click("#sk-pause");
  const skyResumed = await page.evaluate(() => window.__forge.environmentState());
  if (skyResumed.paused || skyResumed.timeScale === 0) throw new Error("the second sky Pause tap did not resume the clock");
  if (await skyButtonActive("sk-pause")) throw new Error("the sky Pause button stayed pressed after resuming");

  await page.click("#sk-mars");
  const tappedMars = await page.evaluate(() => window.__forge.skyPlanet());
  if (tappedMars !== "mars") throw new Error(`the Mars button did not switch the planet (planet ${tappedMars})`);
  if (!(await skyButtonActive("sk-mars"))) throw new Error("the Mars button did not mark itself pressed");
  await page.click("#sk-mars");
  const tappedEarth = await page.evaluate(() => window.__forge.skyPlanet());
  if (tappedEarth !== "earth") throw new Error(`the second Mars tap did not switch back to Earth (planet ${tappedEarth})`);
  if (await skyButtonActive("sk-mars")) throw new Error("the Mars button stayed pressed after switching back");

  // Phase 8b: weather, clouds, water, lightning. The deck is presence + direction: overcast noon
  // whitens the sky (brighter than clear noon), a stormy night occludes the stars (darker than a
  // clear night), and the deck flag tracks the coverage. The lake renders inside forge.main (zero
  // GPU errors covers the new program + bind groups), the underwater toggle re-plans the graph,
  // and a triggered strike registers synchronously.
  await page.evaluate(() => window.__forge.loadScene("weather"));
  await settle(8);
  await page.evaluate(() => window.__forge.setAnimating(false));
  await page.evaluate(() => window.__forge.setTimeOfDay(12));
  await page.evaluate(() => window.__forge.setWeather("clear"));
  await settle(6);
  const wxClear = await samplePixels();
  const wxClearState = await page.evaluate(() => window.__forge.weatherState());
  const wxClearStats = await page.evaluate(() => window.__forge.stats());
  await page.screenshot({ path: "tools/.browser-check-weather-clear.png" });
  console.log(
    `weather clear noon: mean ${wxClear.mean.toFixed(2)} distinct=${wxClear.distinct} cover=${wxClearState?.coverage} ` +
      `clouds=${wxClearState?.clouds} gpuErrors=${wxClearStats.gpuErrors}`,
  );
  if (!wxClearState) throw new Error("weather scene did not expose state");
  if (!(wxClearState.coverage < 0.2)) throw new Error(`clear preset did not clear the deck (coverage ${wxClearState.coverage})`);
  if (!wxClearStats.renderPasses.includes("forge.sky")) throw new Error("sky pass did not run on the weather scene");
  if (wxClearStats.gpuErrors !== 0 || wxClearStats.lastError) throw new Error(`weather scene GPU errors: ${wxClearStats.lastError}`);

  await page.evaluate(() => window.__forge.setWeather("storm"));
  await settle(6);
  const wxStorm = await samplePixels();
  const wxStormState = await page.evaluate(() => window.__forge.weatherState());
  const wxStormStats = await page.evaluate(() => window.__forge.stats());
  await page.screenshot({ path: "tools/.browser-check-weather-storm.png" });
  console.log(
    `weather storm noon: mean ${wxStorm.mean.toFixed(2)} distinct=${wxStorm.distinct} cover=${wxStormState?.coverage} ` +
      `clouds=${wxStormState?.clouds} deckWind=${wxStormState?.deckWind} rainDrops=${wxStormState?.rainDrops} gpuErrors=${wxStormStats.gpuErrors}`,
  );
  if (!(wxStormState.coverage > 0.9)) throw new Error(`storm preset did not overcast the deck (coverage ${wxStormState.coverage})`);
  if (!wxStormState.clouds) throw new Error("cloud deck did not report as shading under full overcast");
  if (!(wxStormState.rainDrops > 0)) throw new Error("storm preset spawned no rain (weatherState().rainDrops is 0)");
  if (wxStormStats.gpuErrors !== 0 || wxStormStats.lastError) throw new Error(`storm weather GPU errors: ${wxStormStats.lastError}`);
  if (!(wxStorm.mean > wxClear.mean * 1.05)) {
    throw new Error(`overcast noon was not brighter than clear noon (${wxStorm.mean.toFixed(1)} vs ${wxClear.mean.toFixed(1)}): the deck is not drawing`);
  }

  // Night, with the weather held clear so only the deck moves: coverage 1 occludes the star field
  // the clear frame shows, and the deck itself is unlit (no sun, no ambient), so the frame darkens.
  await page.evaluate(() => window.__forge.setTimeOfDay(0));
  await page.evaluate(() => window.__forge.setWeather("clear"));
  await page.evaluate(() => window.__forge.setCoverage(0));
  await settle(6);
  const wxNightClear = await samplePixels();
  await page.evaluate(() => window.__forge.setCoverage(1));
  await settle(6);
  const wxNightStorm = await samplePixels();
  await page.screenshot({ path: "tools/.browser-check-weather-night.png" });
  console.log(`weather night: clear mean ${wxNightClear.mean.toFixed(2)} vs overcast mean ${wxNightStorm.mean.toFixed(2)}`);
  if (!(wxNightStorm.mean < wxNightClear.mean)) {
    throw new Error(`overcast night was not darker than clear night (${wxNightStorm.mean.toFixed(1)} vs ${wxNightClear.mean.toFixed(1)}): the deck is not occluding the stars`);
  }

  // Lightning registers synchronously (the flash itself decays in half a second — the count pins it).
  const strikes = await page.evaluate(() => window.__forge.triggerLightning());
  const wxFlash = await page.evaluate(() => window.__forge.weatherState());
  console.log(`weather lightning: strikes=${strikes} flash=${wxFlash?.flash?.toFixed(3)}`);
  if (!(strikes >= 1 && wxFlash.strikes >= 1)) throw new Error("triggered lightning did not register a strike");

  // Underwater: the graph drops the sky pass and the renderer flags the murk path.
  await page.evaluate(() => window.__forge.setTimeOfDay(12));
  await page.evaluate(() => window.__forge.setWeather("overcast"));
  await page.evaluate(() => window.__forge.setUnderwater(true));
  await settle(6);
  const wxWet = await page.evaluate(() => window.__forge.weatherState());
  const wxWetStats = await page.evaluate(() => window.__forge.stats());
  await page.screenshot({ path: "tools/.browser-check-weather-underwater.png" });
  console.log(`weather underwater: underwater=${wxWet?.underwater} passes=${wxWetStats.renderPasses.join(",")} gpuErrors=${wxWetStats.gpuErrors}`);
  if (!wxWet.underwater) throw new Error("flooding the camera did not enter the underwater path");
  if (wxWetStats.renderPasses.includes("forge.sky")) throw new Error("sky pass still ran underwater (graph did not re-plan)");
  if (wxWetStats.gpuErrors !== 0 || wxWetStats.lastError) throw new Error(`underwater GPU errors: ${wxWetStats.lastError}`);
  await page.evaluate(() => window.__forge.setUnderwater(false));
  await settle(6);
  const wxDryStats = await page.evaluate(() => window.__forge.stats());
  if (!wxDryStats.renderPasses.includes("forge.sky")) throw new Error("sky pass did not come back after draining");
  await page.evaluate(() => window.__forge.setAnimating(true));

  // The weather scene's interface is its button panel, on every device; the keys are only
  // shortcuts now. At a phone-width viewport the same five actions must still be reachable as
  // buttons, and they must drive the same state as the keys (`4` -> storm, `L` -> a strike,
  // `U` -> flooded, `]` -> an hour later, `T` -> stopped clock) rather than a parallel path that
  // drifts. The pressed buttons are asserted too: they are painted from the scene's own state, so
  // a button that fires but never marks itself is a panel bug.
  await page.setViewportSize({ width: 390, height: 780 });
  await settle(4);
  const panel = await page.evaluate(() => {
    const el = document.getElementById("weather-touch");
    const hint = document.getElementById("controls-hint");
    return {
      display: el ? getComputedStyle(el).display : "missing",
      hint: hint ? getComputedStyle(hint).display : "missing",
      buttons: el ? [...el.querySelectorAll("button")].map((b) => b.id) : [],
    };
  });
  console.log(`weather touch @390px: display=${panel.display} hint=${panel.hint} buttons=${panel.buttons.join(",")}`);
  if (panel.display !== "block") throw new Error(`weather touch panel is not shown at phone width (display ${panel.display})`);
  if (panel.hint !== "none") throw new Error("the keyboard-only hint is still shown over the touch panel");
  for (const id of ["wx-clear", "wx-overcast", "wx-rain", "wx-storm", "wx-strike", "wx-dive", "wx-time-fwd", "wx-time-back", "wx-pause"]) {
    if (!panel.buttons.includes(id)) throw new Error(`weather touch panel is missing #${id}`);
  }
  const pressed = (id) => page.evaluate((sel) => document.getElementById(sel)?.classList.contains("active") ?? false, id);
  await page.screenshot({ path: "tools/.browser-check-weather-touch.png" });

  // A change made anywhere else (a key, `window.__forge`, the weather drifting) must reach the
  // buttons too, so the panel never advertises a preset the scene is not on.
  await page.evaluate(() => window.__forge.setWeather("rain"));
  await settle(4);
  if (!(await pressed("wx-rain"))) throw new Error("the panel did not follow setWeather(\"rain\") from the frame loop");
  if (await pressed("wx-storm")) throw new Error("two preset buttons are pressed at once");

  await page.click("#wx-storm");
  await settle(4);
  const tappedStorm = await page.evaluate(() => window.__forge.weatherState());
  console.log(`  tap Storm: coverage=${tappedStorm?.coverage} storm=${tappedStorm?.storm}`);
  if (!(tappedStorm.coverage > 0.9)) throw new Error(`the Storm button did not overcast the deck (coverage ${tappedStorm.coverage})`);
  if (!(await pressed("wx-storm"))) throw new Error("the Storm button did not mark itself pressed");

  // Exactly one strike per tap: with the deck clear `storm01` is 0, and the lightning scheduler
  // stops drawing inter-arrivals while it is (`lightning.ts`), so nothing here is a coincidence.
  await page.evaluate(() => window.__forge.setWeather("clear"));
  await settle(4);
  const beforeStrike = await page.evaluate(() => window.__forge.weatherState());
  await page.click("#wx-strike");
  const afterStrike = await page.evaluate(() => window.__forge.weatherState());
  if (beforeStrike.storm !== 0) throw new Error(`the strike check needs a storm-free sky (storm01 ${beforeStrike.storm})`);
  if (afterStrike.strikes !== beforeStrike.strikes + 1) {
    throw new Error(`the Strike button registered ${afterStrike.strikes - beforeStrike.strikes} strikes, expected 1`);
  }

  await page.click("#wx-dive");
  await settle(4);
  const dived = await page.evaluate(() => ({ state: window.__forge.weatherState(), stats: window.__forge.stats() }));
  if (!dived.state.underwater) throw new Error("the Dive button did not flood the camera");
  if (dived.stats.renderPasses.includes("forge.sky")) throw new Error("the sky pass still ran after the Dive button (graph did not re-plan)");
  if (!(await pressed("wx-dive"))) throw new Error("the Dive button did not mark itself pressed");
  await page.click("#wx-dive");
  await settle(4);
  const drained = await page.evaluate(() => window.__forge.weatherState());
  if (drained.underwater) throw new Error("the second Dive tap did not drain the lake");

  const clockBefore = await page.evaluate(() => window.__forge.environmentState().time);
  await page.click("#wx-time-fwd");
  const clockAfter = await page.evaluate(() => window.__forge.environmentState().time);
  console.log(`  tap +1h: ${clockBefore.toFixed(2)}h -> ${clockAfter.toFixed(2)}h`);
  if (!(clockAfter >= clockBefore + 0.9)) throw new Error(`the +1h button did not scrub the clock (${clockBefore} -> ${clockAfter})`);

  // Pause is bracketed against this machine's own clock drift, measured first: the fixed clock is
  // catch-up limited, and SwiftShader presents a heavy weather frame a few times a second, so the
  // day runs far slower here than the demo's 60x wall-clock rate. What must hold is not a rate but
  // the order — frozen while paused, moving again after the second tap.
  const sampleClock = () => page.evaluate(() => ({ time: window.__forge.environmentState().time, frame: window.__forge.stats().frame }));
  // Count frames from *now*: the counter is sampled after any click, so a wait cannot be satisfied by
  // frames that were already in flight when the button was pressed.
  const waitFrames = async (count) => {
    const from = (await sampleClock()).frame;
    await page.waitForFunction((f) => window.__forge.stats().frame >= f, from + count, { polling: 250, timeout: 60000 });
  };

  const driftStart = await sampleClock();
  await waitFrames(2); // two presented frames: a drift sample, not a wall-clock guess
  const driftEnd = await sampleClock();
  const drift = driftEnd.time - driftStart.time;
  console.log(`  clock drift: ${drift.toFixed(5)}h over ${driftEnd.frame - driftStart.frame} frames`);

  await page.click("#wx-pause");
  const frozenStart = await sampleClock();
  await waitFrames(2); // same two frames the drift sample used, so the two are comparable
  const frozenEnd = await sampleClock();
  if (!(await pressed("wx-pause"))) throw new Error("the Pause button did not mark itself pressed");
  if (!(frozenEnd.time - frozenStart.time <= Math.max(1e-4, drift * 0.2))) {
    throw new Error(`the clock kept running while Pause was on (${frozenStart.time} -> ${frozenEnd.time})`);
  }

  await page.click("#wx-pause");
  await waitFrames(2);
  const resumed = await sampleClock();
  console.log(`  pause: ${frozenStart.time.toFixed(4)}h frozen over ${frozenEnd.frame - frozenStart.frame} frames (drift was ${drift.toFixed(5)}h), resumed to ${resumed.time.toFixed(4)}h`);
  if (!(resumed.time > frozenEnd.time)) throw new Error(`the clock did not resume (${frozenEnd.time} -> ${resumed.time})`);
  if (await pressed("wx-pause")) throw new Error("the Pause button stayed pressed after resuming");

  // Buttons are this scene's interface on every device: the panel must stay up at a desktop width
  // too (the keys are only shortcuts now), with the keyboard hint out of the way.
  await page.setViewportSize({ width: 900, height: 520 });
  await settle(4);
  const desktopPanel = await page.evaluate(() => {
    const el = document.getElementById("weather-touch");
    const hint = document.getElementById("controls-hint");
    return {
      display: el ? getComputedStyle(el).display : "missing",
      hint: hint ? getComputedStyle(hint).display : "missing",
    };
  });
  if (desktopPanel.display !== "block") throw new Error(`the weather button panel is not shown at desktop width (display ${desktopPanel.display})`);
  if (desktopPanel.hint !== "none") throw new Error("the keyboard hint is still shown over the weather button panel at desktop width");

  // Mars showcase: the Perseverance GLB must load (a fetch that 404s or a bad magic number used
  // to leave the placeholder driving around), the six model wheels must be found and settle into
  // terrain contact, and W must actually drive it — with the kick dust that proves the wheels are
  // spinning, and zero new GPU errors. Everything here polls against *states* with wall-clock caps
  // instead of counting frames: SwiftShader presents the showcase at well under 1 fps, so a fixed
  // frame budget would either crawl for minutes or race the model fetch. The viewport is the
  // 900×520 the panel check above just left us on — the heaviest scene runs ~4× slower at 1280×720.
  await page.evaluate(() => window.__forge.loadScene("mars-showcase"));
  const pollMars = async (label, predicate, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await page.evaluate(() => window.__forge.marsState());
      if (last && predicate(last)) return last;
      await page.waitForTimeout(400);
    }
    throw new Error(`${label} (last state ${JSON.stringify(last)})`);
  };
  const marsLoaded = await pollMars(
    "mars showcase: rover GLB did not load in 20s",
    (s) => s.modelLoaded === true || s.modelError !== null,
    20000,
  );
  console.log(
    `mars showcase: modelLoaded=${marsLoaded.modelLoaded} wheels=${marsLoaded.wheelCount} contact=${marsLoaded.contactWheels}`,
  );
  if (!marsLoaded.modelLoaded) throw new Error(`mars showcase: rover model failed to load (${marsLoaded.modelError})`);
  if (marsLoaded.wheelCount !== 6) throw new Error(`mars showcase: expected 6 model wheels, found ${marsLoaded.wheelCount}`);
  const marsSettled = await pollMars(
    "mars showcase: wheels never reached terrain contact (≥4 of 6) in 45s",
    (s) => s.contactWheels >= 4,
    45000,
  );
  const marsStatsBefore = await page.evaluate(() => window.__forge.stats());
  if (marsStatsBefore.gpuErrors !== 0 || marsStatsBefore.lastError) {
    throw new Error(`mars showcase GPU errors before driving: ${marsStatsBefore.lastError}`);
  }
  const zStart = marsSettled.z;
  await page.keyboard.down("KeyW");
  let maxSpeed = 0;
  let maxKick = 0;
  let marsDriven = null;
  try {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      marsDriven = await page.evaluate(() => window.__forge.marsState());
      maxSpeed = Math.max(maxSpeed, marsDriven.speed ?? 0);
      maxKick = Math.max(maxKick, marsDriven.kickDust ?? 0);
      if (Math.abs(marsDriven.z - zStart) > 0.5) break;
      await page.waitForTimeout(500);
    }
  } finally {
    await page.keyboard.up("KeyW");
  }
  const marsDz = marsDriven ? marsDriven.z - zStart : 0;
  console.log(
    `mars showcase drive: dz=${marsDz.toFixed(2)}m maxSpeed=${maxSpeed.toFixed(2)}m/s maxKickDust=${maxKick} ` +
      `contact=${marsDriven?.contactWheels}`,
  );
  if (!(Math.abs(marsDz) > 0.5)) throw new Error(`mars showcase: W did not drive the rover (dz ${marsDz.toFixed(3)}m in 45s)`);
  if (!(maxSpeed > 0.3)) throw new Error(`mars showcase: rover never got rolling under W (max speed ${maxSpeed.toFixed(3)} m/s)`);
  if (!(maxKick > 0)) throw new Error("mars showcase: driving produced no kick dust");
  const marsStatsAfter = await page.evaluate(() => window.__forge.stats());
  if (marsStatsAfter.gpuErrors !== marsStatsBefore.gpuErrors || marsStatsAfter.lastError) {
    throw new Error(`mars showcase GPU errors while driving: ${marsStatsAfter.lastError}`);
  }
  // Robotic arm: R must start the unfold on the real device — joints leaving the stowed pose proves
  // the GLB's arm chain is wired to the pivots — and stowing must bring every joint back to exactly
  // zero with the thumbsticks hidden. A full unfold is 6 s of sim time, minutes at SwiftShader's
  // showcase frame rate, so the unfolded sticks and jogging are covered by tests/roverArm,
  // tests/armTouch and tests/vehicleTouch instead.
  await page.keyboard.press("KeyR");
  const armMoving = await pollMars(
    "mars showcase: R did not start the robotic-arm unfold in 60s",
    (s) => s.armDeployed === true && s.armT > 0.05 && Math.abs(s.armJoints?.[2] ?? 0) > 1,
    60000,
  );
  await page.evaluate(() => window.__forge.setArm(false));
  const armStowed = await pollMars(
    "mars showcase: robotic arm did not stow back in 90s",
    (s) => s.armDeployed === false && s.armT === 0,
    90000,
  );
  console.log(
    `mars showcase arm: unfold t=${armMoving.armT.toFixed(2)} joints=[${armMoving.armJoints.map((v) => v.toFixed(1)).join(", ")}] ` +
      `→ stowed joints=[${armStowed.armJoints.map((v) => v.toFixed(1)).join(", ")}] sticks=${armStowed.armSticksVisible}`,
  );
  if (armStowed.armJoints.some((v) => v !== 0)) throw new Error(`mars showcase: stowed arm joints not zero: ${armStowed.armJoints}`);
  if (armStowed.armSticksVisible) throw new Error("mars showcase: arm thumbsticks still shown with the arm stowed");
  const marsStatsArm = await page.evaluate(() => window.__forge.stats());
  if (marsStatsArm.gpuErrors !== marsStatsAfter.gpuErrors || marsStatsArm.lastError) {
    throw new Error(`mars showcase GPU errors while moving the arm: ${marsStatsArm.lastError}`);
  }
  await page.screenshot({ path: "tools/.browser-check-showcase.png" });
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
  console.log(`\ncheck:browser passed (real WebGPU, headless Chromium + SwiftShader) — ${await describeGpu()}`);
}
await browser.close();
vite.kill("SIGKILL");
process.exit(exitCode);
