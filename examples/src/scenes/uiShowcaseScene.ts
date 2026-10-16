/**
 * UI showcase scene: the `uiGallery` drawn by the engine's WebGPU UI pass over a small 3D scene.
 *
 * Wiring (the same three lines any app needs): a `UIManager` sized to the canvas, a `UIGpuRenderer`
 * registered as a renderer overlay, and `attachDomInput` for pointer/keyboard/gamepad. The 3D scene
 * keeps running underneath; the world-space label on the HUD page follows a spinning crate.
 *
 * `?uiskin=` / `?uitheme=` pick the starting skin/theme, `?uipage=` the starting page.
 */

import { Camera, Color, Light, Material, Quat, Renderable, Scene, TextInput, UIGpuRenderer, UIManager, Vec3, attachDomInput, createBox, createPlane, type Engine, type WorldCamera } from "@forge/engine";
import type { DemoSceneHandle } from "./cubesScene.js";
import { buildUIGallery, type UIGalleryHandle } from "../ui/uiGallery.js";

export interface UIShowcaseHandle extends DemoSceneHandle {
  ui: UIManager;
  gallery: UIGalleryHandle;
  uiRenderer: UIGpuRenderer;
}

export function buildUIShowcaseScene(engine: Engine, canvas: HTMLCanvasElement, query = new URLSearchParams()): UIShowcaseHandle {
  const scene = new Scene({ name: "ui-showcase" });
  scene.setBackgroundColor(Color.fromSrgbHex(0x0a0f18));

  const ground = scene.createTransformedEntity("ground", new Vec3(0, 0, 0));
  const groundR = new Renderable();
  groundR.geometry = createPlane(engine.gpu, { width: 40, depth: 40 });
  groundR.material = new Material({ label: "ground", color: 0x2b3442, roughness: 0.95 });
  groundR.castShadow = false;
  scene.world.addComponent(ground.id, groundR);

  const crate = scene.createTransformedEntity("crate", new Vec3(2.5, 0.8, 1.5));
  const crateR = new Renderable();
  crateR.geometry = createBox(engine.gpu, { width: 1.2, height: 1.2, depth: 1.2 });
  crateR.material = new Material({ label: "crate", color: 0xc2703d, roughness: 0.5 });
  scene.world.addComponent(crate.id, crateR);

  const cameraEntity = scene.createTransformedEntity("camera", new Vec3(0, 4, -10));
  const camera = new Camera();
  camera.fovY = Math.PI / 3;
  camera.near = 0.1;
  camera.far = 200;
  scene.world.addComponent(cameraEntity.id, camera);
  cameraEntity.transform.lookAt(new Vec3(0, 0.8, 0));

  const sunEntity = scene.createTransformedEntity("sun", new Vec3(6, 12, -6));
  const sun = new Light();
  sun.intensity = 4;
  scene.world.addComponent(sunEntity.id, sun);
  sunEntity.transform.lookAt(new Vec3(0, 0, 0));

  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  const ui = new UIManager({
    width: canvas.width,
    height: canvas.height,
    devicePixelRatio: dpr,
    skin: query.get("uiskin") ?? undefined,
    theme: query.get("uitheme") ?? undefined,
  });

  const crateWorld = { x: 0, y: 0, z: 0 };
  const worldCamera: WorldCamera & { viewProj: Float32Array; position: { x: number; y: number; z: number } } = { viewProj: new Float32Array(16), position: { x: 0, y: 0, z: 0 } };
  const gallery = buildUIGallery(ui, {
    camera: () => worldCamera,
    labelTarget: () => crateWorld,
  });
  const startPage = query.get("uipage");
  if (startPage) gallery.navigate(startPage);

  const uiRenderer = new UIGpuRenderer(engine.gpu, ui);
  const overlay = engine.renderer.addOverlay(uiRenderer);
  const input = attachDomInput(canvas, ui.router, ui.viewport);
  TextInput.clipboard = input.clipboard;

  const spin = new Quat();
  let t = 0;
  const update = (dt: number): void => {
    t += dt;
    const tr = scene.world.facade(crate.id)?.transform;
    if (tr) {
      tr.rotation = spin.setAxisAngle(new Vec3(0, 1, 0), t * 0.6);
      const p = tr.position;
      crateWorld.x = p.x;
      crateWorld.y = p.y + 0.9;
      crateWorld.z = p.z;
    }
    // The world-space label projects with the camera the renderer used last frame.
    // Render-local space on both sides (this scene never rebases its origin).
    worldCamera.position.x = camera.positionRender.x;
    worldCamera.position.y = camera.positionRender.y;
    worldCamera.position.z = camera.positionRender.z;
    worldCamera.viewProj.set(camera.viewProjection.m);
    if (canvas.width !== ui.viewport.physicalWidth || canvas.height !== ui.viewport.physicalHeight) ui.setViewport(canvas.width, canvas.height, dpr);
    input.pollGamepads();
    gallery.update(dt);
    ui.update(dt);
  };

  return {
    scene,
    cameraEntity,
    update,
    ui,
    gallery,
    uiRenderer,
    controlsHint: "UI gallery · mouse/touch, Tab/arrows/Enter/Esc, or a gamepad (d-pad, A, B, LB/RB)",
    camera: { keyboard: false },
    overlay: () => {
      const f = ui.lastFrame;
      const g = uiRenderer.stats;
      return `ui ${f.elements} el · ${g.instances} inst · ${g.drawCalls} draws · ${ui.breakpoint} ${Math.round(ui.viewport.width)}x${Math.round(ui.viewport.height)} · skin ${ui.skin} · theme ${ui.theme}`;
    },
    dispose: () => {
      overlay.dispose();
      input.dispose();
      gallery.dispose();
      uiRenderer.dispose();
      ui.dispose();
    },
  };
}
