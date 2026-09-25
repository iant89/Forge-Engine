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
 *   rendering toggles (HDR, bloom, shadows, depth prepass, SSAO, cascade tint, debug bounds).
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
  type Entity,
  detectPlatform,
  Light,
  runParticleGravityCheck,
  type ParticleGravityCheckOptions,
  type Scene,
  type ToneMapping,
  type TerrainWorld,
  Vec3,
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
const btnPrepass = document.getElementById("btn-prepass") as HTMLButtonElement | null;
const btnSsao = document.getElementById("btn-ssao") as HTMLButtonElement | null;
const btnClustered = document.getElementById("btn-clustered") as HTMLButtonElement | null;
const btnStress = document.getElementById("btn-stress") as HTMLButtonElement | null;
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
  /** Entities the many-light rig added to the current scene (Phase 13.3); dropped on scene switch. */
  let stressLamps: Entity[] = [];
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
    btnPrepass?.classList.toggle("active", settings.depthPrepass);
    btnSsao?.classList.toggle("active", settings.ssao.enabled);
    if (btnSsao) btnSsao.disabled = !settings.depthPrepass;
    btnClustered?.classList.toggle("active", settings.clusteredLighting);
    // The rig's lamps belonged to the scene that was just replaced.
    stressLamps = [];
    btnStress?.classList.remove("active");
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
  // `?lightculling=cpu|gpu` pins the cluster fill for shareable A/B links (`auto` is the startup value).
  const cullingParam = new URLSearchParams(window.location.search).get("lightculling");
  if (cullingParam === "cpu" || cullingParam === "gpu") engine.renderer.lightCulling = cullingParam;
  // `?objectculling=cpu|gpu` and `?occlusionculling=0|1` do the same for the batch culler (Phase 13.5).
  const objectCullingParam = new URLSearchParams(window.location.search).get("objectculling");
  if (objectCullingParam === "cpu" || objectCullingParam === "gpu") engine.renderer.objectCulling = objectCullingParam;
  const occlusionParam = new URLSearchParams(window.location.search).get("occlusionculling");
  if (occlusionParam === "0" || occlusionParam === "1") engine.renderer.occlusionCulling = occlusionParam === "1";

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
    btnPrepass?.classList.toggle("active", s.depthPrepass);
    btnSsao?.classList.toggle("active", s.ssao.enabled);
    // SSAO reads the prepass depth: without the prepass there is nothing for it to do.
    if (btnSsao) btnSsao.disabled = !s.depthPrepass;
    btnCascades?.classList.toggle("active", s.shadow.debugCascades);
    if (btnCascades) btnCascades.disabled = !s.shadow.enabled;
    btnClustered?.classList.toggle("active", s.clusteredLighting);
    btnStress?.classList.toggle("active", stressLamps.length > 0);
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
  function setDepthPrepass(on: boolean): void {
    if (!currentHandle) return;
    currentHandle.scene.settings.depthPrepass = on;
    syncRenderButtons();
  }
  function setSsao(on: boolean): void {
    if (!currentHandle) return;
    currentHandle.scene.settings.ssao.enabled = on;
    syncRenderButtons();
  }
  function setClusteredLighting(on: boolean): void {
    if (!currentHandle) return;
    currentHandle.scene.settings.clusteredLighting = on;
    syncRenderButtons();
  }
  /**
   * Which half of the cluster grid build runs on the device (Phase 13.4). Same grid either way, so
   * flipping it while the demo runs is a valid A/B: the picture must not move. `auto` (the startup
   * value) fills on the GPU on a real device and on the CPU when there is no WebGPU device to fill it.
   */
  function setLightCulling(mode: "auto" | "cpu" | "gpu"): void {
    engine.renderer.lightCulling = mode;
    syncRenderButtons();
  }
  /**
   * Where batch visibility is decided (Phase 13.5): `forge.objects.cull` on the device, or the CPU
   * twin. Both write the same visibility buffer the vertex stage reads, so the picture must not move —
   * that is what the A/B in `tools/browser-check.mjs` asserts. `auto` (the startup value) picks the
   * device path on a real device and the twin on a mock one.
   */
  function setObjectCulling(mode: "auto" | "cpu" | "gpu"): void {
    engine.renderer.objectCulling = mode;
    syncRenderButtons();
  }
  /** The HiZ stage of the object culler (Phase 13.5): conservative, so turning it off may add draws. */
  function setOcclusionCulling(on: boolean): void {
    engine.renderer.occlusionCulling = on;
    syncRenderButtons();
  }
  /**
   * Many-light rig (Phase 13.3): `count` static point lamps over the active scene, so the demo — and
   * the browser gate — can drive more lights than the old fixed 16-entry uniform list could carry.
   * Static on purpose: with the loop frozen the frame is bit-reproducible, which is what the
   * clustering pixel A/B in `tools/browser-check.mjs` needs. Pass 0 to take them back out.
   *
   * `tight` stacks them into one small ball instead of spreading them over a grid. Every lamp then
   * lands in the same cluster, the cluster's candidate count goes past the 32-per-cluster cap, and the
   * fill has to evict — the one code path the spread-out rig never reaches. It is also what makes the
   * GPU fill's eviction rule checkable on a real device: both fills must keep the same 32 lamps, and a
   * different tie-break or ordering would change which small pools of light are on the ground. The
   * intensities are distinct on purpose, so "the same 32" is not a matter of taste.
   */
  function setStressLights(count: number, tight = false): void {
    const scene = currentHandle?.scene;
    if (!scene) return;
    for (const lamp of stressLamps) scene.destroyEntity(lamp);
    stressLamps = [];
    const wanted = Math.max(0, Math.floor(count));
    const side = Math.max(1, Math.ceil(Math.sqrt(wanted)));
    const stepX = 10 / Math.max(1, side - 1);
    const stepZ = 8 / Math.max(1, side - 1);
    for (let i = 0; i < wanted; i++) {
      const x = tight ? 0.06 * Math.cos(i * 2.4) : ((i % side) - (side - 1) / 2) * stepX;
      const z = tight ? 0.06 * Math.sin(i * 2.4) : (Math.floor(i / side) - (side - 1) / 2) * stepZ;
      // Low and tight on purpose: a 1.8 m pool of light on the ground reads clearly on camera and
      // covers a handful of clusters, so the spread rig demonstrates "many lights", not "many lights
      // all in the same cluster" (which is what the 32-per-cluster cap is for — and what the stacked
      // rig is for). The stacked lamps are dimmer and shorter-ranged so that 32 of them do not blow
      // the tone mapper out to white, which would hide which 32 they are.
      const entity = scene.createTransformedEntity(`stress-lamp-${i}`, new Vec3(x, tight ? 0.55 : 0.75 + (i % 3) * 0.45, z));
      const lamp = new Light();
      lamp.kind = "point";
      lamp.range = tight ? 1.2 : 1.8;
      lamp.intensity = tight ? 0.9 + 0.35 * (i % 7) : 11;
      lamp.castShadow = false;
      // Spread the hues so the grid reads as separate lamps rather than one wash of white.
      const t = (i / Math.max(1, wanted - 1)) * Math.PI * 2;
      lamp.setColor(0.6 + 0.4 * Math.sin(t), 0.6 + 0.4 * Math.sin(t + 2.09), 0.6 + 0.4 * Math.sin(t + 4.19));
      scene.world.addComponent(entity.id, lamp);
      stressLamps.push(entity);
    }
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
  btnPrepass?.addEventListener("click", () => setDepthPrepass(!currentHandle?.scene.settings.depthPrepass));
  btnSsao?.addEventListener("click", () => setSsao(!currentHandle?.scene.settings.ssao.enabled));
  btnClustered?.addEventListener("click", () => setClusteredLighting(!currentHandle?.scene.settings.clusteredLighting));
  btnStress?.addEventListener("click", () => setStressLights(stressLamps.length > 0 ? 0 : 36));
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
    const depth = r.depthPrepass ? `prepass ${r.prepassDraws} draws  ·  ${r.ssao ? "ssao half-res" : "ssao off"}` : "no prepass  ·  ssao off";
    // The device path's counters arrive one frame late (a readback cannot be known sooner), so the
    // first frames after a switch read zero tested while the words are already being written.
    const cull =
      `${engine.renderer.objectCulling} cull${engine.renderer.occlusionCulling && engine.renderer.objectCulling === "gpu" ? "+hiz" : ""}` +
      (r.cullTested > 0 ? ` ${r.cullTested} tested (${r.cullFrustum} off-screen, ${r.cullDistance} distant, ${r.cullOccluded} occluded)` : " (counters pending)");
    const fill = r.clusterFill === "gpu" ? "gpu fill" : r.clusterFill === "cpu" ? "cpu fill" : "";
    const lights = r.clusteredLighting
      ? `lights ${r.lights}  ·  clustered ${r.clusteredLights} over ${r.clustersUsed} clusters (${r.clusterIndices} indices, cap ${r.maxLightsPerCluster}, ${fill})${r.lightsDropped ? "  ·  DROPPED" : ""}`
      : `lights ${r.lights} in the fixed uniform list${r.lightsDropped ? "  ·  DROPPED" : ""}`;
    const aliased = r.aliasedBytes > 0 ? `  (${(r.aliasedBytes / 1024).toFixed(0)} KiB aliased)` : "";
    hud.textContent =
      `scene [${activeSceneName.toUpperCase()}]  frame ${st.frame}  fps ${st.fps.toFixed(1)}\n` +
      `draws ${st.drawCalls}  tris ${st.triangles}  instances ${st.instances}\n` +
      `sim ${st.simTimeMs.toFixed(2)}ms  render ${st.renderTimeMs.toFixed(2)}ms\n` +
      `${path}  ·  ${shadows}  ·  ${sky}\n` +
      `${depth}  ·  ${cull}\n` +
      `${lights}\n` +
      `graph ${r.passes} passes (${r.culledPasses} culled)  ${r.transientTextures} transients → ${r.physicalTextures} textures${aliased}\n` +
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
    setDepthPrepass,
    setSsao,
    setClusteredLighting,
    /** Whether the active scene shades its local lights through the cluster grid. */
    clusteredLighting: () => !!currentHandle?.scene.settings.clusteredLighting,
    setLightCulling,
    /** Which half of the cluster grid build the renderer runs on the device (Phase 13.4). */
    lightCulling: () => engine.renderer.lightCulling,
    setObjectCulling,
    /** Who decides batch visibility (Phase 13.5): "gpu" runs forge.objects.cull, "cpu" the twin. */
    objectCulling: () => engine.renderer.objectCulling,
    setOcclusionCulling,
    /** Whether the object culler's HiZ stage runs (Phase 13.5). */
    occlusionCulling: () => engine.renderer.occlusionCulling,
    setStressLights,
    /** How many rig lamps are in the scene right now (0 when the rig is off). */
    stressLights: () => stressLamps.length,
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
