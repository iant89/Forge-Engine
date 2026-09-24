/**
 * Forge Engine — Interactive Demo & Verification Host.
 *
 * Supports:
 * - Phase 1: Spinning Cubes Demo.
 * - Phase 2: PBR Showcase Demo (Metallic x Roughness, Normal maps, Point/Spot/Sun lights, Emissive)
 *   rendered through the Phase 2 frame: cascaded shadow maps, HDR target, bloom, tone-map resolve.
 * - Phase 6: vehicle playground. Input is written in the scene `update`; `VehicleSystem` is the only stepper.
 * - Phase 12: GPU particle fountain via `GpuParticleWorld` (billboard/soft `drawIndirect` path; do not also attach CPU `ParticleSystem`/`ParticleWorld` to the same GPU sim).
 * - Phase 8a: sky / day-night scene — `DayNightCycle` drives the sun, ambient, fog and the
 *   `forge.sky` pass; `[`/`]` scrub the clock, `M` swaps Earth for Mars.
 * - Orbit camera controls (mouse drag, wheel zoom, pan, touch pinch); each scene supplies its own
 *   framing, zoom range and (terrain) the surface the camera must stay above.
 * - On-screen buttons for every demo whose actions used to need keys: the sky clock/planet panel
 *   and the weather preset/action buttons are the interface on all devices (CSS shows them whenever
 *   their scene is up); the vehicle stick/pads stay touch-only because that demo keeps its keyboard
 *   controls. The modules always bind the same actions as the keys, so there is one path per action
 *   either way.
 * - Real-time statistics HUD (including the render-graph pass list), tone-mapping switcher and
 *   rendering toggles (HDR, bloom, shadows, cascade tint, debug bounds).
 * - Mars showcase loading screen: live GLB fetch/parse/build progress plus terrain streaming
 *   state, fading out when both are live, with Retry / Continue when the fetch fails. The
 *   `Bounds` toggle (`?bounds=1`) draws wireframe AABBs where every renderable — and the rover —
 *   is supposed to be, for diagnosing invisible-model reports.
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
import { buildMarsShowcaseScene, type MarsShowcaseSceneHandle } from "./scenes/marsShowcaseScene.js";
import { resolveDemoSceneName, type DemoSceneName } from "./sceneSelection.js";
import type { DiagForge } from "./diag/iosReport.js";
import { attachToolbarMenu } from "./controls/toolbarMenu.js";

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
const btnBounds = document.getElementById("btn-bounds") as HTMLButtonElement | null;
const loadingOverlay = document.getElementById("loading") as HTMLDivElement | null;
const loadingModel = document.getElementById("loading-model") as HTMLDivElement | null;
const loadingTerrain = document.getElementById("loading-terrain") as HTMLDivElement | null;
const loadingBarFill = document.getElementById("loading-bar-fill") as HTMLDivElement | null;
const loadingActions = document.getElementById("loading-actions") as HTMLDivElement | null;
const loadingRetry = document.getElementById("loading-retry") as HTMLButtonElement | null;
const loadingContinue = document.getElementById("loading-continue") as HTMLButtonElement | null;

function showError(text: string): void {
  errorBox.style.display = "block";
  errorBox.textContent = text;
}

async function main(): Promise<void> {
  const platform = detectPlatform();
  const engine = await Engine.create({ canvas, quality: "high", logLevel: "info", config: { workerCount: 2 } });
  const where = `${platform.browser}/${platform.os}  ${engine.gpu.format}  dpr ${Math.min(platform.devicePixelRatio, 2).toFixed(2)}`;

  // DEMO SCENE / TONE MAPPING / RENDERING start collapsed behind the hamburger so a phone-sized
  // Mars Showcase is not buried under three panels; panels stay in the DOM for `__forge`/gates.
  const toolbarMenu = attachToolbarMenu({
    toolbar: document.getElementById("toolbar"),
    toggle: document.getElementById("toolbar-toggle"),
  });

  let currentHandle: DemoSceneHandle | null = null;
  let controls: OrbitControls | null = null;
  /** Renderer AABB overlay ("Bounds" toolbar button / `?bounds=1`); separate from the scene's auto boxes. */
  let boundsOn = false;
  /** Set once the Mars loading screen has been dismissed (model ready, or the user skipped it). */
  let loadingDismissed = false;
  let lastLoadingSync = 0;
  // Open on the rover in its terrain showcase; the other scenes remain one selection away, and a
  // `?scene=...` query string can still deep-link to any of them.
  const requestedScene = new URLSearchParams(window.location.search).get("scene");
  let activeSceneName: DemoSceneName = resolveDemoSceneName(requestedScene);

  function loadScene(name: DemoSceneName): void {
    if (currentHandle) {
      currentHandle.dispose?.();
    }
    // Drop the previous controller with its scene: an undisposed one keeps orbiting the old camera
    // (and re-applying every wheel event) for the lifetime of the page.
    controls?.dispose();
    controls = null;

    activeSceneName = name;
    // The sky and weather buttons are the interface for their scenes on every device, shown by CSS
    // on `body.scene-sky` / `body.scene-weather`; the vehicle pad stays touch-only on
    // `body.scene-vehicle` (shared with the Mars showcase's rover controls). Each module binds the
    // same paths as the keys, whichever is visible.
    document.body.classList.toggle("scene-vehicle", name === "vehicle" || name === "mars-showcase");
    document.body.classList.toggle("scene-mars", name === "mars-showcase");
    document.body.classList.toggle("scene-sky", name === "sky");
    document.body.classList.toggle("scene-weather", name === "weather");
    if (sceneSelect && sceneSelect.value !== name) sceneSelect.value = name;

    // The loading screen belongs to the Mars showcase (model fetch + terrain warm-up); every
    // other scene hides it. Re-entering the showcase restarts the overlay with its own load.
    if (name === "mars-showcase") {
      loadingDismissed = false;
      lastLoadingSync = 0;
      loadingOverlay?.classList.remove("done");
      loadingOverlay?.removeAttribute("hidden");
      loadingActions?.setAttribute("hidden", "");
      loadingModel?.classList.remove("error");
    } else {
      loadingOverlay?.setAttribute("hidden", "");
    }

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
    } else if (name === "mars-showcase") {
      currentHandle = buildMarsShowcaseScene(engine);
      if (boundsOn) (currentHandle as MarsShowcaseSceneHandle).setDebugBounds("on");
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
    // Pass the setup into the constructor so the first pose is the scene's, not the defaults.
    controls = new OrbitControls(currentHandle.cameraEntity, canvas, currentHandle.camera ?? {});
  }

  loadScene(activeSceneName);
  engine.start();

  // Debug bounds: the renderer draws every renderable's AABB (culled ones included) and the Mars
  // scene forces its rover footprint boxes on. `?bounds=1` pre-enables for shareable debug links.
  function setBounds(on: boolean): void {
    boundsOn = on;
    engine.renderer.debugBounds = on;
    (currentHandle as MarsShowcaseSceneHandle | null)?.setDebugBounds?.(on ? "on" : "off");
    btnBounds?.classList.toggle("active", on);
  }
  btnBounds?.addEventListener("click", () => setBounds(!boundsOn));
  if (new URLSearchParams(window.location.search).get("bounds") === "1") setBounds(true);

  // Loading screen: the overlay tracks the GLB fetch/parse/build phases and the terrain stream,
  // fades out once both are live, and offers retry / skip when the fetch fails.
  const hideLoading = (): void => {
    loadingDismissed = true;
    loadingOverlay?.classList.add("done");
    window.setTimeout(() => loadingOverlay?.setAttribute("hidden", ""), 600);
  };
  const mb = (bytes: number): string => (bytes / 1048576).toFixed(1);
  function updateLoadingOverlay(now: number): void {
    if (activeSceneName !== "mars-showcase" || loadingDismissed || now - lastLoadingSync < 200) return;
    lastLoadingSync = now;
    const mars = (currentHandle as MarsShowcaseSceneHandle | null)?.marsState?.();
    if (!mars || !loadingOverlay) return;
    if (mars.modelError) {
      loadingModel?.classList.add("error");
      if (loadingModel) loadingModel.textContent = `model: FAILED — ${mars.modelError}`;
      loadingActions?.removeAttribute("hidden");
      loadingBarFill?.classList.remove("indeterminate");
    } else {
      loadingModel?.classList.remove("error");
      loadingActions?.setAttribute("hidden", "");
      const p = mars.modelProgress;
      if (loadingModel) {
        if (mars.modelLoaded) loadingModel.textContent = "model: loaded";
        else if (p?.phase === "fetch")
          loadingModel.textContent = p.totalBytes ? `model: downloading ${mb(p.receivedBytes)} / ${mb(p.totalBytes)} MB` : `model: downloading ${mb(p.receivedBytes)} MB…`;
        else if (p?.phase === "parse") loadingModel.textContent = "model: parsing GLB…";
        else loadingModel.textContent = "model: building geometry…";
      }
      if (loadingBarFill) {
        if (mars.modelLoaded) {
          loadingBarFill.classList.remove("indeterminate");
          loadingBarFill.style.width = "100%";
        } else if (p?.phase === "fetch" && p.totalBytes) {
          loadingBarFill.classList.remove("indeterminate");
          loadingBarFill.style.width = `${Math.min(100, (p.receivedBytes / p.totalBytes) * 100).toFixed(1)}%`;
        } else {
          loadingBarFill.classList.add("indeterminate");
        }
      }
    }
    if (loadingTerrain) loadingTerrain.textContent = `terrain: ${mars.terrainChunks} chunks · ${mb(mars.terrainResidentBytes)} MB resident`;
    if (mars.modelLoaded && mars.terrainResidentBytes > 0) hideLoading();
  }
  loadingRetry?.addEventListener("click", () => {
    (currentHandle as MarsShowcaseSceneHandle | null)?.retryModelLoad?.();
    loadingActions?.setAttribute("hidden", "");
    loadingModel?.classList.remove("error");
  });
  loadingContinue?.addEventListener("click", hideLoading);

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
      next === "weather" ||
      next === "mars-showcase"
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
    updateLoadingOverlay(now);
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
    /** Current demo selection, exposed for browser verification and local tooling. */
    get sceneName(): string {
      return activeSceneName;
    },
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
    /** Debug AABB overlay: renderer-wide renderable bounds + the Mars rover footprint boxes. */
    setDebugBounds: (on: boolean) => setBounds(!!on),
    debugBounds: () => boundsOn,
    /** Mars showcase: re-run the GLB fetch (the loading screen's Retry button). */
    retryModelLoad: () => {
      (currentHandle as MarsShowcaseSceneHandle | null)?.retryModelLoad?.();
    },
    setAnimating: (on: boolean) => {
      animating = on;
    },
    /** Whether the demo loop is running its scene `update`. A gate that drives input must check it. */
    animating: () => animating,
    /** Pass names the render graph executed last frame (what the gate asserts against). */
    renderPasses: () => engine.stats().renderPasses,
    /** Camera eye / orbit target / distance — the browser gate asserts zoom & pan against this. */
    camera: () => controls?.state() ?? null,
    /** Chassis speed/rpm while the vehicle playground is loaded; null otherwise. */
    vehicleState: () => currentHandle?.vehicleState?.() ?? null,
    /** Fountain emitted/capacity/ready while the particle scene is loaded; null otherwise (no fake alive). */
    particleState: () => currentHandle?.particleState?.() ?? null,
    /** Mars showcase: rover model state, dust counts and pose; null on other scenes. */
    marsState: () => {
      const handle = currentHandle as MarsShowcaseSceneHandle | null;
      return handle?.marsState?.() ?? null;
    },
    /** Mars showcase: raise (true) or stow (false) the camera mast; null on other scenes. */
    setMast: (deployed: boolean) => {
      const handle = currentHandle as MarsShowcaseSceneHandle | null;
      handle?.setMast?.(deployed);
    },
    /** Mars showcase: unfold (true) or stow (false) the robotic arm; a no-op on other scenes. */
    setArm: (deployed: boolean) => {
      const handle = currentHandle as MarsShowcaseSceneHandle | null;
      handle?.setArm?.(deployed);
    },
    /** Sky scene: scrub the day/night clock (hours) and read the sun back; null on other scenes. */
    setTimeOfDay: (hours: number) => {
      const handle = currentHandle as SkySceneHandle | null;
      handle?.setTimeOfDay?.(hours);
    },
    setPlanet: (planet: "earth" | "mars") => {
      const handle = currentHandle as SkySceneHandle | null;
      handle?.setPlanet?.(planet);
    },
    /** Sky scene: the planet the panel/keys currently have active; null on other scenes. */
    skyPlanet: () => {
      const handle = currentHandle as SkySceneHandle | null;
      return handle?.planetState?.() ?? null;
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
        rainDrops: handle.rainDrops?.() ?? 0,
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
        timeScale: cycle.timeScale,
        paused: cycle.timeScale === 0,
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
    /** Toolbar hamburger: open/close the DEMO SCENE / TONE MAPPING / RENDERING panels. */
    toolbarMenu: {
      isOpen: () => toolbarMenu.isOpen(),
      open: () => toolbarMenu.open(),
      close: () => toolbarMenu.close(),
      toggle: () => toolbarMenu.toggle(),
    },
    dispose: () => {
      toolbarMenu.dispose();
      engine.stop();
      currentHandle?.dispose?.();
      engine.dispose();
    },
    resize: (w: number, h: number) => {
      canvas.width = Math.floor(w);
      canvas.height = Math.floor(h);
    },
  };

  // Device-side diagnostics: `?diag=1`, or any host that injects `window.__forgeDiagEndpoint`
  // (the sandbox dev server does; `npm run demo` does not). Loaded on demand so the normal demo
  // path carries none of it — see src/diag/iosReport.ts for what the panel measures and why.
  const diagParams = new URLSearchParams(window.location.search);
  const diagEndpoint = (window as unknown as { __forgeDiagEndpoint?: string }).__forgeDiagEndpoint;
  if (diagParams.get("diag") === "1" || diagEndpoint) {
    void import("./diag/iosReport.js").then((mod) => {
      mod.installIosReport(
        {
          canvas,
          forge: (window as unknown as { __forge: DiagForge }).__forge,
          gpu: engine.gpu as unknown,
          platform: engine.platform as unknown,
        },
        { tag: activeSceneName, toggles: diagParams.get("diagToggles") !== "0" },
      );
    });
  }
}

main().catch((error: unknown) => {
  showError(error instanceof Error ? (error.stack ?? error.message) : String(error));
  hud.textContent = "engine failed to start";
  (window as unknown as { __forgeError: string }).__forgeError = String(error instanceof Error ? error.message : error);
});
