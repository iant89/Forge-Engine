/**
 * @suite gpu:gpuMemory
 * @group unit
 * @covers engine/src/core/engine.ts
 * @covers engine/src/gpu/device.ts
 * @covers engine/src/index.ts
 * @covers engine/src/math/color.ts
 * @covers engine/src/math/vec.ts
 * @covers engine/src/rendering/material.ts
 * @covers engine/src/rendering/primitives.ts
 * @covers engine/src/rendering/renderer.ts
 * @covers engine/src/resources/registry.ts
 * @covers engine/src/scene/components/index.ts
 * @covers engine/src/scene/scene.ts
 * @desc Phase 9.3 — GPU memory accounting
 */

export const suite = {
  name: "gpu:gpuMemory",
  group: "unit",
  covers:   [
    "engine/src/core/engine.ts",
    "engine/src/gpu/device.ts",
    "engine/src/index.ts",
    "engine/src/math/color.ts",
    "engine/src/math/vec.ts",
    "engine/src/rendering/material.ts",
    "engine/src/rendering/primitives.ts",
    "engine/src/rendering/renderer.ts",
    "engine/src/resources/registry.ts",
    "engine/src/scene/components/index.ts",
    "engine/src/scene/scene.ts"
  ],
  desc: "Phase 9.3 — GPU memory accounting",
};
/**
 * Phase 9.3 — GPU memory accounting.
 *
 * The report the roadmap asks for (`textureBytes`, `bufferBytes`, `pipelineCount`,
 * `bindGroupCount`, `transientBytes`, `pooledBytes`, `evictedBytes`) is only worth having if it is
 * *true*, so these cases check it against things that are independently knowable on the mock device:
 * a 64×64 `rgba8unorm` texture is 16 KiB, a 1 KiB buffer is 1 KiB, destroying them returns the
 * device to its previous numbers, a subsystem that bypasses `GraphicsDevice.createBuffer` is still
 * counted, and a steady rendered frame allocates nothing.
 */

import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import {
  Camera,
  Color,
  GraphicsDevice,
  Light,
  Material,
  Renderable,
  Renderer,
  Scene,
  Vec3,
  createBox,
  createPlane,
  ResourceRegistry,
  type GpuMemoryReport,
} from "@forge/engine";
import { Engine } from "@forge/engine";

group("Phase 9.3 — GPU memory accounting", () => {
  test("counts textures and buffers by size, on both API paths", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const before = device.gpuMemory;
    // Nothing is allocated until something asks for it: the swapchain texture appears on first
    // `getCurrentTexture()`, so a fresh device reports zeros (and must not report a negative).
    assert.equal(before.textureBytes, 0);
    assert.equal(before.bufferBytes, 0);

    const texture = device.createTexture({
      label: "accounted",
      size: { width: 64, height: 64 },
      format: "rgba8unorm",
      usage: 0x10,
    });
    const afterTexture = device.gpuMemory;
    assert.equal(afterTexture.textureBytes - before.textureBytes, 64 * 64 * 4);
    assert.equal(afterTexture.textureCount - before.textureCount, 1);
    assert.equal(afterTexture.texturesCreated - before.texturesCreated, 1);

    // Mip chains are counted in full: 8×8 with 4 mips is 8² + 4² + 2² + 1² texels.
    const mipped = device.createTexture({
      label: "mipped",
      size: { width: 8, height: 8 },
      format: "rgba8unorm",
      mipLevelCount: 4,
      usage: 0x10,
    });
    assert.equal(device.gpuMemory.textureBytes - afterTexture.textureBytes, (64 + 16 + 4 + 1) * 4);

    // The raw device path (renderer/material/geometry use it) is accounted too.
    const viaRawDevice = device.device.createBuffer({ label: "raw", size: 1024, usage: 0x80 });
    const buffer = device.createBuffer({ label: "wrapped", size: 2048, usage: 0x80 });
    const afterBuffers = device.gpuMemory;
    assert.equal(afterBuffers.bufferBytes - before.bufferBytes, 1024 + 2048);
    assert.equal(afterBuffers.bufferCount - before.bufferCount, 2);
    assert.equal(afterBuffers.buffersCreated - before.buffersCreated, 2);

    texture.destroy();
    mipped.destroy();
    viaRawDevice.destroy();
    buffer.destroy();
    const after = device.gpuMemory;
    assert.equal(after.textureBytes, before.textureBytes);
    assert.equal(after.bufferBytes, before.bufferBytes);
    assert.equal(after.textureCount, before.textureCount);
    assert.equal(after.bufferCount, before.bufferCount);
    assert.equal(after.texturesDestroyed - before.texturesDestroyed, 2);
    assert.equal(after.buffersDestroyed - before.buffersDestroyed, 2);
    await device.dispose();
  });

  test("counts pipelines and bind groups without pretending they are freeable", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const renderer = new Renderer(device, { shadowMapSize: 256 });
    const scene = new Scene({ name: "memory" });
    scene.setBackgroundColor(Color.fromSrgbHex(0x101520));
    const cameraEntity = scene.createTransformedEntity("camera", new Vec3(0, 2, -6));
    const camera = new Camera();
    scene.world.addComponent(cameraEntity.id, camera);
    cameraEntity.transform.lookAt(new Vec3(0, 0, 0));
    const sun = scene.createTransformedEntity("sun", new Vec3(4, 8, -4));
    const light = new Light();
    light.kind = "directional";
    light.castShadow = true;
    scene.world.addComponent(sun.id, light);
    sun.transform.lookAt(new Vec3(0, 0, 0));
    const box = createBox(device, { width: 1, height: 1, depth: 1 });
    const material = new Material({ label: "box", color: 0xff8800 });
    const entity = scene.createTransformedEntity("box", new Vec3(0, 0, 0));
    const renderable = new Renderable();
    renderable.geometry = box;
    renderable.material = material;
    scene.world.addComponent(entity.id, renderable);

    const beforePipelines = device.gpuMemory.pipelineCount;
    renderer.renderScene(scene, { width: 320, height: 180, viewport: { x: 0, y: 0, width: 320, height: 180 } } as never);
    const after = device.gpuMemory;
    assert.ok(after.pipelineCount > beforePipelines); // the frame's techniques compiled
    assert.ok(after.bindGroupCount > 0);
    assert.ok(after.bindGroupLayoutCount > 0);
    assert.ok(after.shaderModuleCount > 0);
    assert.ok(after.pipelineCount >= after.shaderModuleCount);

    renderer.dispose();
    await device.dispose();
  });

  test("reports a steady frame as allocation-free and a resize as a bounded cost", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    device.resize(320, 180);
    const renderer = new Renderer(device, { shadowMapSize: 128 });
    const scene = new Scene({ name: "steady" });
    scene.setBackgroundColor(Color.fromSrgbHex(0x101520));
    const cameraEntity = scene.createTransformedEntity("camera", new Vec3(0, 2, -6));
    scene.world.addComponent(cameraEntity.id, new Camera());
    cameraEntity.transform.lookAt(new Vec3(0, 0, 0));
    const plane = createPlane(device, { width: 20, depth: 20 });
    const material = new Material({ label: "ground", color: 0x335544 });
    const ground = scene.createTransformedEntity("ground", new Vec3(0, 0, 0));
    const renderable = new Renderable();
    renderable.geometry = plane;
    renderable.material = material;
    scene.world.addComponent(ground.id, renderable);
    const frame = { width: 320, height: 180, viewport: { x: 0, y: 0, width: 320, height: 180 } } as never;

    renderer.renderScene(scene, frame);
    renderer.renderScene(scene, frame);
    device.beginFrame();
    renderer.renderScene(scene, frame);
    const steady = device.gpuMemory.sinceFrameStart;
    assert.equal(steady.texturesCreated, 0);
    assert.equal(steady.buffersCreated, 0);
    assert.equal(steady.bytesCreated, 0);

    // A resize re-plans the frame-sized transients: a bounded, one-off cost.
    device.resize(640, 360);
    device.beginFrame();
    renderer.renderScene(scene, { width: 640, height: 360, viewport: { x: 0, y: 0, width: 640, height: 360 } } as never);
    assert.ok(device.gpuMemory.sinceFrameStart.texturesCreated > 0);
    assert.ok(device.gpuMemory.sinceFrameStart.bytesDestroyed >= 0);

    renderer.dispose();
    await device.dispose();
  });

  test("assembles the engine report from the device, the graph and the resource registry", async () => {
    const engine = await Engine.create({ forceMock: true, config: { headless: true } });
    const scene = new Scene({ name: "report" });
    scene.setBackgroundColor(Color.fromSrgbHex(0x101520));
    const cameraEntity = scene.createTransformedEntity("camera", new Vec3(0, 2, -6));
    scene.world.addComponent(cameraEntity.id, new Camera());
    cameraEntity.transform.lookAt(new Vec3(0, 0, 0));
    engine.setScene(scene);
    engine.setSize(320, 180);
    engine.runFrames(3, 1 / 60);

    const report: GpuMemoryReport = engine.stats().gpuMemory;
    for (const field of [
      "textureBytes",
      "bufferBytes",
      "textureCount",
      "bufferCount",
      "pipelineCount",
      "bindGroupCount",
      "transientBytes",
      "pooledBytes",
      "evictedBytes",
    ] as const) {
      assert.equal(typeof report[field], "number", field);
      assert.ok(report[field] >= 0, field);
    }
    assert.ok(report.textureBytes > 0); // the HDR chain allocated targets
    assert.ok(report.transientBytes > 0); // the frame has transient targets
    assert.ok(report.pooledBytes >= report.transientBytes);
    assert.equal(report.evictedBytes, 0); // nothing is evictable yet
    // The engine also exposes scheduler state next to it (Phase 9.1).
    assert.equal(engine.stats().tasks.workers, 0);
    assert.equal(engine.stats().tasks.inline, true);
    await engine.dispose();
  });

  test("counts evicted resource bytes into the report", async () => {
    const registry = new ResourceRegistry({ maxBytes: 64, idleGraceMs: 0 });
    const handle = registry.acquire<string>({
      id: "big",
      kind: "test",
      bytes: () => 4096,
      load: () => "value",
    });
    await handle.wait();
    handle.release();
    assert.equal(registry.bytes, 4096);
    registry.evictIdle();
    assert.equal(registry.evictedBytes, 4096);
    assert.equal(registry.stats().evictedBytes, 4096);
    assert.equal(registry.bytes, 0);
    registry.dispose();
  });
});

await finish();
