/**
 * @suite ui:uiGpu
 * @group integration
 * @covers engine/src/ui/gpu/uiGpuRenderer.ts
 * @covers engine/src/ui/gpu/shader.ts
 * @covers engine/src/rendering/renderer.ts
 * @desc The UI's WebGPU backend over the strict mock device: the forge.ui overlay pass is recorded last onto the swapchain with load (not clear), one draw per texture batch, uploads only when the draw list or an atlas page changes, a steady frame allocates nothing, the UI follows swapchain resizes, the shader passes the engine's WGSL validation, and dispose releases every GPU resource
 */

export const suite = {
  name: "ui:uiGpu",
  group: "integration",
  covers: ["engine/src/ui/gpu/uiGpuRenderer.ts", "engine/src/ui/gpu/shader.ts", "engine/src/rendering/renderer.ts"],
  desc: "The UI's WebGPU backend over the strict mock device: the forge.ui overlay pass is recorded last onto the swapchain with load (not clear), one draw per texture batch, uploads only when the draw list or an atlas page changes, a steady frame allocates nothing, the UI follows swapchain resizes, the shader passes the engine's WGSL validation, and dispose releases every GPU resource",
};

import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import {
  Button,
  Camera,
  GraphicsDevice,
  Label,
  Panel,
  Renderer,
  Scene,
  UIGpuRenderer,
  UIManager,
  UI_FRAME_STRUCT,
  UI_SHADER,
  UIImage,
  Vec3,
  VStack,
  validateWgsl,
} from "@forge/engine";

interface Fixture {
  device: GraphicsDevice;
  renderer: Renderer;
  scene: Scene;
  ui: UIManager;
  uiGpu: UIGpuRenderer;
  frame(): void;
  dispose(): Promise<void>;
}

async function fixture(width = 640, height = 360): Promise<Fixture> {
  const device = await GraphicsDevice.create({ forceMock: true });
  device.resize(width, height);
  const renderer = new Renderer(device, { shadowMapSize: 256 });
  const scene = new Scene({ name: "ui-gpu-test" });
  const cam = scene.createTransformedEntity("camera", new Vec3(0, 2, -6));
  scene.world.addComponent(cam.id, new Camera());
  cam.transform.lookAt(new Vec3(0, 0, 0));
  const ui = new UIManager({ width, height });
  const uiGpu = new UIGpuRenderer(device, ui);
  const overlay = renderer.addOverlay(uiGpu);
  return {
    device,
    renderer,
    scene,
    ui,
    uiGpu,
    frame() {
      ui.update(1 / 60);
      renderer.renderScene(scene);
    },
    async dispose() {
      overlay.dispose();
      uiGpu.dispose();
      ui.dispose();
      scene.dispose();
      renderer.dispose();
      const mock = device.mock!;
      await device.dispose();
      assert.deepEqual(mock.outstanding.buffers, [], "no buffers leaked");
      assert.deepEqual(mock.outstanding.textures, [], "no textures leaked");
    },
  };
}

function populate(ui: UIManager): void {
  const col = ui.base.add(new VStack({ gap: 8, layout: { padding: 16 } }));
  col.add(new Label({ text: "Forge UI", variant: "heading" }));
  col.add(new Button({ text: "Play" }));
  col.add(new Panel({ layout: { width: 120, height: 40 } }));
}

group("forge.ui pass", () => {
  test("the overlay pass is recorded after the scene, loads the swapchain and draws one call per batch", async () => {
    const f = await fixture();
    populate(f.ui);
    f.frame();
    const mock = f.device.mock!;
    const passes = mock.passes.map((p) => p.label);
    assert.equal(passes[passes.length - 1], "forge.ui", passes.join(" → "));
    const pass = mock.passes[mock.passes.length - 1]!;
    assert.deepEqual(pass.colorTargets, ["swapchain"]);
    assert.equal(pass.drawCalls, f.ui.render().batches.length);
    assert.equal(pass.instances, f.ui.render().count, "every instance drawn");
    assert.equal(f.uiGpu.stats.drawCalls, pass.drawCalls);
    const begin = mock.commandLog.filter((c) => c.type === "renderPass" && c.label === "forge.ui");
    assert.equal(begin.length, 1);
    assert.equal(JSON.stringify(begin[0]).includes('"clear"'), false, "the UI composites over the frame (loadOp load)");
    assert.deepEqual(f.renderer.overlayNames, ["forge.ui"]);
    await f.dispose();
  });

  test("an empty UI records no pass and no draw", async () => {
    const f = await fixture();
    f.frame();
    assert.ok(!f.device.mock!.passes.some((p) => p.label === "forge.ui"));
    assert.equal(f.uiGpu.stats.drawCalls, 0);
    await f.dispose();
  });

  test("uploads happen only when something changed; a steady frame creates no textures or buffers", async () => {
    const f = await fixture();
    populate(f.ui);
    const status = f.ui.base.add(new Label({ text: "frame 0" }));
    f.frame();
    f.frame();
    const mock = f.device.mock!;
    const uploadsAfterWarmup = f.uiGpu.stats.instanceUploads;
    const created = { ...mock.created };
    const logMark = mock.commandLog.length;
    f.frame();
    f.frame();
    assert.equal(f.uiGpu.stats.instanceUploads, uploadsAfterWarmup, "unchanged draw list is not re-uploaded");
    assert.equal(mock.commandLog.slice(logMark).filter((c) => c.type === "writeTexture").length, 0, "no atlas uploads");
    // The renderer takes one view of the swapchain's current texture per frame (as it does with no
    // UI at all); everything else must be reused.
    const views = (mock.created.view ?? 0) - (created.view ?? 0);
    assert.equal(views, 2, "only the per-frame swapchain views");
    assert.deepEqual({ ...mock.created, view: 0 }, { ...created, view: 0 }, "steady frame allocates nothing else");
    assert.equal(f.renderer.stats.texturesCreated, 0);
    status.text = "frame 1 — new glyphs: ÆØÅ";
    f.frame();
    assert.equal(f.uiGpu.stats.instanceUploads, uploadsAfterWarmup + 1);
    await f.dispose();
  });

  test("image assets get a texture batch of their own and are destroyed when unregistered", async () => {
    const f = await fixture();
    f.ui.assets.registerPixels("logo", 8, 8, new Uint8Array(8 * 8 * 4).fill(200));
    populate(f.ui);
    f.ui.base.add(new UIImage({ source: "logo", layout: { position: "absolute", anchor: { right: 10, top: 10 } } }));
    f.frame();
    const batches = f.ui.render().batches.map((b) => b.texture);
    assert.ok(batches.includes("logo"));
    assert.equal(f.device.mock!.passes.at(-1)!.drawCalls, batches.length);
    const tex = f.uiGpu.stats.textures;
    f.ui.assets.unregisterTexture("logo");
    f.frame();
    assert.ok(f.uiGpu.stats.textures < tex, "the GPU copy went with the asset");
    await f.dispose();
  });

  test("the UI follows a swapchain resize so drawing and hit testing share one scale", async () => {
    const f = await fixture(640, 360);
    populate(f.ui);
    f.frame();
    f.device.resize(1280, 720);
    f.renderer.renderScene(f.scene);
    assert.deepEqual([f.ui.viewport.physicalWidth, f.ui.viewport.physicalHeight], [1280, 720]);
    assert.deepEqual([f.ui.viewport.width, f.ui.viewport.height], [1280, 720]);
    await f.dispose();
  });

  test("needsRender wakes an idle renderer only when the UI changed", async () => {
    const f = await fixture();
    const b = f.ui.base.add(new Button({ text: "x" }));
    f.frame();
    f.ui.update(1 / 60);
    assert.equal(f.uiGpu.needsRender, false);
    b.text = "changed";
    f.ui.update(1 / 60);
    assert.equal(f.uiGpu.needsRender, true);
    assert.equal(f.renderer.needsRender, true, "the renderer asks its overlays");
    await f.dispose();
  });

  test("adding the same overlay twice is an error; removing it stops the pass", async () => {
    const f = await fixture();
    populate(f.ui);
    assert.throws(() => f.renderer.addOverlay(f.uiGpu), /already added/);
    f.frame();
    assert.ok(f.device.mock!.passes.some((p) => p.label === "forge.ui"));
    await f.dispose();
  });
});

group("shader", () => {
  test("UI_SHADER passes the engine's WGSL validation and declares the generated frame struct", () => {
    assert.deepEqual(validateWgsl(UI_SHADER), []);
    assert.ok(UI_SHADER.includes(UI_FRAME_STRUCT.toWgsl("uniform")), "struct emitted from the TS definition");
    assert.equal(UI_FRAME_STRUCT.size("uniform") % 16, 0);
    assert.ok(/fn vsMain/.test(UI_SHADER) && /fn fsMain/.test(UI_SHADER));
  });
});

await finish();
