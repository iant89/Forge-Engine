/**
 * Forge Engine — Interactive Demo & Verification Host.
 *
 * Supports:
 * - Phase 1: Spinning Cubes Demo.
 * - Phase 2: PBR Showcase Demo (Metallic x Roughness, Normal maps, Point/Spot/Sun lights, Emissive)
 *   rendered through the Phase 2 frame: cascaded shadow maps, HDR target, bloom, tone-map resolve.
 * - Orbit camera controls (mouse drag, wheel zoom, pan, touch pinch); each scene supplies its own
 *   framing, zoom range and (terrain) the surface the camera must stay above.
 * - Real-time statistics HUD (including the render-graph pass list), tone-mapping switcher and
 *   rendering toggles (HDR, bloom, shadows, cascade tint).
 * - `window.__forge` interface for automated headless verification (`npm run check:browser`): the
 *   gate flips the toggles and reads pixels back, so every switch here must be reachable from it.
 */
import {
  Engine,
  detectPlatform,
  type Scene,
  type ToneMapping,
  type TerrainWorld,
} from "@forge/engine";
import { OrbitControls } from "./controls/orbitControls.js";
import { buildCubesScene, type DemoSceneHandle } from "./scenes/cubesScene.js";
import { buildPbrScene } from "./scenes/pbrScene.js";
import { buildTerrainScene } from "./scenes/terrainScene.js";
import { buildRealisticTerrainScene } from "./scenes/realisticTerrainScene.js";

const canvas = document.getElementById("view") as HTMLCanvasElement;
const hud = document.getElementById("hud") as HTMLDivElement;
const errorBox = document.getElementById("error") as HTMLDivElement;

const btnScenePbr = document.getElementById("btn-scene-pbr") as HTMLButtonElement | null;
const btnSceneCubes = document.getElementById("btn-scene-cubes") as HTMLButtonElement | null;
const btnSceneTerrain = document.getElementById("btn-scene-terrain") as HTMLButtonElement | null;
const btnSceneRealistic = document.getElementById("btn-scene-realistic") as HTMLButtonElement | null;
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

  // Check query parameter (?scene=cubes, ?scene=pbr, ?scene=terrain, ?scene=realistic)
  const params = new URLSearchParams(window.location.search);
  const requestedScene = params.get("scene");
  if (requestedScene === "cubes") {
    activeSceneName = "cubes";
  } else if (requestedScene === "terrain") {
    activeSceneName = "terrain";
  } else if (requestedScene === "realistic" || requestedScene === "realistic-terrain") {
    activeSceneName = "realistic";
  }

  type SceneName = "pbr" | "cubes" | "terrain" | "realistic";

  function loadScene(name: SceneName): void {
    if (currentHandle) {
      currentHandle.dispose?.();
    }
    // Drop the previous controller with its scene: an undisposed one keeps orbiting the old camera
    // (and re-applying every wheel event) for the lifetime of the page.
    controls?.dispose();
    controls = null;

    activeSceneName = name;
    btnScenePbr?.classList.toggle("active", name === "pbr");
    btnSceneCubes?.classList.toggle("active", name === "cubes");
    btnSceneTerrain?.classList.toggle("active", name === "terrain");
    btnSceneRealistic?.classList.toggle("active", name === "realistic");

    if (name === "pbr") {
      currentHandle = buildPbrScene(engine);
    } else if (name === "terrain") {
      currentHandle = buildTerrainScene(engine);
    } else if (name === "realistic") {
      currentHandle = buildRealisticTerrainScene(engine, { preset: "alpine" });
    } else {
      currentHandle = buildCubesScene(engine);
    }

    engine.setScene(currentHandle.scene);
    // Scene modules own their camera policy (starting framing, zoom range, surface constraint).
    controls = new OrbitControls(currentHandle.cameraEntity, canvas).configure(currentHandle.camera ?? {});
  }

  loadScene(activeSceneName as SceneName);
  engine.start();

  // Toolbar event listeners
  btnScenePbr?.addEventListener("click", () => loadScene("pbr"));
  btnSceneCubes?.addEventListener("click", () => loadScene("cubes"));
  btnSceneTerrain?.addEventListener("click", () => loadScene("terrain"));
  btnSceneRealistic?.addEventListener("click", () => loadScene("realistic"));

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
    }
    // Recomputed every frame so the surface constraint tracks terrain that streams in under a
    // stationary camera; it is a few trig ops plus (on the terrain scene) two height samples.
    controls?.update();

    const st = engine.stats();
    const health = st.deviceLost ? "DEVICE LOST" : st.gpuErrors > 0 ? `gpu errors ${st.gpuErrors}` : "gpu ok";
    const r = st.render;
    const path = r.hdr ? `hdr rgba16float${r.bloomMips > 0 ? ` · bloom ${r.bloomMips} mips` : ""}` : "ldr direct";
    const shadows = r.shadowCascades > 0 ? `csm ${r.shadowCascades}x (${r.shadowsDrawn} draws, ${r.shadowsCulled} culled)` : "shadows off";
    hud.textContent =
      `scene [${activeSceneName.toUpperCase()}]  frame ${st.frame}  fps ${st.fps.toFixed(1)}\n` +
      `draws ${st.drawCalls}  tris ${st.triangles}  instances ${st.instances}\n` +
      `sim ${st.simTimeMs.toFixed(2)}ms  render ${st.renderTimeMs.toFixed(2)}ms\n` +
      `${path}  ·  ${shadows}\n` +
      `graph ${r.passes} passes (${r.culledPasses} culled)  ${r.transientTextures} transients → ${r.physicalTextures} textures\n` +
      `${where}  ${canvas.width}x${canvas.height}  ${health}`;

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
