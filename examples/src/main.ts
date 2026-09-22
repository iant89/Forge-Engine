/**
 * Forge Engine — Interactive Demo & Verification Host.
 *
 * Supports:
 * - Phase 1: Spinning Cubes Demo.
 * - Phase 2: PBR Showcase Demo (Metallic x Roughness, Normal maps, Point/Spot/Sun lights, Emissive)
 *   rendered through the Phase 2 frame: cascaded shadow maps, HDR target, bloom, tone-map resolve.
 * - Phase 6: vehicle playground. Input is written in the scene `update`; `VehicleSystem` is the only stepper.
 * - Phase 7: particle fountain via `ParticleWorld` only (do not also attach `ParticleSystem`).
 * - Phase 8a: sky / day-night scene — `DayNightCycle` drives the sun, ambient, fog and the
 *   `forge.sky` pass; `[`/`]` scrub the clock, `M` swaps Earth for Mars.
 * - Orbit camera controls (mouse drag, wheel zoom, pan, touch pinch); each scene supplies its own
 *   framing, zoom range and (terrain) the surface the camera must stay above.
 * - On-screen touch controls where a keyboard is not available: the vehicle stick/pads and the
 *   weather preset/action buttons. CSS hides them on a desktop pointer; the modules always bind the
 *   same actions as the keys, so there is one path per action either way.
 * - Real-time statistics HUD (including the render-graph pass list), tone-mapping switcher and
 *   rendering toggles (HDR, bloom, shadows, cascade tint).
 * - `window.__forge` interface for automated headless verification (`npm run check:browser`): the
 *   gate flips the toggles and reads pixels back, so every switch here must be reachable from it.
 */
import {
  type DayNightCycle,
  Engine,
  detectPlatform,
  runParticleGravityCheck,
  type ParticleGravityCheckOptions,
  type Scene,
  type ToneMapping,
  type TerrainWorld,
} from "@forge/engine";
import { OrbitControls } from "./controls/orbitControls.js";
import { buildCubesScene, type DemoSceneHandle } from "./scenes/cubesScene.js";
import { buildPbrScene } from "./scenes/pbrScene.js";
import { buildTerrainScene } from "./scenes/terrainScene.js";
import { buildRealisticTerrainScene } from "./scenes/realisticTerrainScene.js";
import { buildVehiclePlaygroundScene } from "./scenes/vehiclePlaygroundScene.js";
import { buildParticleScene } from "./scenes/particleScene.js";
import { buildSkyScene, type SkySceneHandle } from "./scenes/skyScene.js";
import { buildWeatherScene, type WeatherSceneHandle } from "./scenes/weatherScene.js";

const canvas = document.getElementById("view") as HTMLCanvasElement;
const hud = document.getElementById("hud") as HTMLDivElement;
const errorBox = document.getElementById("error") as HTMLDivElement;

const sceneSelect = document.getElementById("scene-select") as HTMLSelectElement | null;
const controlsHint = document.getElementById("controls-hint");
const DEFAULT_HINT = "Drag to orbit · Right-drag or arrows to pan · Scroll to zoom";
const btnTmAces = document.getElementById("btn-tm-aces") as HTMLButtonElement | null;
const btnTmFilmic = document.getElementById("btn-tm-filmic") as HTMLButtonElement | null;
const btnTmReinhard = document.getElementById("btn-tm-reinhard") as HTMLButtonElement | null;
const btnTmNone = document.getElementById("btn-tm-none") as HTMLButtonElement | null;
const btnHdr = document.getElementById("btn-hdr") as HTMLButtonElement | null;
const btnBloom = document.getElementById("btn-bloom") as HTMLButtonElement | null;
const btnShadows = document.getElementById("btn-shadows") as HTMLButtonElement | null;
const btnCascades = document.getElementById("btn-cascades") as HTMLButtonElement | null;

function showError(text: string): void {
  errorBox.style.display = "block";
  errorBox.textContent = text;
}

async function main(): Promise<void> {
  const platform = detectPlatform();
  const engine = await Engine.create({ canvas, quality: "high", logLevel: "info" });
  const where = `${platform.browser}/${platform.os}  ${engine.gpu.format}  dpr ${Math.min(platform.devicePixelRatio, 2).toFixed(2)}`;

  let currentHandle: DemoSceneHandle | null = null;
  let controls: OrbitControls | null = null;
  let activeSceneName = "pbr";

  // Check query parameter (?scene=cubes, ?scene=pbr, ?scene=terrain, ?scene=realistic, ?scene=vehicle, ?scene=particles, ?scene=sky)
  const params = new URLSearchParams(window.location.search);
  const requestedScene = params.get("scene");
  if (requestedScene === "cubes") {
    activeSceneName = "cubes";
  } else if (requestedScene === "terrain") {
    activeSceneName = "terrain";
  } else if (requestedScene === "realistic" || requestedScene === "realistic-terrain") {
    activeSceneName = "realistic";
  } else if (requestedScene === "vehicle" || requestedScene === "vehicle-playground") {
    activeSceneName = "vehicle";
  } else if (requestedScene === "particles") {
    activeSceneName = "particles";
  } else if (requestedScene === "sky") {
    activeSceneName = "sky";
  } else if (requestedScene === "weather") {
    activeSceneName = "weather";
  }

  type SceneName = "pbr" | "cubes" | "terrain" | "realistic" | "vehicle" | "particles" | "sky" | "weather";

  function loadScene(name: SceneName): void {
    if (currentHandle) {
      currentHandle.dispose?.();
    }
    // Drop the previous controller with its scene: an undisposed one keeps orbiting the old camera
    // (and re-applying every wheel event) for the lifetime of the page.
    controls?.dispose();
    controls = null;

    activeSceneName = name;
    // The vehicle pad and the weather buttons are shown by CSS on `body.scene-*` (coarse pointer or
    // phone-sized viewport only); their modules always bind the same paths as the keys.
    document.body.classList.toggle("scene-vehicle", name === "vehicle");
    document.body.classList.toggle("scene-weather", name === "weather");
    if (sceneSelect && sceneSelect.value !== name) sceneSelect.value = name;

    if (name === "pbr") {
      currentHandle = buildPbrScene(engine);
    } else if (name === "terrain") {
      currentHandle = buildTerrainScene(engine);
    } else if (name === "realistic") {
      currentHandle = buildRealisticTerrainScene(engine, { preset: "alpine" });
    } else if (name === "vehicle") {
      currentHandle = buildVehiclePlaygroundScene(engine);
    } else if (name === "particles") {
      currentHandle = buildParticleScene(engine);
    } else if (name === "sky") {
      currentHandle = buildSkyScene(engine);
    } else if (name === "weather") {
      currentHandle = buildWeatherScene(engine);
    } else {
      currentHandle = buildCubesScene(engine);
    }
    if (controlsHint) controlsHint.textContent = currentHandle.controlsHint ?? DEFAULT_HINT;

    engine.setScene(currentHandle.scene);
    const settings = currentHandle.scene.settings;
    btnHdr?.classList.toggle("active", settings.hdr);
    btnBloom?.classList.toggle("active", settings.bloom.enabled);
    if (btnBloom) btnBloom.disabled = !settings.hdr;
    btnShadows?.classList.toggle("active", settings.shadow.enabled);
    btnCascades?.classList.toggle("active", settings.shadow.debugCascades);
    if (btnCascades) btnCascades.disabled = !settings.shadow.enabled;
    btnTmAces?.classList.toggle("active", settings.toneMapping === "aces");
    btnTmFilmic?.classList.toggle("active", settings.toneMapping === "filmic");
    btnTmReinhard?.classList.toggle("active", settings.toneMapping === "reinhard");
    btnTmNone?.classList.toggle("active", settings.toneMapping === "none");
    // Scene modules own their camera policy (starting framing, zoom range, surface constraint).
    controls = new OrbitControls(currentHandle.cameraEntity, canvas).configure(currentHandle.camera ?? {});
  }

  loadScene(activeSceneName as SceneName);
  engine.start();

  sceneSelect?.addEventListener("change", () => {
    const next = sceneSelect.value;
    if (
      next === "pbr" ||
      next === "cubes" ||
      next === "terrain" ||
      next === "realistic" ||
      next === "vehicle" ||
      next === "particles" ||
      next === "sky" ||
      next === "weather"
    ) {
      loadScene(next);
    }
  });

  function setToneMapping(mode: ToneMapping): void {
    if (!currentHandle) return;
    currentHandle.scene.settings.toneMapping = mode;
    btnTmAces?.classList.toggle("active", mode === "aces");
    btnTmFilmic?.classList.toggle("active", mode === "filmic");
    btnTmReinhard?.classList.toggle("active", mode === "reinhard");
    btnTmNone?.classList.toggle("active", mode === "none");
  }

  btnTmAces?.addEventListener("click", () => setToneMapping("aces"));
  btnTmFilmic?.addEventListener("click", () => setToneMapping("filmic"));
  btnTmReinhard?.addEventListener("click", () => setToneMapping("reinhard"));
  btnTmNone?.addEventListener("click", () => setToneMapping("none"));

  // Rendering toggles. Each writes scene settings only; the renderer re-plans the frame graph from
  // them next frame (no engine restart, no pipeline rebuild beyond the first use of a variant).
  function syncRenderButtons(): void {
    const s = currentHandle?.scene.settings;
    if (!s) return;
    btnHdr?.classList.toggle("active", s.hdr);
    btnBloom?.classList.toggle("active", s.bloom.enabled);
    if (btnBloom) btnBloom.disabled = !s.hdr;
    btnShadows?.classList.toggle("active", s.shadow.enabled);
    btnCascades?.classList.toggle("active", s.shadow.debugCascades);
    if (btnCascades) btnCascades.disabled = !s.shadow.enabled;
  }
  function setHdr(on: boolean): void {
    if (!currentHandle) return;
    currentHandle.scene.settings.hdr = on;
    syncRenderButtons();
  }
  function setBloom(on: boolean): void {
    if (!currentHandle) return;
    currentHandle.scene.settings.bloom.enabled = on;
    syncRenderButtons();
  }
  function setShadows(on: boolean): void {
    if (!currentHandle) return;
    currentHandle.scene.settings.shadow.enabled = on;
    syncRenderButtons();
  }
  function setCascadeDebug(on: boolean): void {
    if (!currentHandle) return;
    currentHandle.scene.settings.shadow.debugCascades = on;
    syncRenderButtons();
  }
  btnHdr?.addEventListener("click", () => setHdr(!currentHandle?.scene.settings.hdr));
  btnBloom?.addEventListener("click", () => setBloom(!currentHandle?.scene.settings.bloom.enabled));
  btnShadows?.addEventListener("click", () => setShadows(!currentHandle?.scene.settings.shadow.enabled));
  btnCascades?.addEventListener("click", () => setCascadeDebug(!currentHandle?.scene.settings.shadow.debugCascades));
  syncRenderButtons();

  // The browser gate freezes the animation so two readbacks differ only by the toggle between them.
  let animating = true;

  // Animation & HUD loop
  let last = performance.now();
  let firstError: string | null = null;
  let shownError: string | null = null;

  const frameLoop = (): void => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    if (currentHandle && animating) {
      currentHandle.update(dt);
      const follow = currentHandle.followTarget?.();
      if (follow && controls) controls.target.set(follow.x, follow.y, follow.z);
    }
    // Recomputed every frame so the surface constraint tracks terrain that streams in under a
    // stationary camera; it is a few trig ops plus (on the terrain scene) two height samples.
    controls?.update();

    const st = engine.stats();
    const health = st.deviceLost ? "DEVICE LOST" : st.gpuErrors > 0 ? `gpu errors ${st.gpuErrors}` : "gpu ok";
    const r = st.render;
    const path = r.hdr ? `hdr rgba16float${r.bloomMips > 0 ? ` · bloom ${r.bloomMips} mips` : ""}` : "ldr direct";
    const shadows = r.shadowCascades > 0 ? `csm ${r.shadowCascades}x (${r.shadowsDrawn} draws, ${r.shadowsCulled} culled)` : "shadows off";
    const sky = r.sky ? `sky ${r.skySamples} spp` : "sky off";
    hud.textContent =
      `scene [${activeSceneName.toUpperCase()}]  frame ${st.frame}  fps ${st.fps.toFixed(1)}\n` +
      `draws ${st.drawCalls}  tris ${st.triangles}  instances ${st.instances}\n` +
      `sim ${st.simTimeMs.toFixed(2)}ms  render ${st.renderTimeMs.toFixed(2)}ms\n` +
      `${path}  ·  ${shadows}  ·  ${sky}\n` +
      `graph ${r.passes} passes (${r.culledPasses} culled)  ${r.transientTextures} transients → ${r.physicalTextures} textures\n` +
      `${where}  ${canvas.width}x${canvas.height}  ${health}`;
    const extra = currentHandle?.overlay?.();
    if (extra) hud.textContent += `\n${extra}`;

    if (st.lastError && st.lastError !== shownError) {
      firstError ??= st.lastError;
      shownError = st.lastError;
      const latest = st.lastError === firstError ? "" : `\n\nlatest:\n${st.lastError}`;
      showError(`GPU errors: ${st.gpuErrors}\n\nfirst:\n${firstError}${latest}`);
    }

    requestAnimationFrame(frameLoop);
  };
  requestAnimationFrame(frameLoop);

  // Interface for browser check and dev tooling
  (window as unknown as { __forge: Record<string, unknown> }).__forge = {
    backend: (engine.gpu as unknown as { caps?: { backend?: string } }).caps?.backend ?? "webgpu",
    stats: () => engine.stats(),
    get scene(): Scene {
      return currentHandle!.scene;
    },
    engine,
    loadScene,
    setToneMapping,
    setHdr,
    setBloom,
    setShadows,
    setCascadeDebug,
    setAnimating: (on: boolean) => {
      animating = on;
    },
    /** Pass names the render graph executed last frame (what the gate asserts against). */
    renderPasses: () => engine.stats().renderPasses,
    /** Camera eye / orbit target / distance — the browser gate asserts zoom & pan against this. */
    camera: () => controls?.state() ?? null,
    /** Chassis speed/rpm while the vehicle playground is loaded; null otherwise. */
    vehicleState: () => currentHandle?.vehicleState?.() ?? null,
    /** Fountain counts while the particle scene is loaded; null otherwise. */
    particleState: () => currentHandle?.particleState?.() ?? null,
    /** Sky scene: scrub the day/night clock (hours) and read the sun back; null on other scenes. */
    setTimeOfDay: (hours: number) => {
      const handle = currentHandle as SkySceneHandle | null;
      handle?.setTimeOfDay?.(hours);
    },
    setPlanet: (planet: "earth" | "mars") => {
      const handle = currentHandle as SkySceneHandle | null;
      handle?.setPlanet?.(planet);
    },
    setSky: (on: boolean) => {
      const scene = currentHandle?.scene;
      if (!scene) return;
      if (on) scene.setSky();
      else scene.settings.skyEnabled = false;
    },
    /** Weather scene: snap + hold a preset; null on other scenes. */
    setWeather: (preset: "clear" | "overcast" | "rain" | "storm") => {
      const handle = currentHandle as WeatherSceneHandle | null;
      handle?.setWeather?.(preset);
    },
    /** Weather scene: pin the deck coverage (0..1) without changing the weather. */
    setCoverage: (coverage: number) => {
      const handle = currentHandle as WeatherSceneHandle | null;
      handle?.setCoverage?.(coverage);
    },
    /** Weather scene: schedule a strike now; returns the strike count. */
    triggerLightning: () => {
      const handle = currentHandle as WeatherSceneHandle | null;
      handle?.triggerLightning?.();
      return handle?.lightning.strikeCount ?? 0;
    },
    /** Weather scene: flood the camera (true) or drain the lake (false). */
    setUnderwater: (on: boolean) => {
      const handle = currentHandle as WeatherSceneHandle | null;
      handle?.setUnderwater?.(on);
    },
    /** Weather scene: live weather/water/lightning state; null on other scenes. */
    weatherState: () => {
      const handle = currentHandle as WeatherSceneHandle | null;
      if (!handle?.weather) return null;
      const s = handle.scene.settings;
      return {
        windSpeed: handle.weather.state.windSpeed,
        temperatureC: handle.weather.state.temperatureC,
        precipitation: handle.weather.state.precipitation01,
        storm: handle.weather.state.storm01,
        coverage: s.clouds.coverage,
        deckWind: [s.clouds.windX, s.clouds.windZ],
        waterTime: s.water.time,
        waterLevel: s.water.level,
        strikes: handle.lightning.strikeCount,
        flash: handle.lightning.flashTotal,
        underwater: engine.stats().render.underwater,
        clouds: engine.stats().render.clouds,
      };
    },
    environmentState: () => {
      const cycle = currentHandle?.scene.object<DayNightCycle>("dayNight");
      if (!cycle) return null;
      const s = currentHandle!.scene.settings;
      return {
        time: cycle.timeOfDay,
        elevationDeg: cycle.elevationDeg,
        azimuthDeg: cycle.azimuthDeg,
        isDay: cycle.isDay,
        lightIntensity: cycle.sunLightIntensity,
        ambient: [s.ambientColor.r, s.ambientColor.g, s.ambientColor.b],
        fog: [s.fog.color.r, s.fog.color.g, s.fog.color.b],
        skyEnabled: s.skyEnabled,
        sky: engine.stats().render.sky,
      };
    },
    /**
     * Analytic gravity check on this page's GPUDevice. The mock device records the dispatch and
     * returns `gpuExecuted: false`; a real adapter that ran the compute shader returns true.
     */
    runParticleGravityCheck: (options?: ParticleGravityCheckOptions) => runParticleGravityCheck(engine.gpu.device, options ?? {}),
    /** Terrain surface height at a world XZ (null outside the terrain demo). */
    terrainHeightAt: (x: number, z: number) => {
      const terrain = currentHandle?.scene.object<TerrainWorld>("TerrainWorld");
      return terrain ? terrain.getHeightAt(x, z) : null;
    },
    dispose: () => {
      engine.stop();
      currentHandle?.dispose?.();
      engine.dispose();
    },
    resize: (w: number, h: number) => {
      canvas.width = Math.floor(w);
      canvas.height = Math.floor(h);
    },
  };
}

main().catch((error: unknown) => {
  showError(error instanceof Error ? (error.stack ?? error.message) : String(error));
  hud.textContent = "engine failed to start";
  (window as unknown as { __forgeError: string }).__forgeError = String(error instanceof Error ? error.message : error);
});
