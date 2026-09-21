/**
 * Phase 1 demo: a lit row of cubes over a ground plane, driven by the engine's own loop.
 *
 * Public API only (`@forge/engine`), plus a small `window.__forge` handle so `npm run check:browser`
 * can assert on real numbers (frames presented, draw calls, backend) instead of eyeballing a picture.
 *
 * Every failure the engine can see is put on the page, not just in the console: the demo is opened
 * on phones, where a black canvas with a ticking frame counter is otherwise all there is to report.
 */
import { Camera, Color, Engine, Light, Material, Quat, Renderable, Scene, Vec3, createBox, createPlane, detectPlatform } from "@forge/engine";

const canvas = document.getElementById("view") as HTMLCanvasElement;
const hud = document.getElementById("hud") as HTMLDivElement;
const errorBox = document.getElementById("error") as HTMLDivElement;

function showError(text: string): void {
  errorBox.style.display = "block";
  errorBox.textContent = text;
}

async function main(): Promise<void> {
  const platform = detectPlatform();
  const engine = await Engine.create({ canvas, quality: "high", logLevel: "info" });
  const where = `${platform.browser}/${platform.os}  ${engine.gpu.format}  dpr ${Math.min(platform.devicePixelRatio, 2).toFixed(2)}`;
  const scene = new Scene({ name: "cubes" });
  scene.setBackgroundColor(Color.fromSrgbHex(0x070b12));

  const ground = scene.createTransformedEntity("ground", new Vec3(0, 0, 0));
  const groundRenderable = new Renderable();
  groundRenderable.geometry = createPlane(engine.gpu, { width: 48, depth: 48 });
  groundRenderable.material = new Material({ label: "ground", color: 0x5b6470, roughness: 0.9 });
  groundRenderable.castShadow = false;
  scene.world.addComponent(ground.id, groundRenderable);

  const boxMesh = createBox(engine.gpu, { width: 1.2, height: 1.2, depth: 1.2 });
  const palette = [0xc2703d, 0x9aa5b1, 0x4d7c8f, 0x8f4d6b, 0x6b8f4d, 0xd9b382];
  const spinners: { id: number; axis: Vec3; rate: number; quat: Quat }[] = [];
  for (let i = 0; i < palette.length; i++) {
    const entity = scene.createTransformedEntity(`cube-${i}`, new Vec3((i - 2.5) * 2.1, 0.9, Math.sin(i) * 1.5));
    const renderable = new Renderable();
    renderable.geometry = boxMesh;
    renderable.material = new Material({ label: `cube-${i}`, color: palette[i]!, roughness: 0.3 + i * 0.09, metallic: 0.2 });
    scene.world.addComponent(entity.id, renderable);
    spinners.push({ id: entity.id, axis: new Vec3(0.3, 1, 0.15).normalize(), rate: 0.35 + i * 0.13, quat: new Quat() });
  }

  const cameraEntity = scene.createTransformedEntity("camera", new Vec3(0, 3.4, -9.5));
  const camera = new Camera();
  camera.fovY = Math.PI / 3;
  camera.near = 0.1;
  camera.far = 200;
  scene.world.addComponent(cameraEntity.id, camera);
  cameraEntity.transform.lookAt(new Vec3(0, 0.8, 0));

  const sunEntity = scene.createTransformedEntity("sun", new Vec3(7, 13, -7));
  const sun = new Light();
  sun.intensity = 5;
  scene.world.addComponent(sunEntity.id, sun);
  sunEntity.transform.lookAt(new Vec3(0, 0, 0));

  engine.setScene(scene);
  engine.start();

  // Rotation is applied between engine ticks; the transform store's dirty tracking picks it up, which
  // is the same path a game's animation system would use.
  let last = performance.now();
  const spin = (): void => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    for (const s of spinners) {
      const t = scene.world.facade(s.id)?.transform;
      if (!t) continue;
      const delta = Quat.fromAxisAngle(s.axis, s.rate * dt);
      t.rotation = delta.multiply(t.rotation).normalize();
    }
  };
  let firstError: string | null = null;
  let shownError: string | null = null;
  const hudTick = (): void => {
    spin();
    const st = engine.stats();
    const health = st.deviceLost ? "DEVICE LOST" : st.gpuErrors > 0 ? `gpu errors ${st.gpuErrors}` : "gpu ok";
    hud.textContent =
      `frame ${st.frame}  fps ${st.fps.toFixed(1)}\n` +
      `draws ${st.drawCalls}  tris ${st.triangles}\n` +
      `sim ${st.simTimeMs.toFixed(2)}ms  render ${st.renderTimeMs.toFixed(2)}ms\n` +
      `${where}  ${canvas.width}x${canvas.height}  ${health}`;
    // GPU errors arrive asynchronously (shader compile, pipeline validation, submit). The first one
    // is the diagnosis and the rest are usually consequences, so pin the first on screen and keep
    // the latest next to it instead of letting either scroll past in a console nobody sees.
    if (st.lastError && st.lastError !== shownError) {
      firstError ??= st.lastError;
      shownError = st.lastError;
      const latest = st.lastError === firstError ? "" : `\n\nlatest:\n${st.lastError}`;
      showError(`GPU errors: ${st.gpuErrors}\n\nfirst:\n${firstError}${latest}`);
    }
    requestAnimationFrame(hudTick);
  };
  requestAnimationFrame(hudTick);

  (window as unknown as { __forge: Record<string, unknown> }).__forge = {
    backend: (engine.gpu as unknown as { caps?: { backend?: string } }).caps?.backend ?? "webgpu",
    stats: () => engine.stats(),
    scene,
    engine,
    dispose: () => {
      engine.stop();
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
