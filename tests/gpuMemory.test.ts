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

import { describe, expect, it } from "vitest";
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

describe("Phase 9.3 — GPU memory accounting", () => {
  it("counts textures and buffers by size, on both API paths", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const before = device.gpuMemory;
    // Nothing is allocated until something asks for it: the swapchain texture appears on first
    // `getCurrentTexture()`, so a fresh device reports zeros (and must not report a negative).
    expect(before.textureBytes).toBe(0);
    expect(before.bufferBytes).toBe(0);

    const texture = device.createTexture({
      label: "accounted",
      size: { width: 64, height: 64 },
      format: "rgba8unorm",
      usage: 0x10,
    });
    const afterTexture = device.gpuMemory;
    expect(afterTexture.textureBytes - before.textureBytes).toBe(64 * 64 * 4);
    expect(afterTexture.textureCount - before.textureCount).toBe(1);
    expect(afterTexture.texturesCreated - before.texturesCreated).toBe(1);

    // Mip chains are counted in full: 8×8 with 4 mips is 8² + 4² + 2² + 1² texels.
    const mipped = device.createTexture({
      label: "mipped",
      size: { width: 8, height: 8 },
      format: "rgba8unorm",
      mipLevelCount: 4,
      usage: 0x10,
    });
    expect(device.gpuMemory.textureBytes - afterTexture.textureBytes).toBe((64 + 16 + 4 + 1) * 4);

    // The raw device path (renderer/material/geometry use it) is accounted too.
    const viaRawDevice = device.device.createBuffer({ label: "raw", size: 1024, usage: 0x80 });
    const buffer = device.createBuffer({ label: "wrapped", size: 2048, usage: 0x80 });
    const afterBuffers = device.gpuMemory;
    expect(afterBuffers.bufferBytes - before.bufferBytes).toBe(1024 + 2048);
    expect(afterBuffers.bufferCount - before.bufferCount).toBe(2);
    expect(afterBuffers.buffersCreated - before.buffersCreated).toBe(2);

    texture.destroy();
    mipped.destroy();
    viaRawDevice.destroy();
    buffer.destroy();
    const after = device.gpuMemory;
    expect(after.textureBytes).toBe(before.textureBytes);
    expect(after.bufferBytes).toBe(before.bufferBytes);
    expect(after.textureCount).toBe(before.textureCount);
    expect(after.bufferCount).toBe(before.bufferCount);
    expect(after.texturesDestroyed - before.texturesDestroyed).toBe(2);
    expect(after.buffersDestroyed - before.buffersDestroyed).toBe(2);
    await device.dispose();
  });

  it("counts pipelines and bind groups without pretending they are freeable", async () => {
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
    expect(after.pipelineCount).toBeGreaterThan(beforePipelines); // the frame's techniques compiled
    expect(after.bindGroupCount).toBeGreaterThan(0);
    expect(after.bindGroupLayoutCount).toBeGreaterThan(0);
    expect(after.shaderModuleCount).toBeGreaterThan(0);
    expect(after.pipelineCount).toBeGreaterThanOrEqual(after.shaderModuleCount);

    renderer.dispose();
    await device.dispose();
  });

  it("reports a steady frame as allocation-free and a resize as a bounded cost", async () => {
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
    expect(steady.texturesCreated).toBe(0);
    expect(steady.buffersCreated).toBe(0);
    expect(steady.bytesCreated).toBe(0);

    // A resize re-plans the frame-sized transients: a bounded, one-off cost.
    device.resize(640, 360);
    device.beginFrame();
    renderer.renderScene(scene, { width: 640, height: 360, viewport: { x: 0, y: 0, width: 640, height: 360 } } as never);
    expect(device.gpuMemory.sinceFrameStart.texturesCreated).toBeGreaterThan(0);
    expect(device.gpuMemory.sinceFrameStart.bytesDestroyed).toBeGreaterThanOrEqual(0);

    renderer.dispose();
    await device.dispose();
  });

  it("assembles the engine report from the device, the graph and the resource registry", async () => {
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
      expect(typeof report[field], field).toBe("number");
      expect(report[field], field).toBeGreaterThanOrEqual(0);
    }
    expect(report.textureBytes).toBeGreaterThan(0); // the HDR chain allocated targets
    expect(report.transientBytes).toBeGreaterThan(0); // the frame has transient targets
    expect(report.pooledBytes).toBeGreaterThanOrEqual(report.transientBytes);
    expect(report.evictedBytes).toBe(0); // nothing is evictable yet
    // The engine also exposes scheduler state next to it (Phase 9.1).
    expect(engine.stats().tasks.workers).toBe(0);
    expect(engine.stats().tasks.inline).toBe(true);
    await engine.dispose();
  });

  it("counts evicted resource bytes into the report", async () => {
    const registry = new ResourceRegistry({ maxBytes: 64, idleGraceMs: 0 });
    const handle = registry.acquire<string>({
      id: "big",
      kind: "test",
      bytes: () => 4096,
      load: () => "value",
    });
    await handle.wait();
    handle.release();
    expect(registry.bytes).toBe(4096);
    registry.evictIdle();
    expect(registry.evictedBytes).toBe(4096);
    expect(registry.stats().evictedBytes).toBe(4096);
    expect(registry.bytes).toBe(0);
    registry.dispose();
  });
});
