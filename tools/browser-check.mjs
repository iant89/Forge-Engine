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
 * physics says — bloom adds light, directional shadows and the spotlight's and point lights' own
 * shadows remove it — with zero GPU errors across the HDR, LDR, cascade-debug and spot-map
 * variants. The spot-only and point-only A/Bs leave directional cascades active; a pass list alone
 * would not catch a map sampled at the wrong coordinates (that renders, validates, and shadows
 * nothing).
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
 * WebGPU. Overcast noon is darker than clear noon because cloud cover attenuates sun and ambient;
 * pinning the deck coverage to 1 on a clear night darkens the frame (the unlit
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
 * Phase 16.5 addition: the demo's skinned arm is the only place a real adapter ever compiles the
 * skinned modules, and the only place a palette can move a pixel. The check asserts the arm's batch
 * went through the skinned pipeline with four joints and no fallback, that no pipeline is pending (a
 * skinned module the device refused to compile skips its draw), and then A/Bs two deterministic poses
 * of the *same* uploaded vertices: only the palette differs, so a frame that does not move is a
 * palette that never reached the vertex stage. `checkSkinning` runs both ways: on the default gate's
 * scene walk (`loadScene("skinning")`, right after the particles) and as the focused `--skinning`
 * mode, which switches to the arm through the dropdown and skips the other scene sections.
 *
 * Parking-brake addition: on the vehicle playground `P` must latch the parking brake (state 1, and
 * the pad's P/PARK lamp lit), full throttle with it latched must not move the car — the wheels are
 * locked, so a parked car whose visual wheels used to keep turning stays put — and a second press
 * must release it and give the drive back. The lock rule itself is unit-tested in
 * `tests/vehicles/vehicles.test.ts`; this is the key/input/lamp wiring on a real device. That section drives
 * the car through the scene's own `update`, so it resumes the demo loop the earlier pixel A/Bs froze
 * and asserts `animating()` — a frozen loop applies no input, and the parked half of the check would
 * pass for the wrong reason (a car that cannot move looks exactly like a car held by a brake).
 *
 * Phase 13.5 addition: the device object culler (`forge.objects.cull` + the HiZ pyramid) and the CPU
 * twin that `"auto"` falls back to on a mock device must draw the same frame — the pass exists in one
 * arm's frame and not the other's — and switching the HiZ stage off must never *darken* a pixel, since
 * the verdict is conservative by construction and the prepass depth already hides what it drops. That
 * pair is what would have caught the mirrored-rectangle bug in the occlusion test: a batch tested
 * against the near ground rows *below* it was culled and vanished from the frame while every CPU gate
 * stayed green.
 *
 * Phase 13.4 addition: the two cluster-grid fills (CPU reference and `forge.lights.assign`) must
 * present an identical frame over the fixture *and* make the same eviction choices past the
 * per-cluster cap, and the fill that reports "gpu" must be the arm whose frame carries the pass. The
 * assignment shader is the CPU fill in another language; both halves are needed, because "same
 * picture" alone would pass for two arms neither of which ran the pass.
 *
 * Phase 13.3 addition: clustered (Forward+) lighting must be *pixel-identical* while a scene fits the
 * old fixed 16-entry light list — the cluster loop calls the same shading function over the same
 * lights in the same order, so any difference is a light the grid failed to index or a slice boundary
 * the CPU and the GPU quantise apart — and the demo's many-light rig (36 static lamps, 40 lights in
 * all) must reach the shader whole through the grid while the uniform path truncates, reports it, and
 * presents visibly less light. The `Clustered` button must move the setting it shows.
 *
 * Rain/showcase addition: the storm preset must spawn visible rain (`weatherState().rainDrops >
 * 0`), the landing-page scene selector must default to Mars Showcase, and the showcase must load the
 * Perseverance GLB on the ported analytic Mars pipeline, make the rover's tile resident, settle its
 * six wheels into terrain contact, then drive forward under W far enough to prove the drivetrain
 * and produce wheel-kick dust plus thrown regolith chips — with clearance above that same surface and no new GPU errors.
 * Every wait in this section is budgeted on the scene's own progress, never on the wall clock, and
 * that is not stylistic: the showcase presents at a fraction of a frame per second on the software
 * rasteriser, and a wall-clock window measures *that* through whatever it is waiting for. So the
 * state polls renew their timeout while the state keeps changing (a scene that is genuinely stuck
 * still fails, just on its own clock), and the W-drive arm budgets in simulated throttle seconds —
 * `VehicleSystem` integrates the chassis once per fixed step and `Clock` caps catch-up at five of
 * them per presented frame, so the wall clock buys only ≈1/12 s of throttle per frame and a distance
 * judged over a wall-clock window failed the gentle drive tune it exists to protect. W is held until
 * the chassis' own fixed clock has run two seconds of throttle, breaking early as soon as the
 * distance is covered so nothing that already passes gets slower, and the log reports throttle
 * seconds and presented frames next to the distance so a slow frame rate is never mistaken for a
 * drivetrain that will not drive.
 *
 * Phase 10.9 addition: the ported Mars generator is also addressable as a *site inspector*
 * (`?scene=mars-generator`, site from `?marssite=<preset|lat,lon>`). Two arms: the volcano preset must
 * stream the port on workers with the four-layer `SplatMaterial` path and no GPU errors, and a real
 * `?scene=mars-generator&marssite=0,0` navigation (what a URL does — not `loadScene`) must leave a
 * resident tile whose mask blends two channels, read back through `layeredMaterial.weightPixels`.
 * The port's material rules are regional, so the volcano and canyon presets bake one channel for
 * kilometres: a distinct-dominant-channel count over the streamed patch would be true on the crater
 * field and false elsewhere, which is a property of the geology, not of the splat path. The arm runs
 * *before* the showcase section on purpose — the showcase's W-drive threshold is frame-rate bound on
 * SwiftShader and has aborted this gate on main, and an arm placed after it would be coverage on paper.
 * `--mars-workers` runs only native-worker round trips, showcase uploads/contact and a visual
 * capture. The full suite also observes those worker messages in its Mars arm. The focused mode
 * has its own command/output and never claims the renderer A/Bs, W-drive, HGA or arm checks ran.
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
import { join, resolve } from "node:path";

import { gpuLaunchEnv, ICD_SOURCE_TEXT, LOADER_SOURCE_TEXT } from "./gpu-env.mjs";
import { installMarsWorkerProbe, verifyMarsWorkers } from "./browser-mars-workers.mjs";

// Explicitly scoped fast path: worker round trips + actual showcase uploads/rendering, NOT the
// all-scene renderer/drive/HGA/arm gate. Its distinct command/output cannot masquerade as a full pass.
const MARS_WORKERS_ONLY = process.argv.includes("--mars-workers");
const MARS_INTERACTIVE_ONLY = process.argv.includes("--mars-interactive");
const TERRAIN_LAYERS_ONLY = process.argv.includes("--terrain-layers");
const SKINNING_ONLY = process.argv.includes("--skinning");
const RESCUE_ONLY = process.argv.includes("--rescue");
const MECHANICAL_ONLY = process.argv.includes("--mechanical");
const CHECK_NAME = TERRAIN_LAYERS_ONLY ? "check:browser:terrain-layers" : MARS_WORKERS_ONLY ? "check:browser:mars-workers" : MARS_INTERACTIVE_ONLY ? "check:browser:mars-interactive" : SKINNING_ONLY ? "check:browser:skinning" : RESCUE_ONLY ? "check:browser:rescue" : MECHANICAL_ONLY ? "check:browser:mechanical" : "check:browser";
const PORT = Number(process.env.PORT ?? 5199);
const URL = `http://127.0.0.1:${PORT}/`;
const workerSmokeOnly = process.argv.includes("--workers-only");
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

const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--config", "examples/vite.config.ts", "--port", String(PORT), "--strictPort", "--force"], {
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
    `${CHECK_NAME} NOT RUN — no launchable browser (${String(error).split("\n")[0]}).\n` +
      "  install the build that matches the installed playwright-core, then retry:\n" +
      "  npx playwright@$(node -p \"require('playwright-core/package.json').version\") install --with-deps chromium",
  );
  vite.kill("SIGKILL");
  process.exit(2);
}

const problems = [];
const context = await browser.newContext({
  viewport: RESCUE_ONLY ? { width: 800, height: 600 } : MARS_WORKERS_ONLY || TERRAIN_LAYERS_ONLY ? { width: 900, height: 520 } : { width: 1280, height: 720 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();
await installMarsWorkerProbe(page);
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

/** GPU cull counters are asynchronous; wait until this mode's device readback has actually arrived. */
const waitForCullReadback = (writesRecords) =>
  page.waitForFunction(
    (records) => {
      const r = window.__forge.stats().render;
      const culled = r.cullFrustum + r.cullDistance + r.cullOccluded;
      return (
        r.cullTested > 0 &&
        r.cullDistance > 0 &&
        r.cullVisible === r.cullTested - culled &&
        r.cullRecordZeroed === (records ? culled : 0)
      );
    },
    writesRecords,
    { polling: 100, timeout: 15000 },
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
 * Keep the canvas's full-resolution per-pixel luma in the page under `key`, for per-pixel A/B
 * checks: a mean can hide a shifted or missing object, and a downsample averages small local
 * changes (contact shading) away. Only the comparison's numbers cross back (`compareLuma`).
 */
const keepLuma = (key) =>
  page.evaluate(
    (key) =>
      new Promise((resolve) => {
        requestAnimationFrame(() => {
          const src = document.querySelector("canvas");
          const c = document.createElement("canvas");
          c.width = src.width;
          c.height = src.height;
          const g = c.getContext("2d", { willReadFrequently: true });
          g.drawImage(src, 0, 0);
          const d = g.getImageData(0, 0, c.width, c.height).data;
          const luma = new Float32Array(c.width * c.height);
          for (let i = 0, p = 0; i < d.length; i += 4, p++) luma[p] = (d[i] + d[i + 1] + d[i + 2]) / 3;
          (window.__gateLuma ??= {})[key] = luma;
          // The channels too: luma can hide a hue change at the same brightness, which is what "a
          // different light survived the per-cluster cap" looks like when the lamps are colour-coded.
          (window.__gateRgb ??= {})[key] = d.slice(0);
          resolve(luma.length);
        });
      }),
    key,
  );

/**
 * Per-pixel, per-channel comparison of two kept frames: how many pixels differ from `a` to `b` in any
 * of red, green or blue by more than one level, and by how much at the worst pixel.
 */
const compareRgb = (a, b) =>
  page.evaluate(
    ([a, b]) => {
      const A = window.__gateRgb[a];
      const B = window.__gateRgb[b];
      let max = 0;
      let differing = 0;
      for (let i = 0; i < A.length; i += 4) {
        let worst = 0;
        for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(B[i + c] - A[i + c]));
        if (worst > 1) differing++;
        if (worst > max) max = worst;
      }
      return { pixels: A.length / 4, max, differing };
    },
    [a, b],
  );

/** Per-pixel comparison of two kept frames: pixels that got darker / brighter from `a` to `b` by more than one level. */
const compareLuma = (a, b) =>
  page.evaluate(
    ([a, b]) => {
      const A = window.__gateLuma[a];
      const B = window.__gateLuma[b];
      let max = 0;
      let darker = 0;
      let brighter = 0;
      for (let i = 0; i < A.length; i++) {
        const d = B[i] - A[i];
        if (Math.abs(d) > max) max = Math.abs(d);
        if (d < -1) darker++;
        else if (d > 1) brighter++;
      }
      return { pixels: A.length, max, darker, brighter };
    },
    [a, b],
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
  console.error(`${CHECK_NAME} NOT RUN — ${headline}\n${lines.map((l) => `  ${l}`).join("\n")}`);
  await browser.close();
  vite.kill("SIGKILL");
  process.exit(2);
}

const GPU_HINT =
  'the gate needs the full Chromium build (channel: "chromium") launched with --headless=new ' +
  "--enable-unsafe-webgpu --enable-unsafe-swiftshader --enable-features=Vulkan.";

/** Numerical pixel evidence, not just a populated bind group or an orange screenshot. */
async function checkTerrainLayerPixels() {
  const result = await page.evaluate(() => window.__forge.runTerrainLayerCheck());
  if (!result.gpuExecuted || result.gpuErrors !== 0) throw new Error(`terrain layer oracle failed: ${JSON.stringify(result)}`);
  console.log(`terrain layer pixels: ${JSON.stringify(result)}`);
}

async function waitPresentedFrames(count) {
  const from = await page.evaluate(() => window.__forge.stats().frame);
  await page.waitForFunction((frame) => window.__forge.stats().frame >= frame, from + count, { polling: 250, timeout: 60000 });
}

async function checkShowcaseLayers() {
  const state = await page.evaluate(() => window.__forge.marsState());
  if (state?.terrainMaterialMode !== "layered" || state.terrainSplatTiles < 9 ||
      state.terrainMaterialLayers.join(",") !== "dust,rock,sand,crust") {
    throw new Error(`showcase lacks resident four-layer materials: ${JSON.stringify(state)}`);
  }
  const wasAnimating = await page.evaluate(() => window.__forge.animating());
  await page.evaluate(() => window.__forge.setAnimating(false));
  try {
    await page.waitForFunction(() => window.__forge.stats().render.pipelinesPending === 0, null, { timeout: 60000 });
    await keepLuma("terrain-layered");
    await page.screenshot({ path: "tools/.browser-check-terrain-layered.png", timeout: 60000 });
    await page.evaluate(() => window.__forge.setTerrainLayers(false));
    await waitPresentedFrames(3);
    await keepLuma("terrain-single");
    // Restrict the comparison to the lower outer quarters: no rover/sky, so a moving wheel or
    // streamed horizon cannot substitute for a real change to the shaded ground.
    const change = await page.evaluate(() => {
      const canvas = document.querySelector("canvas");
      const a = window.__gateRgb["terrain-layered"], b = window.__gateRgb["terrain-single"];
      let pixels = 0, differing = 0, max = 0;
      for (let y = Math.floor(canvas.height / 2); y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        if (x >= canvas.width / 4 && x < canvas.width * 3 / 4) continue;
        const offset = (y * canvas.width + x) * 4;
        const difference = Math.max(...[0, 1, 2].map((c) => Math.abs(a[offset + c] - b[offset + c])));
        pixels++; if (difference > 1) differing++; max = Math.max(max, difference);
      }
      return { pixels, differing, max };
    });
    if (change.differing < change.pixels * 0.1 || change.max < 10) throw new Error(`terrain material toggle had too little ground-pixel effect: ${JSON.stringify(change)}`);
    const off = await page.evaluate(() => window.__forge.marsState());
    if (off.terrainMaterialMode !== "single" || off.contactWheels < 4) throw new Error("terrain comparison changed contacts or did not toggle");
    console.log(`mars layered vs single: ${change.differing}/${change.pixels} ground pixels differ, max channel ${change.max}; ${state.terrainSplatTiles} splat tiles`);
  } finally {
    await page.evaluate((animating) => { window.__forge.setTerrainLayers(true); window.__forge.setAnimating(animating); }, wasAnimating);
  }
  await waitPresentedFrames(2);
  const after = await page.evaluate(() => ({ state: window.__forge.marsState(), stats: window.__forge.stats() }));
  if (after.state.terrainMaterialMode !== "layered" || after.stats.gpuErrors || after.stats.lastError) throw new Error(`terrain layers failed to restore: ${JSON.stringify(after)}`);
}

/**
 * Phase 16.5, focused: the demo's GPU-skinned arm on a real adapter. The mock suites prove the
 * palette arithmetic and that the right bind group is bound; only a device can prove the skinned
 * modules *compile* — a vertex location the pipeline's buffer layout does not provide, or a storage
 * binding the layout does not declare, is a shader-creation failure no other suite can reach — and
 * only pixels can prove the palette deformed the vertices. Two deterministic poses of the same
 * uploaded mesh isolate the second from everything else the frame draws.
 */
async function checkSkinning() {
  await page.waitForFunction(() => {
    const state = window.__forge.skinningState?.();
    return state !== null && state !== undefined && state.skinnedBatches > 0;
  }, null, { polling: 250, timeout: 60000 });
  // Async pipeline compilation: the skinned modules are created on first use, and a batch whose
  // pipeline is still pending is skipped rather than drawn (the renderer never blocks a frame). Wait
  // for the queue to drain, but assert on `failures` only: the scene keeps asking for variants (the
  // ground's unskinned ones, the prepass probe's), so sampling "pending" a frame later can legitimately
  // catch a new compile — and the pose A/B below is what proves the skinned pipelines actually drew.
  await page.waitForFunction(() => window.__forge.engine.renderer.pipelines.stats().pipelinesPending === 0, null, { polling: 250, timeout: 60000 });
  await waitPresentedFrames(2);
  const first = await page.evaluate(() => ({
    skinning: window.__forge.skinningState(),
    stats: window.__forge.stats(),
    pipelines: window.__forge.engine.renderer.pipelines.stats(),
  }));
  if (first.skinning.joints !== 4) throw new Error(`the arm has ${first.skinning.joints} joints, expected 4`);
  if (first.skinning.skinnedBatches !== 1) throw new Error(`the arm did not batch as one skinned draw (${first.skinning.skinnedBatches})`);
  if (first.skinning.skinJoints !== 4) throw new Error(`the frame uploaded ${first.skinning.skinJoints} joint matrices, expected 4`);
  if (first.skinning.skinFallbacks !== 0) throw new Error(`the arm fell back to the unskinned path (${first.skinning.skinFallbacks})`);
  if (first.pipelines.failures !== 0) {
    throw new Error(`skinned pipelines did not compile: ${JSON.stringify(first.pipelines)}`);
  }
  if (first.stats.gpuErrors !== 0 || first.stats.lastError) {
    throw new Error(`GPU error on the skinned arm: ${first.stats.lastError}`);
  }
  console.log(
    `skinned pipelines: ${first.pipelines.pipelines} created (${first.pipelines.creates} creates, ` +
    `${first.pipelines.cacheHits} hits, ${first.pipelines.pipelinesPending} still compiling, ${first.pipelines.failures} failures)`,
  );

  // Freeze the idle wave and A/B two of its poses. Both frames upload the same geometry and run the
  // same pipelines, so any pixel difference is the palette: the mock suite can see the bind group,
  // but only a device turns the matrices into moved vertices.
  await page.evaluate(() => window.__forge.setAnimating(false));
  await page.evaluate(() => window.__forge.setSkinPose(0));
  await waitPresentedFrames(2);
  await keepLuma("skin-pose-a");
  await page.evaluate(() => window.__forge.setSkinPose(1.1));
  await waitPresentedFrames(2);
  await keepLuma("skin-pose-b");
  const diff = await compareRgb("skin-pose-a", "skin-pose-b");
  const cover = await samplePixels();
  console.log(`skinned poses: ${diff.differing}/${diff.pixels} pixels differ (max ${diff.max} of 255), frame mean ${cover.mean.toFixed(1)}, ${cover.distinct} colours`);
  if (!(diff.differing >= 2000)) {
    throw new Error(`the two arm poses differ in only ${diff.differing} pixels; the palette is not deforming the mesh`);
  }
  if (!(diff.max >= 20)) throw new Error(`the two arm poses differ by at most ${diff.max}/255 levels`);
  if (!(cover.distinct >= 8)) throw new Error(`only ${cover.distinct} distinct colours; the arm scene is not rendering`);
  if (!(cover.mean >= 6)) throw new Error(`frame is almost black (mean luminance ${cover.mean.toFixed(1)})`);
  const after = await page.evaluate(() => window.__forge.stats());
  if (after.gpuErrors !== 0 || after.lastError) throw new Error(`GPU error after the pose A/B: ${after.lastError}`);
  // Coiled pose left on screen for inspection, like the other focused modes.
  await page.screenshot({ path: "tools/.browser-check-skinning.png", timeout: 60000 });
  return { ...first.skinning, differing: diff.differing, pixels: diff.pixels, maxDiff: diff.max };
}

/**
 * Phase 16.6, focused: the vehicle playground's mechanical wheel assemblies on a real adapter.
 *
 * The unit suites prove the joint arithmetic and the scene wiring on the mock device; only a device
 * proves the composed hierarchy (`base ∘ motion` per joint, aim joints solved against the store)
 * actually moves vertices through the renderer. The rig's gate hook poses all four corners from
 * fixed values, so two frames of the *same* uploaded geometry differ only by the wheel pose: a rig
 * that stops being driven (or a system left out of the world) freezes the pixels and fails.
 */
async function checkMechanical() {
  await page.waitForFunction(
    () => {
      const state = window.__forge.vehicleState?.();
      return Boolean(state && state.mechanical && state.mechanical.joints > 0);
    },
    null,
    { polling: 250, timeout: 60000 },
  );
  await page.waitForFunction(() => window.__forge.engine.renderer.pipelines.stats().pipelinesPending === 0, null, { polling: 250, timeout: 60000 });
  await waitPresentedFrames(2);
  const first = await page.evaluate(() => ({
    vehicle: window.__forge.vehicleState(),
    stats: window.__forge.stats(),
    pipelines: window.__forge.engine.renderer.pipelines.stats(),
  }));
  const mechanical = first.vehicle.mechanical;
  // travel + steer + spin per wheel, plus the arm and damper of every corner.
  const expectedJoints = first.vehicle.mechanical.joints;
  if (expectedJoints !== 20) throw new Error(`the wheel rig has ${expectedJoints} joints, expected 20 (4 corners x 5)`);
  if (mechanical.channels !== 12) throw new Error(`the wheel rig has ${mechanical.channels} channels, expected 12 (steer/spin/travel per wheel)`);
  if (first.pipelines.failures !== 0) throw new Error(`pipelines did not compile: ${JSON.stringify(first.pipelines)}`);
  if (first.stats.gpuErrors !== 0 || first.stats.lastError) {
    throw new Error(`GPU error before the wheel A/B: ${first.stats.lastError}`);
  }
  console.log(`mechanical rig: ${mechanical.joints} joints, ${mechanical.channels} channels, ${first.pipelines.pipelines} pipelines`);

  // Two deterministic poses of the same car: parked straight, then steered + compressed + rolled.
  await page.evaluate(() => window.__forge.setAnimating(false));
  await page.evaluate(() => window.__forge.setWheelOverride({ steer: 0, travel: 0, spin: 0 }));
  await waitPresentedFrames(2);
  await keepLuma("wheel-pose-a");
  await page.evaluate(() => window.__forge.setWheelOverride({ steer: 0.46, travel: 0.14, spin: 1.6 }));
  await waitPresentedFrames(2);
  await keepLuma("wheel-pose-b");
  const posed = await page.evaluate(() => window.__forge.vehicleState().mechanical);
  console.log(
    `wheel pose B: steer=${posed.steer.map((v) => v.toFixed(2)).join(",")} ` +
    `travel=${posed.travel.map((v) => v.toFixed(3)).join(",")} spin=${posed.spin.map((v) => v.toFixed(2)).join(",")}`,
  );
  if (Math.abs(posed.steer[0] - 0.46) > 1e-3) throw new Error(`the rig did not read the steer channel (${posed.steer[0]})`);
  if (Math.abs(posed.travel[0] - 0.14) > 1e-3) throw new Error(`the rig did not read the travel channel (${posed.travel[0]})`);
  // Left wheels negate the odometer, right wheels do not: the same channel rolls both sides forward.
  if (!(posed.spin[0] < -1.5 && posed.spin[1] > 1.5)) {
    throw new Error(`the left/right spin signs are wrong: ${posed.spin.join(",")}`);
  }
  // Only the steered corners yaw: the rig carries the Ackermann solver's per-wheel decision, so the
  // rear knuckles hold 0 even while the override asks for lock.
  if (!(Math.abs(posed.steer[2]) < 1e-6)) {
    throw new Error(`the un-steered rear wheel yawed to ${posed.steer[2]}`);
  }
  const diff = await compareRgb("wheel-pose-a", "wheel-pose-b");
  const cover = await samplePixels();
  console.log(`wheel poses: ${diff.differing}/${diff.pixels} pixels differ (max ${diff.max} of 255), frame mean ${cover.mean.toFixed(1)}, ${cover.distinct} colours`);
  if (!(diff.differing >= 500)) {
    throw new Error(`the two wheel poses differ in only ${diff.differing} pixels; the rig is not posing the assembly`);
  }
  if (!(diff.max >= 20)) throw new Error(`the two wheel poses differ by at most ${diff.max}/255 levels`);
  if (!(cover.distinct >= 8)) throw new Error(`only ${cover.distinct} distinct colours; the vehicle scene is not rendering`);
  if (!(cover.mean >= 6)) throw new Error(`frame is almost black (mean luminance ${cover.mean.toFixed(1)})`);
  await page.screenshot({ path: "tools/.browser-check-mechanical.png", timeout: 60000 });
  const after = await page.evaluate(() => window.__forge.stats());
  if (after.gpuErrors !== 0 || after.lastError) throw new Error(`GPU error after the wheel A/B: ${after.lastError}`);
  // Hand the rigs back to telemetry before anything downstream samples the scene.
  await page.evaluate(() => window.__forge.setWheelOverride(null));
  return { ...mechanical, differing: diff.differing, pixels: diff.pixels, maxDiff: diff.max };
}

/** Focused Alpine rescue smoke: selector wiring, dynamic physics, cargo mission, storm, and drive. */
async function checkAlpineRescue() {
  await waitPresentedFrames(2);
  await page.selectOption("#scene-select", "alpine-rescue", { force: true });
  await page.waitForFunction(() => window.__forge.sceneName === "alpine-rescue", null, { timeout: 10000 });
  await page.waitForFunction(() => {
    const state = window.__forge.alpineRescueState?.();
    return state?.physicsSteps >= 3 && state?.physicsBodies >= 20;
  }, null, { polling: 250, timeout: 90000 });
  const initial = await page.evaluate(() => ({ state: window.__forge.alpineRescueState(), stats: window.__forge.stats() }));
  if (initial.state.stage !== "load-kit") throw new Error(`rescue started at ${initial.state.stage}, expected load-kit`);
  if (initial.state.dynamicProps < 8) throw new Error(`only ${initial.state.dynamicProps} dynamic props were registered`);
  if (initial.state.objectiveDistance > 11) throw new Error(`starting cargo is out of interaction range (${initial.state.objectiveDistance.toFixed(1)} m)`);
  if (initial.stats.gpuErrors !== 0 || initial.stats.lastError) throw new Error(`rescue scene GPU error: ${initial.stats.lastError}`);

  const pickedUp = await page.evaluate(() => ({ ok: window.__forge.interactRescue(), state: window.__forge.alpineRescueState() }));
  if (!pickedUp.ok || pickedUp.state.stage !== "relay-1" || !pickedUp.state.cargoLoaded) {
    throw new Error(`medical kit pickup failed: ${JSON.stringify(pickedUp.state)}`);
  }
  const snowDepthBeforeStorm = await page.evaluate(() => window.__forge.alpineRescueState()?.snowpackDepthM ?? 0);
  await page.locator("#rescue-weather").click();
  await page.waitForFunction(() => {
    const state = window.__forge.alpineRescueState?.();
    return state?.weatherTarget === "storm" && state?.weatherIntensity >= 0.99;
  }, null, { polling: 100, timeout: 15000 });
  await page.waitForFunction((before) => {
    const state = window.__forge.alpineRescueState?.();
    return state?.snowAlive > 0 && state.snowEmitted > 0 && state.snowpackDepthM >= before + 0.01;
  }, snowDepthBeforeStorm, { polling: 100, timeout: 15000 });

  await page.locator("#rescue-headlights").click();
  const lights = await page.evaluate(() => window.__forge.alpineRescueState());
  if (lights.headlightsOn) throw new Error("rescue headlight action did not toggle the lamps off");
  const beforeDrive = lights.positionZ;
  await page.keyboard.down("KeyW");
  try {
    await page.waitForFunction((z) => window.__forge.alpineRescueState()?.positionZ > z + 0.45, beforeDrive, { polling: 100, timeout: 45000 });
  } finally {
    await page.keyboard.up("KeyW");
  }
  const driven = await page.evaluate(() => ({ state: window.__forge.alpineRescueState(), stats: window.__forge.stats() }));
  if (!(driven.state.speedKph > 0)) throw new Error("rescue vehicle has no speed after W input");
  await page.locator("#rescue-park").click();
  const parked = await page.evaluate(() => window.__forge.alpineRescueState());
  if (!parked.parked) throw new Error("rescue parking-brake action did not latch");
  if (driven.stats.gpuErrors !== 0 || driven.stats.lastError) throw new Error(`rescue drive GPU error: ${driven.stats.lastError}`);
  if (!driven.stats.renderPasses.includes("particle.render")) throw new Error("rescue snowfall did not submit the GPU particle render pass");
  if (!(driven.state.snowpackDepthM > snowDepthBeforeStorm)) throw new Error("rescue snowpack did not gain depth during snowfall");
  await page.screenshot({ path: "tools/.browser-check-alpine-rescue.png", timeout: 60000 });
  console.log(
    `alpine rescue: ${initial.state.physicsBodies} physics bodies / ${initial.state.physicsSteps} steps, ` +
      `cargo=${pickedUp.state.cargoLoaded}, storm=${lights.weatherIntensity.toFixed(2)}, ` +
      `snow=${driven.state.snowAlive} emitted=${driven.state.snowEmitted}, pack=${driven.state.snowpackDepthM.toFixed(2)} m, ` +
      `drive=${(driven.state.positionZ - beforeDrive).toFixed(2)} m`,
  );
  return driven.state;
}

/** The default gate still runs every renderer/scene/vehicle/articulation check. */
async function checkMarsInteractiveOnly() {
  await page.waitForFunction(() => {
    const state = window.__forge.marsState?.();
    return state?.modelLoaded === true && state?.terrainRoverChunkReady === true;
  }, null, { timeout: 90000 });
  const settled = await page.evaluate(() => ({ state: window.__forge.marsState(), stats: window.__forge.stats() }));
  if (!(settled.state.interactiveRocks > 0)) {
    throw new Error(`mars interactive: no near-field rocks were promoted (${settled.state.interactiveRocks})`);
  }
  if (settled.stats.gpuErrors !== 0 || settled.stats.lastError) {
    throw new Error(`mars interactive: GPU error before interaction (${settled.stats.lastError})`);
  }
  await page.keyboard.down("KeyW");
  try {
    await page.waitForTimeout(12000);
  } finally {
    await page.keyboard.up("KeyW");
  }
  const driven = await page.evaluate(() => ({ state: window.__forge.marsState(), stats: window.__forge.stats() }));
  if (driven.stats.gpuErrors !== 0 || driven.stats.lastError) {
    throw new Error(`mars interactive: GPU error after drive (${driven.stats.lastError})`);
  }
  if (!(driven.state.visibleTrackMarks > 0)) {
    throw new Error(`mars interactive: wheel tracks were not recorded (${driven.state.visibleTrackMarks})`);
  }
  console.log(`mars interactive: rocks=${driven.state.interactiveRocks}, tracks=${driven.state.visibleTrackMarks}, ` +
    `deformation=${driven.state.deformationSamples}, damage=${driven.state.roverDamageHull.toFixed(2)}/${driven.state.roverDamageSuspension.toFixed(2)}, ` +
    `gpuErrors=${driven.stats.gpuErrors}`);
}

async function checkAllScenes(backend) {
  await checkTerrainLayerPixels();
  const landingOption = await page.evaluate(
    () => document.querySelector("#scene-select option[selected]")?.getAttribute("value") ?? null,
  );
  if (landingOption !== "mars-showcase") throw new Error(`expected Mars Showcase as the landing-page default, got "${landingOption}"`);
  const requestedScene = await page.evaluate(() => window.__forge.sceneName);
  if (requestedScene !== "pbr") throw new Error(`?scene=pbr did not select the PBR fixture (active scene "${requestedScene}")`);
  console.log(`landing default: ${landingOption}; browser fixture: ${requestedScene}`);

  // Phase 9.1: prove the shipping module-worker can parse a real GLB and return its decoded mesh
  // through the scheduler without inline fallback. `--workers-only` runs this focused probe without
  // spending the full rendering gate's minutes on SwiftShader scene checks.
  const toFsUrl = (rel) => `/@fs${resolve(rel).replaceAll("\\", "/")}`;
  const workerProbe = await page.evaluate(async ({ engineUrl, fixtureUrl }) => {
    let scheduler = null;
    try {
      const { TaskScheduler, decodeGltfMesh } = await import(engineUrl);
      const response = await fetch(fixtureUrl);
      if (!response.ok) throw new Error(`GLB fixture fetch failed (${response.status})`);
      const bytes = await response.arrayBuffer();
      scheduler = new TaskScheduler({ workerCount: 1, maxConcurrent: 1 });
      const decoded = await decodeGltfMesh(bytes, { scheduler, source: "browser-worker-triangle.glb", transferInput: true });
      const primitive = decoded.meshes[0]?.primitives[0];
      return {
        ok: true,
        stats: scheduler.stats,
        meshCount: decoded.meshes.length,
        primitiveCount: decoded.primitiveCount,
        vertexCount: decoded.vertexCount,
        positions: primitive ? Array.from(primitive.attributes.POSITION ?? []) : [],
        indices: primitive?.indices ? Array.from(primitive.indices) : [],
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
    } finally {
      scheduler?.dispose();
    }
  }, {
    engineUrl: toFsUrl("engine/src/index.ts"),
    fixtureUrl: toFsUrl("tests/fixtures/triangle.glb"),
  });
  console.log(
    `Phase 9.1 browser worker: workers=${workerProbe.stats?.workers ?? 0} ` +
      `completed=${workerProbe.stats?.completed ?? 0} inlineFallbacks=${workerProbe.stats?.inlineFallbacks ?? 0} ` +
      `mesh=${workerProbe.meshCount ?? 0} vertices=${workerProbe.vertexCount ?? 0}`,
  );
  if (!workerProbe.ok) throw new Error(`Phase 9.1 browser GLB worker round-trip failed: ${workerProbe.error}`);
  if (workerProbe.stats?.inline || workerProbe.stats?.workers !== 1 || workerProbe.stats?.completed !== 1 ||
      workerProbe.stats?.inlineFallbacks !== 0 || workerProbe.stats?.workerFailures !== 0 ||
      workerProbe.meshCount !== 1 || workerProbe.primitiveCount !== 1 || workerProbe.vertexCount !== 3 ||
      JSON.stringify(workerProbe.positions) !== JSON.stringify([0, 0, 0, 1, 0, 0, 0, 1, 0]) ||
      JSON.stringify(workerProbe.indices) !== JSON.stringify([0, 1, 2])) {
    throw new Error(`Phase 9.1 browser worker result failed its round-trip assertions: ${JSON.stringify(workerProbe)}`);
  }
  if (workerSmokeOnly) {
    console.log("check:browser --workers-only passed (real browser module worker, no inline fallback)");
    await browser.close();
    vite.kill("SIGKILL");
    process.exit(0);
  }

  const before = await page.evaluate(() => window.__forge.stats());
  // SwiftShader can take several seconds to finish a frame under the initial PBR workload. Wait for
  // actual frame progress instead of treating any frame slower than a fixed 2.5 s as a stalled loop.
  let frameAdvanced = false;
  try {
    await page.waitForFunction((frame) => window.__forge.stats().frame > frame, before.frame, { polling: 100, timeout: 15000 });
    frameAdvanced = true;
  } catch {
    // Keep the detailed stats below as the diagnostic for a true timeout.
  }
  const after = await page.evaluate(() => window.__forge.stats());
  console.log("BEFORE STATS:", JSON.stringify(before));
  console.log("AFTER STATS:", JSON.stringify(after));
  console.log(`backend=${backend} frame ${before.frame} -> ${after.frame}, drawCalls=${after.drawCalls}, tris=${after.triangles}, fps=${after.fps.toFixed(1)}`);
  if (!frameAdvanced || !(after.frame > before.frame)) throw new Error(`loop stalled at frame ${after.frame} (15 s frame-progress timeout)`);
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
  // Phase 13.1/13.2: the depth prepass lays the opaque depth down before forge.main, SSAO reads it
  // (estimate + two blur passes, all before the forward pass that applies it), and the graph hands
  // the dead estimate target to the blur result — real memory aliasing on real WebGPU.
  const at = (name) => passes.indexOf(name);
  if (!after.render.depthPrepass || count("forge.prepass") !== 1) throw new Error(`the depth prepass did not run: ${passes.join(", ")}`);
  if (!(after.render.prepassDraws >= 1)) throw new Error("the depth prepass ran but drew nothing");
  if (!after.render.ssao || count("forge.ssao") !== 3) throw new Error(`SSAO (estimate + two blur passes) did not run: ${passes.join(", ")}`);
  if (!(at("forge.prepass") < at("forge.ssao") && at("forge.ssao") < at("forge.ssao.blur.h") && at("forge.ssao.blur.h") < at("forge.ssao.blur.v") && at("forge.ssao.blur.v") < at("forge.main"))) {
    throw new Error(`prepass/SSAO passes out of order: ${passes.join(" → ")}`);
  }
  if (!(after.render.aliasedBytes > 0 && after.render.physicalTextures < after.render.transientTextures)) {
    throw new Error(`no transient aliasing: ${after.render.transientTextures} transients → ${after.render.physicalTextures} textures, aliasedBytes ${after.render.aliasedBytes}`);
  }
  console.log(
    `prepass: ${after.render.prepassDraws} draws; ssao on; aliasing: ${after.render.transientTextures} transients → ${after.render.physicalTextures} textures (${after.render.aliasedBytes} B aliased)`,
  );

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

  const spotOnStats = await page.evaluate(() => window.__forge.stats());
  if (!(spotOnStats.render.spotShadowMaps >= 1) || !spotOnStats.renderPasses.some((p) => p.startsWith("forge.shadow.spot."))) {
    throw new Error(`the PBR spotlight did not produce a shadow map: ${spotOnStats.renderPasses.join(", ")}`);
  }
  await page.evaluate(() => window.__forge.setSpotShadows(false));
  await settle();
  const spotOffStats = await page.evaluate(() => window.__forge.stats());
  await keepLuma("spot-off");
  if (spotOffStats.render.spotShadowMaps !== 0 || spotOffStats.renderPasses.some((p) => p.startsWith("forge.shadow.spot."))) {
    throw new Error("the spot map/pass remained active after disabling the PBR spotlight's castShadow flag");
  }
  if (spotOffStats.render.shadowCascades < 1 || !spotOffStats.renderPasses.includes("forge.shadow.0")) {
    throw new Error("disabling the spot map also removed the directional cascades");
  }
  await page.evaluate(() => window.__forge.setSpotShadows(true));
  await settle();
  await keepLuma("spot-on");
  const spotDiff = await compareLuma("spot-off", "spot-on");
  const spotRestoredStats = await page.evaluate(() => window.__forge.stats());
  console.log(`spot shadows: ${spotDiff.darker} px darker on, ${spotDiff.brighter} brighter (max ${spotDiff.max.toFixed(1)} levels)`);
  if (!(spotRestoredStats.render.spotShadowMaps >= 1) || !spotRestoredStats.renderPasses.some((p) => p.startsWith("forge.shadow.spot."))) {
    throw new Error("the PBR spotlight shadow map did not return after the A/B toggle");
  }
  if (spotOffStats.gpuErrors !== 0 || spotOffStats.lastError || spotRestoredStats.gpuErrors !== 0 || spotRestoredStats.lastError) {
    throw new Error(`GPU error during the spot-shadow A/B: off=${spotOffStats.gpuErrors} (${spotOffStats.lastError}), restored=${spotRestoredStats.gpuErrors} (${spotRestoredStats.lastError})`);
  }
  if (spotDiff.darker < 1 || spotDiff.brighter !== 0) {
    throw new Error(`spot shadows produced no monotone darkening (${spotDiff.darker} darker, ${spotDiff.brighter} brighter pixels)`);
  }

  // Point-light cube shadows (Phase 13.9): the two orbiting point lights cast into six atlas layers
  // each. Same A/B shape as the spot arm above — animation stays frozen, so only the maps differ.
  const pointOnStats = await page.evaluate(() => window.__forge.stats());
  if (!(pointOnStats.render.pointShadowMaps >= 1) || !pointOnStats.renderPasses.some((p) => p.startsWith("forge.shadow.point."))) {
    throw new Error(`the PBR point lights did not produce shadow cubes: ${pointOnStats.renderPasses.join(", ")}`);
  }
  await page.evaluate(() => window.__forge.setPointShadows(false));
  await settle();
  const pointOffStats = await page.evaluate(() => window.__forge.stats());
  await keepLuma("point-off");
  if (pointOffStats.render.pointShadowMaps !== 0 || pointOffStats.renderPasses.some((p) => p.startsWith("forge.shadow.point."))) {
    throw new Error("the point cube maps/passes remained active after disabling the PBR point lights' castShadow flags");
  }
  if (pointOffStats.render.shadowCascades < 1 || !pointOffStats.renderPasses.includes("forge.shadow.0")) {
    throw new Error("disabling the point cubes also removed the directional cascades");
  }
  await page.evaluate(() => window.__forge.setPointShadows(true));
  await settle();
  await keepLuma("point-on");
  const pointDiff = await compareLuma("point-off", "point-on");
  const pointRestoredStats = await page.evaluate(() => window.__forge.stats());
  console.log(`point shadows: ${pointDiff.darker} px darker on, ${pointDiff.brighter} brighter (max ${pointDiff.max.toFixed(1)} levels)`);
  if (!(pointRestoredStats.render.pointShadowMaps >= 1) || !pointRestoredStats.renderPasses.some((p) => p.startsWith("forge.shadow.point."))) {
    throw new Error("the PBR point shadow cubes did not return after the A/B toggle");
  }
  if (pointOffStats.gpuErrors !== 0 || pointOffStats.lastError || pointRestoredStats.gpuErrors !== 0 || pointRestoredStats.lastError) {
    throw new Error(`GPU error during the point-shadow A/B: off=${pointOffStats.gpuErrors} (${pointOffStats.lastError}), restored=${pointRestoredStats.gpuErrors} (${pointRestoredStats.lastError})`);
  }
  if (pointDiff.darker < 1 || pointDiff.brighter !== 0) {
    throw new Error(`point shadows produced no monotone darkening (${pointDiff.darker} darker, ${pointDiff.brighter} brighter pixels)`);
  }

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

  // SSAO scales the ambient term only, so it can only take light away: switching it on must darken
  // a real set of pixels (contact areas: the torus, under and between the floating spheres), must
  // not brighten any, and must stay contact shading rather than a global dimmer. Per pixel at full
  // resolution — the fixture's direct lights dominate its ambient, so the effect is local and small.
  await settle(); // the shadow toggle above has just been undone
  await keepLuma("ssao-on");
  await page.evaluate(() => window.__forge.setSsao(false));
  await settle();
  const noSsao = await samplePixels();
  await keepLuma("ssao-off");
  const noSsaoStats = await page.evaluate(() => window.__forge.stats());
  const ao = await compareLuma("ssao-off", "ssao-on");
  const aoDrop = (noSsao.mean - base.mean) / noSsao.mean;
  console.log(
    `ssao: ${ao.darker} of ${ao.pixels} px darker with it (max ${ao.max.toFixed(1)} levels), ${ao.brighter} brighter; mean ${base.mean.toFixed(2)} (on) vs ${noSsao.mean.toFixed(2)} (off)`,
  );
  if (noSsaoStats.renderPasses.some((p) => p.startsWith("forge.ssao")) || noSsaoStats.render.ssao) throw new Error("SSAO passes still ran with SSAO disabled");
  if (!noSsaoStats.render.depthPrepass) throw new Error("disabling SSAO also turned the depth prepass off");
  if (ao.brighter > 0) throw new Error(`SSAO brightened ${ao.brighter} px — ambient occlusion can only remove light`);
  // 0.1 % of the frame: the fixture measured ~0.42–0.44 % (3,905–4,066 of 921,600 px at 1280x720,
  // up to ~5 levels, depending on where the animation froze).
  if (!(ao.darker >= ao.pixels * 0.001)) throw new Error(`SSAO darkened only ${ao.darker} of ${ao.pixels} px: the AO target is not reaching the ambient term`);
  if (!(aoDrop < 0.15)) throw new Error(`SSAO darkened the whole frame by ${(aoDrop * 100).toFixed(1)}% — contact shading, not a global dimmer`);

  // The depth prepass is an optimisation: with SSAO out of the picture, switching it off must not
  // move a single pixel (same vertex program + @invariant position ⇒ bit-identical depths).
  await page.evaluate(() => window.__forge.setDepthPrepass(false));
  await settle();
  await keepLuma("prepass-off");
  const noPrepassStats = await page.evaluate(() => window.__forge.stats());
  await page.evaluate(() => {
    window.__forge.setDepthPrepass(true);
    window.__forge.setSsao(true);
  });
  const prepassDiff = await compareLuma("ssao-off", "prepass-off");
  await page.evaluate(() => {
    delete window.__gateLuma;
    delete window.__gateRgb;
  });
  console.log(`prepass on vs off (ssao off): max luma diff ${prepassDiff.max.toFixed(2)}, ${prepassDiff.darker + prepassDiff.brighter} px beyond 1 level; passes off=${noPrepassStats.renderPasses.length}`);
  if (noPrepassStats.renderPasses.includes("forge.prepass") || noPrepassStats.render.depthPrepass) throw new Error("the depth prepass still ran with it disabled");
  if (prepassDiff.darker + prepassDiff.brighter > 0) {
    throw new Error(`the depth prepass changed the picture: ${prepassDiff.darker + prepassDiff.brighter} px differ by up to ${prepassDiff.max.toFixed(1)} luma levels`);
  }

  // Clustered (Forward+) lighting, Phase 13.3 — two claims, and only a real device can prove either.
  //
  //  1. While a scene fits in the old fixed 16-entry list, clustering must not move a single pixel.
  //     The cluster loop calls the same `lightContribution` the uniform loop does, over the same
  //     lights in the same order, so the accumulated sum is bit-identical; a light the grid failed to
  //     index, a slice boundary the CPU and the GPU quantise differently, or a reordered sum all show
  //     up here as a picture that moved. The PBR fixture holds a directional sun plus three local
  //     lights (two orbiting points and a spot) and the demo loop is frozen, so this is an exact A/B
  //     of the refactor and not a "looks similar" one.
  //  2. Past 16 lights the cluster path must carry all of them while the uniform path truncates — and
  //     report the truncation instead of letting 24 lamps vanish without a trace.
  await settle(); // the prepass A/B above re-enabled SSAO and the prepass without waiting for a frame
  // Clustering on/off is an A/B of what the fragment stage reads, so it is run with the fill that adds
  // no pass of its own (Phase 13.4's GPU fill is checked on its own below, where it must move nothing
  // either). This keeps 13.3's claim literal: clustering is a data change, not a structural one.
  await page.evaluate(() => window.__forge.setLightCulling("cpu"));
  await settle();
  await keepLuma("clustered-on");
  const clusteredOn = (await page.evaluate(() => window.__forge.stats())).render;
  await page.evaluate(() => window.__forge.setClusteredLighting(false));
  await settle();
  await keepLuma("clustered-off");
  const clusteredOff = (await page.evaluate(() => window.__forge.stats())).render;
  const clusterDiff = await compareLuma("clustered-off", "clustered-on");
  await page.evaluate(() => window.__forge.setClusteredLighting(true));
  await settle();
  console.log(
    `clustered: ${clusteredOn.clusteredLights} of ${clusteredOn.lights} lights indexed into ${clusteredOn.clustersUsed} clusters ` +
      `(${clusteredOn.clusterIndices} indices, cap ${clusteredOn.maxLightsPerCluster}); on vs off max luma diff ${clusterDiff.max.toFixed(2)}, ` +
      `${clusterDiff.darker + clusterDiff.brighter} px beyond 1 level; passes ${clusteredOn.passes} vs ${clusteredOff.passes}`,
  );
  if (!clusteredOn.clusteredLighting) throw new Error("the PBR fixture never engaged clustered lighting (a directional sun plus three local lights should)");
  if (clusteredOn.lights !== 4 || clusteredOn.clusteredLights !== 3) throw new Error(`clustered lighting saw ${clusteredOn.clusteredLights} local lights of ${clusteredOn.lights}; the fixture has 3 local + 1 directional`);
  if (clusteredOn.clustersUsed <= 0 || clusteredOn.clusterIndices <= 0) throw new Error("the cluster grid came out empty: no cluster received a light");
  if (clusteredOn.lightsDropped) throw new Error(`clustered lighting dropped a light with only ${clusteredOn.lights} in the scene (cap ${clusteredOn.maxLightsPerCluster} per cluster)`);
  if (clusteredOff.clusteredLighting) throw new Error("clustering stayed on after the scene setting was turned off");
  if (clusteredOff.lights !== clusteredOn.lights) throw new Error(`the light count changed when clustering was switched off (${clusteredOn.lights} → ${clusteredOff.lights})`);
  if (clusteredOff.passes !== clusteredOn.passes) throw new Error(`clustering changed the frame graph: ${clusteredOn.passes} passes with it, ${clusteredOff.passes} without`);
  if (clusterDiff.darker + clusterDiff.brighter > 0) {
    throw new Error(
      `clustering changed the picture with only ${clusteredOn.lights} lights: ${clusterDiff.darker + clusterDiff.brighter} px differ by up to ` +
        `${clusterDiff.max.toFixed(1)} luma levels — the cluster path is not accumulating what the uniform path does`,
    );
  }

  // The rig below is the production path — a device filling its own grid — so it runs on the GPU fill
  // (what `auto` resolves to where there is a device to run it on). The fills' own A/B comes later,
  // where both arms are taken from the same scene, one after the other.
  //
  // The switch above is the round trip that matters, and it is checked before anything reads a pixel:
  // "cpu" releases the culler's device resources, and every check below assumes the frame got a
  // working fill back. A culler kept after its dispose drops `forge.lights.assign` *silently*
  // (`Renderer.lightCulling`), and then nothing refills the grid: each frame would shade its lights
  // through index blocks left over from an earlier scene, which is exactly the shape the many-light
  // A/B below is looking for — but the honest failure is here, where the cause is.
  await page.evaluate(() => window.__forge.setLightCulling("gpu"));
  await settle();
  const fillHandover = await page.evaluate(() => ({
    pass: window.__forge.renderPasses().includes("forge.lights.assign"),
    fill: window.__forge.stats().render.clusterFill,
  }));
  console.log(`fill handover: cpu → gpu fill, forge.lights.assign ${fillHandover.pass ? "back in the frame" : "MISSING"} (fill=${fillHandover.fill})`);
  if (fillHandover.fill !== "gpu") throw new Error(`the fill did not switch back: the renderer reports "${fillHandover.fill}"`);
  if (!fillHandover.pass) {
    throw new Error("switching the fill back to \"gpu\" did not put forge.lights.assign back in the frame — the grid would keep whatever index blocks the last upload left on the device");
  }

  // The many-light rig: 36 static lamps, so the scene holds 40 — two and a half times what the fixed
  // list could carry. Clustering must deliver every one; the uniform path must truncate, say so, and
  // leave the frame visibly short of the light the same scene has when nothing is dropped.
  await page.evaluate(() => window.__forge.setStressLights(36));
  await settle();
  await keepLuma("many-clustered");
  const manyClustered = (await page.evaluate(() => window.__forge.stats())).render;
  await page.evaluate(() => window.__forge.setClusteredLighting(false));
  await settle();
  await keepLuma("many-uniform");
  const manyUniform = (await page.evaluate(() => window.__forge.stats())).render;
  const manyDiff = await compareLuma("many-uniform", "many-clustered");
  const manyPixels = await samplePixels();
  await page.evaluate(() => {
    window.__forge.setClusteredLighting(true);
    window.__forge.setStressLights(0);
  });
  await settle();
  await page.evaluate(() => {
    delete window.__gateLuma;
    delete window.__gateRgb;
  });
  const restoredLights = (await page.evaluate(() => window.__forge.stats())).render;
  console.log(
    `many lights: ${manyClustered.lights} in the scene → clustered ${manyClustered.clusteredLights} over ${manyClustered.clustersUsed} clusters ` +
      `(cap ${manyClustered.maxLightsPerCluster}, dropped ${manyClustered.lightsDropped}); the uniform list capped at 16, dropped ${manyUniform.lightsDropped}; ` +
      `${manyDiff.brighter} px brighter clustered (max ${manyDiff.max.toFixed(1)} levels), mean ${manyPixels.mean.toFixed(2)}; rig removed → ${restoredLights.lights} lights`,
  );
  if (manyClustered.lights < 17) throw new Error(`the many-light rig added no lights: ${manyClustered.lights} in the scene`);
  if (manyClustered.clusteredLights !== manyClustered.lights - 1) {
    throw new Error(`clustering carried ${manyClustered.clusteredLights} of ${manyClustered.lights} lights; every local light belongs in the grid (only the sun stays in the uniform list)`);
  }
  if (manyClustered.lightsDropped) throw new Error(`clustered lighting dropped lights at ${manyClustered.lights} (cap ${manyClustered.maxLightsPerCluster} per cluster): the grid does not cover the rig`);
  if (!manyUniform.lightsDropped) throw new Error(`the fixed uniform list reported no truncation with ${manyUniform.lights} lights in the scene`);
  if (manyDiff.brighter <= 0) throw new Error(`clustering lit no extra pixel at ${manyClustered.lights} lights: the cluster lists are not reaching the shader`);
  if (manyDiff.darker > 0) throw new Error(`clustering darkened ${manyDiff.darker} px at ${manyClustered.lights} lights — it can only add the lamps the uniform list dropped`);
  if (restoredLights.lights !== clusteredOn.lights || !restoredLights.clusteredLighting) throw new Error("removing the rig did not restore the fixture's four lights");

  // The demo's own button must move the setting the setter moves, and mark itself pressed.
  const clusteredButton = await page.evaluate(() => {
    const btn = document.getElementById("btn-clustered");
    if (!btn) return null;
    const before = btn.classList.contains("active");
    btn.click();
    const after = { pressed: btn.classList.contains("active"), setting: window.__forge.clusteredLighting() };
    btn.click();
    return { before, after, restored: btn.classList.contains("active") && window.__forge.clusteredLighting() };
  });
  await settle();
  if (!clusteredButton) throw new Error("the demo has no Clustered button (examples/index.html)");
  if (clusteredButton.before !== true) throw new Error("the Clustered button is not marked pressed while clustering is on");
  if (clusteredButton.after.pressed !== false || clusteredButton.after.setting !== false) {
    throw new Error("clicking Clustered did not turn clustering off in both the button and the scene setting");
  }
  if (!clusteredButton.restored) throw new Error("a second click on Clustered did not turn it back on");
  console.log(`clustered button: active=${clusteredButton.before} → click → active=${clusteredButton.after.pressed}, setting=${clusteredButton.after.setting} → click → restored=${clusteredButton.restored}`);

  // The two fills of one grid (Phase 13.4). The counting pass is shared — the CPU counts, the counts
  // are what the fragment stage indexes its lists with — so the only thing that can differ is the
  // *fill*: the shader's coverage walk, its eviction rule, its sorted output and its index arithmetic.
  // Every one of those moves pixels, so an identical picture is the claim, and identical stats are the
  // second half of it: a path that needed a readback to report the grid would report last frame's.
  await page.evaluate(() => window.__forge.setLightCulling("cpu"));
  await settle();
  await keepLuma("fill-cpu");
  const cpuFillStats = await page.evaluate(() => window.__forge.stats());
  const cpuFill = cpuFillStats.render;
  await page.evaluate(() => window.__forge.setLightCulling("gpu"));
  await settle();
  await keepLuma("fill-gpu");
  const gpuFillStats = await page.evaluate(() => window.__forge.stats());
  const gpuFill = gpuFillStats.render;
  const fillDiff = await compareLuma("fill-gpu", "fill-cpu");
  const fillPasses = cpuFillStats.renderPasses.filter((n) => !gpuFillStats.renderPasses.includes(n));
  const gpuExtra = gpuFillStats.renderPasses.filter((n) => !cpuFillStats.renderPasses.includes(n));
  const gridFields = ["clusteredLights", "clustersUsed", "clusterIndices", "maxLightsPerCluster", "lightsDropped"];
  const gpuArmHasPass = gpuFillStats.renderPasses.includes("forge.lights.assign");
  const cpuArmHasPass = cpuFillStats.renderPasses.includes("forge.lights.assign");
  console.log(
    `cluster fill: cpu vs gpu over the fixture — ${gpuFill.clusteredLights} lights, ${gpuFill.clusterIndices} indices, ` +
      `max luma diff ${fillDiff.max.toFixed(2)} / ${fillDiff.darker + fillDiff.brighter} px beyond 1 level; ` +
      `gpu adds pass ${gpuExtra.join(",") || "(none)"}; cpu-only passes ${fillPasses.join(",") || "(none)"}; ` +
      `forge.lights.assign: gpu arm ${gpuArmHasPass ? "yes" : "NO"}, cpu arm ${cpuArmHasPass ? "YES" : "no"}`,
  );
  // Who fills the grid is a property of the frame, and it is checkable without pixels: the arm that
  // reports "gpu" has to be the arm whose frame carries the pass. Both arms filling (or neither) would
  // make the picture comparison above meaningless — two frames neither of which the arm's own path drew.
  if (!gpuArmHasPass || cpuArmHasPass) {
    throw new Error(
      `the fill's ownership is wrong: the gpu arm ${gpuArmHasPass ? "has" : "lacks"} forge.lights.assign and the cpu arm ${cpuArmHasPass ? "has" : "lacks"} it`,
    );
  }
  if (cpuFill.clusterFill !== "cpu" || gpuFill.clusterFill !== "gpu") {
    throw new Error(`the fill modes did not switch: cpu arm says "${cpuFill.clusterFill}", gpu arm says "${gpuFill.clusterFill}"`);
  }
  for (const field of gridFields) {
    if (cpuFill[field] !== gpuFill[field]) {
      throw new Error(`the GPU fill reported a different grid than the CPU fill: ${field} ${JSON.stringify(cpuFill[field])} vs ${JSON.stringify(gpuFill[field])}`);
    }
  }
  if (fillDiff.darker + fillDiff.brighter > 0) {
    throw new Error(
      `the GPU fill changed the picture over the fixture: ${fillDiff.darker + fillDiff.brighter} px differ by up to ${fillDiff.max.toFixed(1)} luma levels — ` +
        `the shader is not writing the lists the CPU fill writes`,
    );
  }
  if (gpuExtra.length !== 1 || gpuExtra[0] !== "forge.lights.assign") {
    throw new Error(`the GPU fill should add exactly the assignment pass, not ${gpuExtra.join(",") || "(nothing)"}`);
  }
  if (fillPasses.length !== 0) throw new Error(`the GPU fill dropped ${fillPasses.join(",")} from the frame`);

  // Past the per-cluster cap: 40 lamps stacked into one small ball, so the fill has to evict the eight
  // least influential of them. This is the one path the spread-out rig never reaches, and the one where
  // a transcription error in the shader (the wrong minimum, the wrong comparison, light order lost
  // after an eviction) keeps 32 lamps but *different* ones — visible here as colour-coded pools of
  // light that should not have moved. The channels are compared, not just luma, because the kept lamps
  // differ in hue as much as in brightness.
  await page.evaluate(() => window.__forge.setLightCulling("cpu"));
  await page.evaluate(() => window.__forge.setStressLights(40, true));
  await settle();
  const stackedCpu = (await page.evaluate(() => window.__forge.stats())).render;
  await keepLuma("stacked-cpu");
  await page.evaluate(() => window.__forge.setLightCulling("gpu"));
  await settle();
  const stackedGpu = (await page.evaluate(() => window.__forge.stats())).render;
  await keepLuma("stacked-gpu");
  const stackedRgb = await compareRgb("stacked-gpu", "stacked-cpu");
  const stackedLuma = await compareLuma("stacked-gpu", "stacked-cpu");
  // ... and the rig has to be visible, or comparing two black frames would pass the check above.
  // `compareLuma(a, b)` counts pixels *b* brighter than *a*, so the idle capture is the "a" here: the
  // rig is what adds light (the reverse order reports the rig's own pools as `darker`, which reads as a
  // product failure that is not there).
  const stackedVsIdle = await compareLuma("fill-cpu", "stacked-cpu");
  console.log(
    `stacked rig: ${stackedCpu.lights} lights → ${stackedCpu.clusteredLights} clustered, cap ${stackedCpu.maxLightsPerCluster}, dropped ${stackedCpu.lightsDropped}; ` +
      `cpu vs gpu fills ${stackedRgb.differing} px differ (max channel ${stackedRgb.max}), luma ${stackedLuma.darker + stackedLuma.brighter} px, ` +
      `rig lights ${stackedVsIdle.brighter} px brighter than without it`,
  );
  if (!stackedCpu.lightsDropped || !stackedGpu.lightsDropped) {
    throw new Error(`the stacked rig did not overfill a cluster (dropped: cpu=${stackedCpu.lightsDropped}, gpu=${stackedGpu.lightsDropped})`);
  }
  if (stackedGpu.maxLightsPerCluster !== 32) throw new Error(`the stacked rig's fullest cluster holds ${stackedGpu.maxLightsPerCluster} lights, expected the 32-per-cluster cap`);
  if (stackedGpu.clusteredLights !== stackedGpu.lights - 1) throw new Error(`the stacked rig left lights out of the grid: ${stackedGpu.clusteredLights} of ${stackedGpu.lights}`);
  if (stackedVsIdle.brighter < 200) {
    throw new Error(
      `the stacked rig lit only ${stackedVsIdle.brighter} px, too few to tell the two fills apart ` +
        `(${stackedVsIdle.darker} px darker — the fixture's own lights are dimmer than the rig's)`,
    );
  }
  // The rig can only add light: its lamps are far below the fixture's own lights in influence, so the
  // eviction must never trade one of those away for a lamp. This is the same pair the many-light rig
  // asserts (brighter > 0, darker == 0), and it is what makes the two pixel checks above meaningful.
  if (stackedVsIdle.darker > 0) {
    throw new Error(
      `the stacked rig removed light: ${stackedVsIdle.darker} px darker with 40 lamps added (max ${stackedVsIdle.max.toFixed(1)} levels) — ` +
        "the per-cluster cap evicted a light it should have kept",
    );
  }
  if (stackedRgb.differing > 0) {
    throw new Error(
      `the two fills kept different lights past the per-cluster cap: ${stackedRgb.differing} px differ by up to ${stackedRgb.max} levels — ` +
        `the shader's eviction does not match the CPU fill's`,
    );
  }
  await page.evaluate(() => {
    window.__forge.setStressLights(0);
    window.__forge.setLightCulling("auto");
  });
  await settle();
  const restoredFill = await page.evaluate(() => ({ mode: window.__forge.lightCulling(), stats: window.__forge.stats() }));
  console.log(`cluster fill restored: mode ${restoredFill.mode}, ${restoredFill.stats.render.clusteredLights} clustered lights, no rig`);
  if (restoredFill.mode !== "gpu") throw new Error(`"auto" did not resolve back to the GPU fill on a device that has one (got "${restoredFill.mode}")`);
  if (restoredFill.stats.render.clusteredLights !== clusteredOn.clusteredLights) throw new Error("removing the stacked rig did not restore the fixture's local lights");
  await page.evaluate(() => {
    delete window.__gateLuma;
    delete window.__gateRgb;
  });

  // Object culling (Phase 13.5) — two claims, and only a real device can prove either.
  //
  //  1. The device path decides the same visibility the CPU twin does. The claim is *pixels*: the two
  //     paths run the same test on the same boxes with the same margins, and a batch either path got
  //     wrong is a hole in the picture (culled too much) or a wasted draw (culled too little). The
  //     fixture's five batches are all on screen, so this arm pins "the pass does not cull what is
  //     visible"; the terrain arm further down is where the frustum verdicts get exercised.
  //  2. The HiZ stage is conservative: switching it off may only ever *add* draws. Because the
  //     prepass depth holds the fixture's own opaque surfaces, a batch the culler drops as occluded
  //     would have been hidden behind them anyway — so the picture must be identical. This is the
  //     assertion that would have caught the mirrored-rectangle bug: culling a floating sphere
  //     against the ground rows *below* it removed it from the frame.
  await page.evaluate(() => window.__forge.setAnimating(false));
  await settle();
  await keepLuma("cull-gpu");
  const cullGpuStats = await page.evaluate(() => window.__forge.stats());
  const cullGpu = cullGpuStats.render;
  await page.evaluate(() => window.__forge.setObjectCulling("cpu"));
  await settle();
  await keepLuma("cull-cpu");
  const cullCpuStats = await page.evaluate(() => window.__forge.stats());
  const cullCpu = cullCpuStats.render;
  const cullDiff = await compareLuma("cull-cpu", "cull-gpu");
  const cullGpuHasPass = cullGpuStats.renderPasses.includes("forge.objects.cull");
  const cullCpuHasPass = cullCpuStats.renderPasses.includes("forge.objects.cull");
  console.log(
    `object culling: gpu vs cpu over the fixture — batches ${cullGpu.batches}, tested ${cullGpu.cullTested}, ` +
      `frustum ${cullGpu.cullFrustum}, occluded ${cullGpu.cullOccluded}; max luma diff ${cullDiff.max.toFixed(2)} / ` +
      `${cullDiff.darker + cullDiff.brighter} px beyond 1 level; forge.objects.cull: gpu arm ${cullGpuHasPass ? "yes" : "NO"}, cpu arm ${cullCpuHasPass ? "YES" : "no"}`,
  );
  if (cullDiff.darker + cullDiff.brighter > 0) {
    throw new Error(
      `the two cullers drew different frames: ${cullDiff.darker + cullDiff.brighter} px differ by up to ${cullDiff.max.toFixed(1)} luma levels — ` +
        `the compute pass is not deciding what the CPU twin decides`,
    );
  }
  if (!cullGpuHasPass || cullCpuHasPass) {
    throw new Error(`the cull pass belongs to the wrong arm: gpu ${cullGpuHasPass ? "has" : "lacks"} forge.objects.cull, cpu ${cullCpuHasPass ? "has" : "lacks"} it`);
  }
  // The device path reports its counters one frame late (a readback cannot be known sooner), so the
  // arm is allowed to report zeros and must not report a count the pass could not have produced.
  if (cullGpu.cullTested !== 0 && cullGpu.cullTested !== cullGpu.batches) {
    throw new Error(`the device culler tested ${cullGpu.cullTested} of ${cullGpu.batches} batches — neither the lagged zero nor the frame's own count`);
  }
  if (cullCpu.cullTested !== cullCpu.batches) throw new Error(`the CPU twin tested ${cullCpu.cullTested} of ${cullCpu.batches} batches`);

  await page.evaluate(() => window.__forge.setOcclusionCulling(false));
  await settle();
  await keepLuma("cull-no-hiz");
  const noHizStats = await page.evaluate(() => window.__forge.stats());
  const noHizDiff = await compareLuma("cull-no-hiz", "cull-gpu");
  const hizPasses = cullGpuStats.renderPasses.filter((n) => n.startsWith("forge.hiz"));
  const noHizPasses = noHizStats.renderPasses.filter((n) => n.startsWith("forge.hiz"));
  console.log(
    `occlusion culling: hiz passes ${hizPasses.length} → ${noHizPasses.length}; with vs without max luma diff ` +
      `${noHizDiff.max.toFixed(2)} / ${noHizDiff.darker + noHizDiff.brighter} px beyond 1 level; ` +
      `occluded px/word verdicts ${cullGpu.cullOccluded} → ${noHizStats.render.cullOccluded}`,
  );
  if (noHizPasses.length !== 0) throw new Error(`the HiZ pyramid ran with occlusion culling off: ${noHizPasses.join(", ")}`);
  if (hizPasses.length === 0) throw new Error("occlusion culling on did not build a HiZ pyramid on a device that supports it");
  if (noHizDiff.darker > 0) {
    throw new Error(
      `disabling occlusion culling removed light from ${noHizDiff.darker} px — a batch the culler had dropped was in front of what it drew`,
    );
  }
  if (noHizDiff.darker + noHizDiff.brighter > 0) {
    throw new Error(
      `the occlusion stage changed the picture: ${noHizDiff.darker + noHizDiff.brighter} px differ by up to ${noHizDiff.max.toFixed(1)} luma levels — ` +
        `a batch it dropped as hidden was not hidden (the mirrored-rectangle bug is exactly this)`,
    );
  }
  const restoredCull = await page.evaluate(() => {
    window.__forge.setOcclusionCulling(true);
    window.__forge.setObjectCulling("auto");
    window.__forge.setAnimating(true);
    return { mode: window.__forge.objectCulling(), occlusion: window.__forge.occlusionCulling() };
  });
  await settle();
  console.log(`object culling restored: mode ${restoredCull.mode}, occlusion ${restoredCull.occlusion}`);
  if (restoredCull.mode !== "gpu" || !restoredCull.occlusion) throw new Error('"auto" did not resolve back to the device culler with occlusion on');

  await page.evaluate(() => {
    delete window.__gateLuma;
    delete window.__gateRgb;
  });

  // Indirect draws (Phase 13.6) — the frame's draws come out of buffers the cull pass writes, and the
  // two ways to submit it (through the records, or one direct draw per batch) draw the same picture.
  //
  //  1. The records are the draws: with indirect submission on, every `forge.main` draw is
  //     `drawIndexedIndirect` (`stats.render.indirectDraws === batches`), and the cull pass's own
  //     counters agree with each other — `visible` is what the three tests left, and `recordZeroed` is
  //     what they dropped. Both are produced on the device, so this is the pass's arithmetic, not the
  //     twin's (which the mock tests cover).
  //  2. The switch is a switch: turning it off returns to one direct draw per batch over the same
  //     verdicts, and the picture does not change by a pixel — with a draw distance in place, so the
  //     compared frames really do have culled batches in them. That is the claim a device can settle
  //     and a unit test cannot: the record's words really are the draw commands.
  //  3. The distance test really does zero records on a device: the 1 m draw distance drops batches the
  //     frame built (a per-renderable limit the CPU's visibility knows nothing about), and the pass's
  //     own counters have to add up — `recordZeroed` is the cull sum on the record arm and zero on the
  //     direct one, whose frame is drawn by the clip-collapse path instead.
  // The A/B is per-pixel, so the scene must hold still, and it is worth nothing unless batches are
  // actually culled: a 1 m draw distance over the fixture's renderables makes the *device* drop batches
  // the frame built (a per-renderable limit the CPU's own visibility never sees). Both arms then cull
  // the same batches by different means — a zero-instance record, or Phase 13.5's collapsed clip
  // position — so an identical picture is exactly the claim that a record's words are the command.
  await page.evaluate(() => {
    window.__forge.setAnimating(false);
    window.__forge.setObjectDistance(1);
  });
  await settle();
  await waitForCullReadback(true);
  await keepLuma("indirect-on");
  const indirectOnStats = await page.evaluate(() => window.__forge.stats());
  const indirectOn = indirectOnStats.render;

  await page.evaluate(() => window.__forge.setIndirectDraws(false));
  await settle();
  await waitForCullReadback(false);
  await keepLuma("indirect-off");
  const indirectOffStats = await page.evaluate(() => window.__forge.stats());
  const indirectOff = indirectOffStats.render;
  const indirectDiff = await compareLuma("indirect-off", "indirect-on");
  console.log(
    `indirect draws: batches ${indirectOn.batches}, indirect ${indirectOn.indirectDraws} of ${indirectOn.drawCalls} draws (off: ${indirectOff.indirectDraws} of ${indirectOff.drawCalls}), ` +
      `visible ${indirectOn.cullVisible}, zeroed records ${indirectOn.cullRecordZeroed}, distance-culled ${indirectOn.cullDistance}; ` +
      `max luma diff ${indirectDiff.max.toFixed(2)} / ${indirectDiff.darker + indirectDiff.brighter} px beyond 1 level`,
  );
  if (indirectOn.cullDistance <= 0) throw new Error("a 1 m draw distance over the fixture culled nothing on the device — the arm has no culled batch to compare");
  // The two arms issue the *same* calls, one submitted through a record per batch and one drawn
  // directly: same count, same picture. That is the claim a device can settle and a unit test cannot.
  if (indirectOn.indirectDraws <= 0) throw new Error("the indirect arm issued no indirect draw at all — the records are not driving forge.main");
  if (indirectOn.drawCalls !== indirectOff.drawCalls) {
    throw new Error(`the two submission paths issued ${indirectOn.drawCalls} and ${indirectOff.drawCalls} draw calls for the same frame`);
  }
  if (indirectOff.indirectDraws !== 0) throw new Error(`the direct arm still issued ${indirectOff.indirectDraws} indirect draws`);
  if (indirectDiff.darker + indirectDiff.brighter > 0) {
    throw new Error(
      `the two submission paths drew different frames: ${indirectDiff.darker + indirectDiff.brighter} px differ by up to ${indirectDiff.max.toFixed(1)} luma levels — ` +
        `the record words are not the draw commands the direct path issues`,
    );
  }
  // The counters describe the same frame on both arms — a cull is a cull, however the frame submits —
  // but only the indirect arm writes records, so `recordZeroed` is the cull sum there and exactly zero
  // on the direct arm (a direct frame sets no CULL_FLAG_RECORDS and the pass leaves the buffer alone).
  for (const [arm, r, writesRecords] of [
    ["indirect", indirectOn, true],
    ["direct", indirectOff, false],
  ]) {
    const culled = r.cullFrustum + r.cullDistance + r.cullOccluded;
    if (r.cullTested === 0) continue; // the counters lag one frame after a mode switch; the identity is what matters
    if (r.cullVisible !== r.cullTested - culled) {
      throw new Error(`${arm} arm: the pass tested ${r.cullTested}, culled ${culled}, but published ${r.cullVisible} visible`);
    }
    if (writesRecords ? r.cullRecordZeroed !== culled : r.cullRecordZeroed !== 0) {
      throw new Error(`${arm} arm: ${culled} batches culled, ${r.cullRecordZeroed} records zeroed (${writesRecords ? "expected one per cull" : "expected none on the direct path"})`);
    }
  }
  const restoredDistance = await page.evaluate(() => {
    window.__forge.setIndirectDraws(true);
    window.__forge.setObjectDistance(-1); // negative restores the limits the scene shipped with
    window.__forge.setAnimating(true);
    return { indirect: window.__forge.indirectDraws() };
  });
  await settle();
  const restoredDraw = await page.evaluate(() => window.__forge.stats().render);
  console.log(
    `indirect draws restored: on via ${restoredDraw.indirectDraws} records, draw distance restored (distance-culled ${restoredDraw.cullDistance})`,
  );
  if (!restoredDistance.indirect) throw new Error("the indirect-draw switch did not come back on");

  await page.evaluate(() => {
    delete window.__gateLuma;
    delete window.__gateRgb;
  });

  // The LDR path (forward pass straight into the swapchain, in-shader tone map) must still present.
  await page.evaluate(() => window.__forge.setHdr(false));
  await settle();
  const ldr = await samplePixels();
  const ldrStats = await page.evaluate(() => window.__forge.stats());
  await page.evaluate(() => window.__forge.setHdr(true));
  console.log(`ldr: mean ${ldr.mean.toFixed(2)} distinct=${ldr.distinct}; passes=${ldrStats.renderPasses.join(",")}`);
  if (ldrStats.render.hdr || ldrStats.renderPasses.includes("forge.tonemap")) throw new Error("LDR toggle did not switch the frame off the post chain");
  if (!ldrStats.render.ssao || !ldrStats.render.depthPrepass) throw new Error("the prepass/SSAO chain did not survive the switch to the LDR path");
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
  if (!restored.render.hdr || restored.render.bloomMips < 1 || restored.render.shadowCascades < 1 || !restored.render.ssao) throw new Error("render state did not restore after the toggles");

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

  // Phase 14: the streamed disc carries a deterministic rock/boulder population. It must actually
  // draw (instances and batches > 0) while the entity count stays in the terrain-chunk + lights +
  // camera range — the point of populations is thousands of instances with no entity per instance,
  // so an entity count that grew with the instances would mean the seam regressed to renderables.
  const populationStart = await page.evaluate(() => {
    const s = window.__forge.stats();
    return {
      instances: s.render.populationInstances,
      batches: s.render.populationBatches,
      lodBatches: s.render.populationLodBatches,
      populationLodPass: s.renderPasses.includes("forge.populationLod"),
      entities: s.entities,
      frameInstances: s.instances,
      gpuErrors: s.gpuErrors,
    };
  });
  if (!(populationStart.instances > 100)) {
    throw new Error(`the terrain population did not draw (${populationStart.instances} instances in ${populationStart.batches} batches)`);
  }
  if (!(populationStart.batches >= 4)) throw new Error(`the terrain population drew too few batches (${populationStart.batches})`);
  if (!(populationStart.lodBatches > 0) || !populationStart.populationLodPass) {
    throw new Error(`GPU population LOD did not run (${populationStart.lodBatches} LOD batches, pass=${populationStart.populationLodPass})`);
  }
  if (!(populationStart.entities < 400)) {
    throw new Error(`population instances became entities (${populationStart.entities} entities for ${populationStart.instances} instances)`);
  }
  if (populationStart.gpuErrors > 0) throw new Error(`gpu errors after population draw: ${populationStart.gpuErrors}`);
  console.log(
    `  population: ${populationStart.instances} instances in ${populationStart.batches} batches, ` +
      `${populationStart.lodBatches} GPU-LOD batches, entities ${populationStart.entities}, ` +
      `instances(frame) ${populationStart.frameInstances}`,
  );

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

  // Phase 12.4/12.7: trail ribbons. The scene builds with ribbons ON, so every assertion above was
  // already met with the ribbon pipeline, its bind group and its drawIndirect record in the frame —
  // zero device errors is the compile+validation proof. What remains is the *live* behaviour:
  //  1. the `__forge` toggle reaches the running system (state plumbing through demo, world and system),
  //  2. turning the draw off mid-run keeps the frame clean — the resolve pass must keep the ribbon
  //     record at zero instances, or the stale count would draw garbage,
  //  3. the strips are real geometry in the picture. The *animated* demo scene cannot decide that:
  //     its fountain density drifts between sample windows by more than the ribbon delta (a first
  //     gate implementation compared alternating mean-luma windows and failed on exactly that
  //     drift, in both directions depending on machine load). `runParticleRibbonCheck` instead
  //     re-renders two same-seed fountains — ribbons on vs off — on an isolated offscreen device
  //     and reads their final frames back: both frames hold the same particles, so only the
  //     ribbon draw can move the numbers. Draw order may still differ (the compact list is
  //     atomic-filled), hence margins over pixels rather than per-pixel equality.
  if (particles.ribbons !== true) {
    throw new Error(`particle scene should default to ribbons ON for the gate (got ${JSON.stringify(particles.ribbons)})`);
  }
  await page.evaluate(() => window.__forge.setParticleRibbons(false));
  await settle(6);
  const ribbonOff = await page.evaluate(() => ({ particles: window.__forge.particleState(), stats: window.__forge.stats() }));
  if (ribbonOff.particles?.ribbons !== false) {
    throw new Error("setParticleRibbons(false) did not reach the live system");
  }
  if (ribbonOff.stats.gpuErrors !== 0 || ribbonOff.stats.lastError) {
    throw new Error(`particle scene GPU errors with ribbons off: ${ribbonOff.stats.lastError}`);
  }
  await page.screenshot({ path: "tools/.browser-check-particles-noribbons.png" });
  await page.evaluate(() => window.__forge.setParticleRibbons(true));
  await settle(6);
  const ribbonOn = await page.evaluate(() => ({ particles: window.__forge.particleState(), stats: window.__forge.stats() }));
  if (ribbonOn.particles?.ribbons !== true) throw new Error("setParticleRibbons(true) did not restore the draw");
  if (ribbonOn.stats.gpuErrors !== 0 || ribbonOn.stats.lastError) {
    throw new Error(`particle scene GPU errors after restoring ribbons: ${ribbonOn.stats.lastError}`);
  }
  const ribbonCheck = await page.evaluate(() => window.__forge.runParticleRibbonCheck());
  console.log(
    `ribbon trails: offscreen oracle — lit ${ribbonCheck?.litOn} vs ${ribbonCheck?.litOff}, ` +
      `mean luma ${ribbonCheck?.meanOn?.toFixed(2)} vs ${ribbonCheck?.meanOff?.toFixed(2)}, ` +
      `darker px ${ribbonCheck?.darkerPixels}/${ribbonCheck?.totalPixels} (draw-order noise, reported not asserted), ` +
      `errors ${ribbonCheck?.gpuErrors}; live-toggle errors ${ribbonOff.stats.gpuErrors}/${ribbonOn.stats.gpuErrors}`,
  );
  if (!ribbonCheck || ribbonCheck.gpuExecuted !== true) {
    throw new Error(`ribbon oracle did not run on the real device: ${JSON.stringify(ribbonCheck)}`);
  }
  if (ribbonCheck.gpuErrors !== 0) throw new Error(`ribbon oracle hit GPU errors: ${ribbonCheck.gpuErrors}`);
  if (!(ribbonCheck.litOn > ribbonCheck.litOff * 1.1 && ribbonCheck.meanOn > ribbonCheck.meanOff * 1.05)) {
    throw new Error(
      `ribbons did not measurably grow the rendered ember field (lit ${ribbonCheck.litOn} vs ${ribbonCheck.litOff}; ` +
        `mean ${ribbonCheck.meanOn.toFixed(2)} vs ${ribbonCheck.meanOff.toFixed(2)})`,
    );
  }
  if (ribbonCheck.litOff > ribbonCheck.totalPixels * 0.75) {
    throw new Error("the check's fountain saturates its canvas — the margins are meaningless until size/alpha come down");
  }

  // Phase 16.5: the skinned arm in the full gate too — the focused `--skinning` mode is a fast path,
  // not the only evidence. Same assertions, on the demo's own route through `loadScene`.
  await page.evaluate(() => window.__forge.loadScene("skinning"));
  // The pose A/B needs the scene's own `update` out of the way (it would overwrite `setSkinPose`), and
  // it restores what it found: sections below decide for themselves whether the loop runs.
  const skinningWasAnimating = await page.evaluate(() => window.__forge.animating());
  const skinning = await checkSkinning();
  await page.evaluate((animating) => window.__forge.setAnimating(animating), skinningWasAnimating);
  console.log(
    `skinned arm (full gate): joints=${skinning.joints} batches=${skinning.skinnedBatches} ` +
      `poses differ in ${skinning.differing}/${skinning.pixels} px (max ${skinning.maxDiff})`,
  );

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
  if (!wxStormStats.renderPasses.includes("particle.render")) throw new Error("weather rain did not submit the GPU particle render pass");
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

  // ---------------------------------------------------------- Phase 10.9: ported-generator inspector
  // The showcase below drives the port at *one* surveyed site; `?scene=mars-generator` is the other
  // half of the port's demo coverage — the site comes from the URL, the camera is free, and there is
  // no rover. Two things need the real adapter rather than the mock: the four-slice PBR arrays must
  // upload and bind through SplatMaterial, and a site the port's geology actually mixes at (0°N 0°E,
  // the crater field) must come back with one tile whose mask is a genuine two-channel blend.
  // It runs before the showcase because the showcase section's W-drive check is frame-rate bound on
  // SwiftShader and has aborted this gate repeatedly; an arm after it would be coverage on paper only.
  const waitForGeneratorTiles = async (min, where) => {
    try {
      await page.waitForFunction(
        (n) => {
          const world = (window.__forge?.scene?.objects ?? []).find((o) => o && o.name === "TerrainWorld");
          if (!world) return false;
          const baked = [...world.chunks.values()].filter((c) => c.tile?.gpuMaterial).length;
          return baked >= n;
        },
        min,
        { polling: 250, timeout: 120000 },
      );
    } catch (error) {
      throw new Error(`the generator inspector streamed no ${min} splat tiles (${where}): ${String(error.message).split("\n")[0]}`);
    }
    await settle(2);
  };
  /**
   * Read every resident tile's mask back from the CPU twin of the weights and report how it splits:
   * the dominant-channel histogram (which tiles look alike) plus the best-mixed tile's shares. The
   * latter is the discriminating number — a single-channel site leaves it at 0.
   */
  const generatorMaskStats = () =>
    page.evaluate(() => {
      const world = (window.__forge.scene.objects ?? []).find((o) => o && o.name === "TerrainWorld");
      const layered = world?.layeredMaterial;
      if (!layered) return null;
      const counts = [0, 0, 0, 0];
      let tiles = 0;
      let bestSecond = 0;
      let bestShares = null;
      for (const chunk of world.chunks.values()) {
        const cell = chunk.tile?.cell;
        if (!cell) continue;
        const pixels = layered.weightPixels(cell);
        const sums = [0, 0, 0, 0];
        for (let i = 0; i < pixels.length; i += 4) for (let c = 0; c < 4; c++) sums[c] += pixels[i + c];
        const total = sums[0] + sums[1] + sums[2] + sums[3];
        if (total <= 0) continue;
        const shares = sums.map((s) => s / total);
        const sorted = [...shares].sort((a, b) => b - a);
        let top = 0;
        for (let c = 1; c < 4; c++) if (shares[c] > shares[top]) top = c;
        counts[top]++;
        tiles++;
        if (sorted[1] > bestSecond) {
          bestSecond = sorted[1];
          bestShares = shares.map((s) => +s.toFixed(3));
        }
      }
      return { tiles, counts, bestSecond: +bestSecond.toFixed(3), bestShares };
    });

  await page.evaluate(() => window.__forge.loadScene("mars-generator"));
  await waitForGeneratorTiles(6, "selector path");
  const generator = await page.evaluate(() => ({ state: window.__forge.marsGeneratorState(), stats: window.__forge.stats() }));
  if (!generator.state) throw new Error("?scene=mars-generator did not expose marsGeneratorState()");
  if (generator.state.site !== "olympusMons") {
    throw new Error(`the generator inspector did not open the volcano preset: ${JSON.stringify(generator.state)}`);
  }
  if (generator.state.generation !== "workers") {
    throw new Error(`the ported generator is not running on workers in the demo: ${generator.state.generation}`);
  }
  if (generator.state.materialMode !== "layered" || generator.state.layers.join(",") !== "dust,rock,sand,crust") {
    throw new Error(`the inspector's four-layer path is not resident: ${JSON.stringify(generator.state)}`);
  }
  if (generator.state.hasErosionCorrection !== false) {
    throw new Error("the inspector claims an erosion cache this repo does not ship");
  }
  if (generator.state.chunkSize !== 128 || generator.state.skirtDepth !== 32 || generator.state.splatTiles < 6) {
    throw new Error(`the advised size/skirts did not reach the world: ${JSON.stringify(generator.state)}`);
  }
  if (generator.stats.gpuErrors !== 0 || generator.stats.lastError) {
    throw new Error(`GPU errors in the generator inspector (${generator.stats.gpuErrors}): ${generator.stats.lastError}`);
  }
  console.log(
    `mars generator: ${generator.state.site} — ${generator.state.readyChunks} chunks, ${generator.state.splatTiles} splat tiles, ` +
      `${generator.state.generation}, ${generator.state.materialMode}`,
  );

  // The deep link is a real navigation (what a URL does), and 0,0 is the site where the port's
  // regional material rules mix channels: its crater rim splits a tile roughly 45/55 rock/crust,
  // while the volcano and canyon presets bake one channel for kilometres (measured over resident
  // mock tiles in tests/examples/marsGeneratorScene.test.ts). So the claim checked here is *within one tile*:
  // a non-dominant channel must carry a real share of the mask, which a flat material cannot fake.
  await page.goto(`${URL}?scene=mars-generator&marssite=0,0`, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => window.__forge !== undefined, null, { timeout: 45000 });
  await waitForGeneratorTiles(6, "crater-field deep link");
  const crater = await page.evaluate(() => ({ state: window.__forge.marsGeneratorState(), stats: window.__forge.stats() }));
  if (crater.state?.site !== "lat 0 lon 0") {
    throw new Error(`?marssite=0,0 did not reach the stage: ${JSON.stringify(crater.state)}`);
  }
  const mask = await generatorMaskStats();
  if (!mask || mask.tiles < 6) throw new Error(`could not read the crater field's weight masks: ${JSON.stringify(mask)}`);
  // 25 % is well below the ~45/55 split the crater rim produces and well above the 0 a flat or
  // single-region site would leave, so this fails on a broken splat without pinning a float.
  if (mask.bestSecond < 0.25) {
    throw new Error(
      `the crater field's masks are single-channel (${JSON.stringify(mask)}): no tile mixes two channels, ` +
        "so the port's splat is not reaching the tiles",
    );
  }
  if (crater.stats.gpuErrors !== 0 || crater.stats.lastError) {
    throw new Error(`GPU errors at the crater field (${crater.stats.gpuErrors}): ${crater.stats.lastError}`);
  }
  console.log(
    `mars generator (crater field): ${mask.tiles} tiles, dominant dust/rock/sand/crust = ${mask.counts.join("/")}, ` +
      `best-mixed tile ${JSON.stringify(mask.bestShares)} (second channel ${mask.bestSecond})`,
  );
  await page.screenshot({ path: "tools/.browser-check-mars-generator.png", timeout: 60000 });

  // Mars showcase: the Perseverance GLB must load (a fetch that 404s or a bad magic number used
  // to leave the placeholder driving around), the six model wheels must be found and settle into
  // terrain contact, and W must actually drive it — with dust and ballistic rock chips that prove
  // the wheels are scrubbing the regolith, and zero new GPU errors. Everything here polls against *states*
  // instead of counting frames: SwiftShader presents the showcase at well under 1 fps, so a fixed
  // frame budget would either crawl for minutes or race the model fetch. The polls' timeouts are
  // *stall* budgets renewed while the scene keeps making progress, because at a third of a frame per
  // second a wall-clock cap measures the rasteriser rather than the choreography (see `pollMars`).
  // The viewport is the
  // 900×520 the panel check above just left us on — the heaviest scene runs ~4× slower at 1280×720.
  await page.evaluate(() => window.__forge.loadScene("mars-showcase"));
  /**
   * Poll `window.__forge.marsState()` until `predicate` holds.
   *
   * `timeoutMs` is a *stall* budget rather than a wall-clock one whenever `progressOf` is supplied.
   * It has to be: the showcase presents at a fraction of a frame per second under SwiftShader, and
   * the scene's own choreography clocks (the HGA countdown, the arm spring) are advanced by the demo
   * loop's `dt`, which `main.ts` clamps to 0.05 s per presented frame — so the antenna's five-second
   * countdown is ~100 presented frames, i.e. ~6 minutes of wall clock at a third of a frame per
   * second. A fixed wall-clock cap measures the rasteriser instead of the choreography, which is
   * exactly how "HGA never started deploying in 300s" failed with 0.75 s still on the countdown.
   * With `progressOf`, the budget is renewed while the measure keeps improving and only `timeoutMs`
   * of *no* progress fails the poll, so a scene that is genuinely stuck still fails, and slower
   * machines stop being read as broken ones. `hardCapMs` bounds the whole wait regardless.
   */
  const pollMars = async (label, predicate, timeoutMs, progressOf = null, hardCapMs = 900000) => {
    const hardDeadline = Date.now() + hardCapMs;
    let deadline = Date.now() + timeoutMs;
    let last = null;
    let best = -Infinity;
    while (Date.now() < deadline && Date.now() < hardDeadline) {
      last = await page.evaluate(() => window.__forge.marsState());
      if (last && predicate(last)) return last;
      if (last && progressOf) {
        const value = progressOf(last);
        if (Number.isFinite(value) && value > best + 1e-9) {
          best = value;
          deadline = Date.now() + timeoutMs;
        }
      }
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
  if (marsLoaded.terrainGenerator !== "mars" || marsLoaded.terrainHasErosion !== false) {
    throw new Error(`mars showcase: expected the analytic-only Mars port, got ${marsLoaded.terrainGenerator}, erosion=${marsLoaded.terrainHasErosion}`);
  }
  const marsSettled = await pollMars(
    "mars showcase: rover tile never became resident with terrain contact (≥4 of 6) in 45s",
    (s) => s.terrainRoverChunkReady && s.terrainReadyChunks > 0 && s.contactWheels >= 4,
    45000,
  );
  await verifyMarsWorkers(page);
  await checkShowcaseLayers();
  const checkMarsSurface = (state) => {
    const clearance = state.y - state.terrainGroundHeight;
    if (!state.terrainRoverChunkReady || !Number.isFinite(clearance) || clearance < 0.2 || clearance > 1.2) {
      throw new Error(`mars showcase: rover is not on its resident surface (ready=${state.terrainRoverChunkReady}, clearance=${clearance})`);
    }
    return clearance;
  };
  if (!(marsSettled.interactiveRocks > 0)) {
    throw new Error(`mars showcase: no near-field interactive rocks were promoted (${marsSettled.interactiveRocks})`);
  }
  console.log(`mars terrain: ${marsSettled.terrainGenerator} analytic-only, ${marsSettled.terrainReadyChunks} ready tiles, clearance=${checkMarsSurface(marsSettled).toFixed(3)}m, interactive rocks=${marsSettled.interactiveRocks}`);
  const marsStatsBefore = await page.evaluate(() => window.__forge.stats());
  if (marsStatsBefore.gpuErrors !== 0 || marsStatsBefore.lastError) {
    throw new Error(`mars showcase GPU errors before driving: ${marsStatsBefore.lastError}`);
  }
  // Material captures may take many slow frames. Measure W travel from *now*, never include
  // idle downhill drift during those captures in the drive distance (either sign).
  const marsAtDrive = await page.evaluate(() => window.__forge.marsState());
  checkMarsSurface(marsAtDrive);
  const zStart = marsAtDrive.z;
  // Budget the drive in *simulated* throttle seconds, not wall-clock ones. `VehicleSystem` steps the
  // chassis once per fixed step, and `Clock` caps catch-up at `maxSubSteps` (5) of them per presented
  // frame, so this scene — well under 1 fps on SwiftShader — advances at most 1/12 s of throttle per
  // frame, whatever the wall clock did. A 45 s wall-clock cap therefore bought only ≈0.8 s of
  // throttle, and the tune it was written against covered 0.41 m in its first 0.75 s from rest on
  // flat ground (`tests/examples/marsShowcase.test.ts` now pins the 1.5×-speed tune below 1.6 m/s after one second):
  // the >0.5 m assertion was measuring the
  // software rasteriser's frame rate through the drive tune, and it failed on exactly the tune it is
  // meant to protect. Hold W until the simulation has run DRIVE_THROTTLE_SECONDS of throttle; the
  // distance break still fires first wherever the rover is quick enough, so a real GPU (and a
  // SwiftShader run that gets there) costs no more wall clock than the old fixed cap did.
  const MARS_DRIVE_MIN_DZ = 0.5;
  const DRIVE_THROTTLE_SECONDS = 2;
  /** Backstop for a rover that never reaches the distance: 1 s of throttle measured ≈58 s here. */
  const DRIVE_WALL_CAP_MS = 180000;
  // The fixed clock is the one the chassis is integrated on (`elapsedTime` also counts the dropped
  // catch-up time, which the rover never felt).
  const marsSimSeconds = () => page.evaluate(() => window.__forge.engine.clock.fixedTime);
  const simStart = await marsSimSeconds();
  const frameStart = (await page.evaluate(() => window.__forge.stats())).frame;
  await page.keyboard.down("KeyW");
  let maxSpeed = 0;
  let maxKick = 0;
  let maxChips = 0;
  let marsDriven = null;
  let simDriven = simStart;
  try {
    const deadline = Date.now() + DRIVE_WALL_CAP_MS;
    while (Date.now() < deadline) {
      marsDriven = await page.evaluate(() => window.__forge.marsState());
      simDriven = await marsSimSeconds();
      maxSpeed = Math.max(maxSpeed, marsDriven.speed ?? 0);
      maxKick = Math.max(maxKick, marsDriven.kickDust ?? 0);
      maxChips = Math.max(maxChips, marsDriven.kickDebris ?? 0);
      if (marsDriven.z - zStart > MARS_DRIVE_MIN_DZ) break;
      if (simDriven - simStart >= DRIVE_THROTTLE_SECONDS) break;
      await page.waitForTimeout(500);
    }
  } finally {
    await page.keyboard.up("KeyW");
  }
  const marsDz = marsDriven ? marsDriven.z - zStart : 0;
  const simThrottle = Math.max(0, simDriven - simStart);
  const driveFrames = (await page.evaluate(() => window.__forge.stats())).frame - frameStart;
  console.log(
    `mars showcase drive: dz=${marsDz.toFixed(2)}m maxSpeed=${maxSpeed.toFixed(2)}m/s ` +
      `maxKickDust=${maxKick} maxRockChips=${maxChips} contact=${marsDriven?.contactWheels} ` +
      `throttle=${simThrottle.toFixed(2)}s over ${driveFrames} presented frames`,
  );
  if (!(marsDz > MARS_DRIVE_MIN_DZ)) {
    throw new Error(
      `mars showcase: W did not drive the rover forward (dz ${marsDz.toFixed(3)}m ` +
        `after ${simThrottle.toFixed(2)}s of throttle in ${driveFrames} frames)`,
    );
  }
  checkMarsSurface(marsDriven);
  if (!(maxSpeed > 0.3)) throw new Error(`mars showcase: rover never got rolling under W (max speed ${maxSpeed.toFixed(3)} m/s)`);
  if (!(maxKick > 0)) throw new Error("mars showcase: driving produced no kick dust");
  if (!(maxChips > 0)) throw new Error("mars showcase: driving produced no ballistic rock chips");
  // High-gain antenna: it arms when the GLB lands and unfurls five seconds of the demo loop's dt
  // later — ~100 presented frames on this rasteriser, since main.ts clamps that dt to 0.05 s — so
  // "deploying" on the real device proves the countdown + pivots are wired. Convergence onto the
  // Earth target is only ~3 more seconds of dt — minutes at SwiftShader's showcase frame
  // rate — so like the robotic arm below, on-target tracking is pinned by tests/examples/highGainAntenna.test.ts
  // and the gate asserts the choreography started and the dish left its stowed pose.
  const hgaMoving = await pollMars(
    "mars showcase: HGA never started deploying (no antenna progress for 300s)",
    (s) =>
      (s.antenna?.phase === "deploying" || s.antenna?.phase === "tracking") &&
      Math.abs(((s.antenna.azimuthDeg - 180 + 540) % 360) - 180) > 10, // off the stowed (aft) pose
    300000,
    // Progress toward the unfurl: the countdown falls to zero, then the deploy clock rises. Monotone
    // without hard-coding the delay, and a countdown that stops falling — or a phase that never
    // flips — stops renewing the budget, so a genuinely stuck antenna still fails the poll.
    (s) => (s.antenna ? (s.antenna.phase === "stowed" ? -s.antenna.countdown : 1 + s.antenna.deployT) : Number.NaN),
  );
  console.log(
    `mars showcase HGA: phase=${hgaMoving.antenna.phase} az=${hgaMoving.antenna.azimuthDeg.toFixed(1)}° ` +
      `el=${hgaMoving.antenna.elevationDeg.toFixed(1)}° (target ${hgaMoving.antenna.targetAzimuthDeg.toFixed(1)}°, ${hgaMoving.antenna.targetElevationDeg.toFixed(1)}°)`,
  );
  const marsStatsAfter = await page.evaluate(() => window.__forge.stats());
  if (marsStatsAfter.gpuErrors !== marsStatsBefore.gpuErrors || marsStatsAfter.lastError) {
    throw new Error(`mars showcase GPU errors while driving: ${marsStatsAfter.lastError}`);
  }
  // Robotic arm: R must start the unfold on the real device — joints leaving the stowed pose proves
  // the GLB's arm chain is wired to the pivots — and stowing must bring every joint back to exactly
  // zero with the thumbsticks hidden. A full unfold is 6 s of sim time, minutes at SwiftShader's
  // showcase frame rate, so the unfolded sticks and jogging are covered by
  // tests/examples/roverArm.test.ts, tests/controls/armTouch.test.ts and tests/controls/vehicleTouch.test.ts instead.
  await page.keyboard.press("KeyR");
  const armMoving = await pollMars(
    "mars showcase: R did not start the robotic-arm unfold (no arm progress for 60s)",
    (s) => s.armDeployed === true && s.armT > 0.05 && Math.abs(s.armJoints?.[2] ?? 0) > 1,
    60000,
    (s) => s.armT, // the unfold clock rises only while the spring is running
  );
  // Phase 16.6: the pivots are posed by MechanicalSystem from the controller's channels, so the
  // angle read back off the pivot must leave the stowed pose and turn the same way as the command.
  // Poll rather than sample: the store is posed on the engine frame after the controller updates, so
  // the pivot reading trails the command by a frame (seconds at SwiftShader's showcase frame rate).
  // Only "it moved" and the sign are asserted: the elbow advances tens of degrees per frame here, so
  // demanding agreement with the command would assert the frame rate, not the rig.
  const armPivotsMoving = await pollMars(
    "mars showcase: the arm pivots never followed the commanded unfold (is MechanicalSystem posing them?)",
    (s) => Math.abs(s.armPivotDeg?.[2] ?? 0) > 1 && Math.sign(s.armPivotDeg?.[2] ?? 0) === Math.sign(s.armJoints?.[2] ?? 0),
    20000,
    () => 0, // a settled rig is not progress; only the predicate ending the wait counts
  );
  console.log(
    `mars showcase arm pivots: elbow commanded ${(armPivotsMoving.armJoints?.[2] ?? 0).toFixed(1)}°, ` +
      `pivot ${(armPivotsMoving.armPivotDeg?.[2] ?? 0).toFixed(1)}°`,
  );
  await page.evaluate(() => window.__forge.setArm(false));
  const armStowed = await pollMars(
    "mars showcase: robotic arm did not stow back (no arm progress for 90s)",
    (s) => s.armDeployed === false && s.armT === 0,
    90000,
    (s) => -s.armT, // stowing runs the same clock backwards
  );
  console.log(
    `mars showcase arm: unfold t=${armMoving.armT.toFixed(2)} joints=[${armMoving.armJoints.map((v) => v.toFixed(1)).join(", ")}] ` +
      `→ stowed joints=[${armStowed.armJoints.map((v) => v.toFixed(1)).join(", ")}] sticks=${armStowed.armSticksVisible}`,
  );
  if (armStowed.armJoints.some((v) => v !== 0)) throw new Error(`mars showcase: stowed arm joints not zero: ${armStowed.armJoints}`);
  // Same one-frame trail: wait for the rig to write the rest pose, then read it back. This is what
  // proves the joints are still driven after the unfold, not only during it.
  if (armStowed.armPivotDeg?.length !== 5) {
    throw new Error(`mars showcase: the arm rig is not reporting five pivots (${JSON.stringify(armStowed.armPivotDeg)})`);
  }
  const armSettled = await pollMars(
    "mars showcase: stowed arm pivots did not return to rest (MechanicalSystem stopped posing them?)",
    (s) => (s.armPivotDeg ?? []).every((v) => Math.abs(v) < 1e-3),
    20000,
    () => 0,
  );
  if (armSettled.armPivotDeg.some((v) => !Number.isFinite(v))) {
    throw new Error(`mars showcase: non-finite stowed pivot angles: ${armSettled.armPivotDeg}`);
  }
  if (armStowed.armSticksVisible) throw new Error("mars showcase: arm thumbsticks still shown with the arm stowed");
  const marsStatsArm = await page.evaluate(() => window.__forge.stats());
  if (marsStatsArm.gpuErrors !== marsStatsAfter.gpuErrors || marsStatsArm.lastError) {
    throw new Error(`mars showcase GPU errors while moving the arm: ${marsStatsArm.lastError}`);
  }
  // Explicit timeout like the other Mars captures: this is the heaviest scene in the gate, it
  // presents at a fraction of a frame per second here, and Playwright's capture has to be handed a
  // compositor frame. The 30 s default timed out on the gate's last step, after every assertion in
  // this section had already passed — the most expensive possible place to lose the run.
  await page.screenshot({ path: "tools/.browser-check-showcase.png", timeout: 120000 });
}

let exitCode = 0;
try {
  // Most product visits use `/` and land on Mars Showcase. Start this rendering-foundation suite on
  // its lightweight PBR fixture explicitly; the showcase is exercised below after the other scenes.
  await page.goto(`${URL}?scene=${MARS_WORKERS_ONLY || MARS_INTERACTIVE_ONLY ? "mars-showcase" : "pbr"}`, { waitUntil: "load", timeout: 60000 });
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
  if (MARS_INTERACTIVE_ONLY) {
    await checkMarsInteractiveOnly();
    console.log("Focused Mars interactive checks only; the all-scene renderer, HGA and arm suite was not run.");
  } else if (TERRAIN_LAYERS_ONLY) {
    await checkTerrainLayerPixels();
    await page.selectOption("#scene-select", "mars-showcase", { force: true });
    await verifyMarsWorkers(page);
    await checkShowcaseLayers();
    console.log("Focused layered-material pixel/worker/upload checks only; the all-scene drive/articulation suite was not run.");
  } else if (SKINNING_ONLY) {
    await waitPresentedFrames(1);
    // Exercise the same selector path users take from one demo to another; the scene's direct URL
    // route is covered by the resolver tests, while this catches a dropdown option that is accepted
    // by the URL but omitted from the change handler.
    await page.selectOption("#scene-select", "skinning", { force: true });
    await page.waitForFunction(() => window.__forge.sceneName === "skinning", null, { timeout: 10000 });
    const skinning = await checkSkinning();
    console.log(
      `skinned arm: joints=${skinning.joints} skinnedBatches=${skinning.skinnedBatches} ` +
        `skinJoints=${skinning.skinJoints} fallbacks=${skinning.skinFallbacks} ` +
        `poses differ in ${skinning.differing}/${skinning.pixels} px (max ${skinning.maxDiff}/255)`,
    );
    console.log("Focused GPU-skinning checks only; the all-scene renderer, drive and articulation suite was not run.");
  } else if (RESCUE_ONLY) {
    await checkAlpineRescue();
    console.log("Focused Alpine rescue mission/physics/weather checks only; the full renderer and Mars suite was not run.");
  } else if (MECHANICAL_ONLY) {
    await waitPresentedFrames(1);
    await page.selectOption("#scene-select", "vehicle", { force: true });
    await page.waitForFunction(() => window.__forge.sceneName === "vehicle", null, { timeout: 10000 });
    const mechanical = await checkMechanical();
    console.log(
      `mechanical wheels: joints=${mechanical.joints} channels=${mechanical.channels} ` +
      `poses differ in ${mechanical.differing}/${mechanical.pixels} px (max ${mechanical.maxDiff}/255)`,
    );
    console.log("Focused mechanical-animation checks only; the all-scene renderer, drive and Mars suite was not run.");
  } else if (MARS_WORKERS_ONLY) {
    await verifyMarsWorkers(page);
    // Pending pipelines deliberately skip draws. Wait for the normal async startup to finish
    // before the visual inspection capture, without changing quality or freezing the simulation.
    await page.waitForFunction(() => window.__forge.stats().render.pipelinesPending === 0, null, { timeout: 60000 });
    await page.screenshot({ path: "tools/.browser-check-mars-workers.png", timeout: 60000 });
    const final = await page.evaluate(() => window.__forge.stats());
    if (final.gpuErrors || final.lastError) throw new Error(`Mars worker rendering error: ${final.lastError}`);
    console.log("Focused worker/upload checks only; renderer A/Bs, W-drive, HGA and arm checks were not run.");
  } else {
    await checkAllScenes(backend);
  }
} catch (error) {
  problems.push(String(error.stack ?? error.message).split("\n").slice(0, 6).join("\n"));
  exitCode = 1;
}

const fatal = problems.filter((p) => !p.startsWith("console.warn:"));
for (const p of problems) console.log(`- ${p}`);
if (exitCode === 0 && fatal.length > 0) {
  console.error(`\n${CHECK_NAME} FAILED (${fatal.length} console/page error(s))`);
  exitCode = 1;
} else if (exitCode === 0) {
  console.log(`\n${CHECK_NAME} passed (real WebGPU, headless Chromium + SwiftShader) — ${await describeGpu()}`);
}
await browser.close();
vite.kill("SIGKILL");
process.exit(exitCode);
Code);
