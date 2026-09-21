/**
 * Forge Engine — Interactive Demo & Verification Host.
 *
 * Supports:
 * - Phase 1: Spinning Cubes Demo.
 * - Phase 2: PBR Showcase Demo (Metallic x Roughness, Normal maps, Point/Spot/Sun lights, Emissive).
 * - Orbit camera controls (mouse drag, wheel zoom, touch).
 * - Real-time statistics HUD & Tone Mapping switcher.
 * - `window.__forge` interface for automated headless verification (`npm run check:browser`).
 */
import {
  Engine,
  detectPlatform,
  type Scene,
  type ToneMapping,
} from "@forge/engine";
import { OrbitControls } from "./controls/orbitControls.js";
import { buildCubesScene, type DemoSceneHandle } from "./scenes/cubesScene.js";
import { buildPbrScene } from "./scenes/pbrScene.js";

const canvas = document.getElementById("view") as HTMLCanvasElement;
const hud = document.getElementById("hud") as HTMLDivElement;
const errorBox = document.getElementById("error") as HTMLDivElement;

const btnScenePbr = document.getElementById("btn-scene-pbr") as HTMLButtonElement | null;
const btnSceneCubes = document.getElementById("btn-scene-cubes") as HTMLButtonElement | null;
const btnTmAces = document.getElementById("btn-tm-aces") as HTMLButtonElement | null;
const btnTmReinhard = document.getElementById("btn-tm-reinhard") as HTMLButtonElement | null;
const btnTmNone = document.getElementById("btn-tm-none") as HTMLButtonElement | null;

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

  // Check query parameter (?scene=cubes or ?scene=pbr)
  const params = new URLSearchParams(window.location.search);
  const requestedScene = params.get("scene");
  if (requestedScene === "cubes") {
    activeSceneName = "cubes";
  }

  function loadScene(name: "pbr" | "cubes"): void {
    if (currentHandle) {
      currentHandle.dispose?.();
    }

    activeSceneName = name;
    if (name === "pbr") {
      currentHandle = buildPbrScene(engine);
      btnScenePbr?.classList.add("active");
      btnSceneCubes?.classList.remove("active");
    } else {
      currentHandle = buildCubesScene(engine);
      btnSceneCubes?.classList.add("active");
      btnScenePbr?.classList.remove("active");
    }

    engine.setScene(currentHandle.scene);
    controls = new OrbitControls(currentHandle.cameraEntity, canvas);

    if (name === "pbr") {
      controls.target.set(0, 1.0, 0);
      controls.distance = 12.0;
      controls.azimuth = 0.2;
      controls.elevation = 0.4;
    } else {
      controls.target.set(0, 0.8, 0);
      controls.distance = 10.5;
      controls.azimuth = 0.0;
      controls.elevation = 0.28;
    }
    controls.update();
  }

  loadScene(activeSceneName as "pbr" | "cubes");
  engine.start();

  // Toolbar event listeners
  btnScenePbr?.addEventListener("click", () => loadScene("pbr"));
  btnSceneCubes?.addEventListener("click", () => loadScene("cubes"));

  function setToneMapping(mode: ToneMapping): void {
    if (!currentHandle) return;
    currentHandle.scene.settings.toneMapping = mode;
    btnTmAces?.classList.toggle("active", mode === "aces");
    btnTmReinhard?.classList.toggle("active", mode === "reinhard");
    btnTmNone?.classList.toggle("active", mode === "none");
  }

  btnTmAces?.addEventListener("click", () => setToneMapping("aces"));
  btnTmReinhard?.addEventListener("click", () => setToneMapping("reinhard"));
  btnTmNone?.addEventListener("click", () => setToneMapping("none"));

  // Animation & HUD loop
  let last = performance.now();
  let firstError: string | null = null;
  let shownError: string | null = null;

  const frameLoop = (): void => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    if (currentHandle) {
      currentHandle.update(dt);
    }

    const st = engine.stats();
    const health = st.deviceLost ? "DEVICE LOST" : st.gpuErrors > 0 ? `gpu errors ${st.gpuErrors}` : "gpu ok";
    hud.textContent =
      `scene [${activeSceneName.toUpperCase()}]  frame ${st.frame}  fps ${st.fps.toFixed(1)}\n` +
      `draws ${st.drawCalls}  tris ${st.triangles}  instances ${st.instances}\n` +
      `sim ${st.simTimeMs.toFixed(2)}ms  render ${st.renderTimeMs.toFixed(2)}ms\n` +
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
