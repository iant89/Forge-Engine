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
  SlotAllocator,
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

/**
 * Phase 14.3's device-resident instance blocks live in slots of one shared GPU buffer, so the slot
 * allocator is the thing that decides whether a streaming world's instance memory reaches a ceiling
 * or grows forever. These cases check the three properties the renderer relies on and cannot verify
 * itself: offsets a draw can bind directly (256-aligned), a region that stops growing once the
 * buckets are warm, and a free that cannot corrupt the region (double free, or handing the same
 * bytes to two live slots).
 */
describe("SlotAllocator — device-resident byte slots (Phase 14.3)", () => {
  it("hands back 256-aligned offsets a bind group can use as a dynamic offset", () => {
    const allocator = new SlotAllocator();
    // A WebGPU dynamic offset must be a multiple of minStorageBufferOffsetAlignment (256 on every
    // adapter the engine supports), and a writeBuffer offset a multiple of 4: one slot satisfies
    // both without the caller rounding anything.
    for (const bytes of [1, 4, 80, 255, 256, 257, 1024, 3072, 65_535]) {
      const offset = allocator.allocate(bytes);
      expect(offset % SlotAllocator.ALIGNMENT).toBe(0);
      expect(offset).toBeGreaterThanOrEqual(0);
    }
    // And every request got a slot at least as large as it asked for.
    expect(allocator.usedBytes).toBeGreaterThanOrEqual(1 + 4 + 80 + 255 + 256 + 257 + 1024 + 3072 + 65_535);
    expect(allocator.allocationCount).toBe(9);
  });

  it("buckets by power of two, so a slot is never more than twice the request", () => {
    expect(SlotAllocator.slotBytesFor(1)).toBe(256);
    expect(SlotAllocator.slotBytesFor(256)).toBe(256);
    expect(SlotAllocator.slotBytesFor(257)).toBe(512);
    expect(SlotAllocator.slotBytesFor(512)).toBe(512);
    expect(SlotAllocator.slotBytesFor(81 * 1024)).toBe(128 * 1024);
    // Internal fragmentation is bounded by 2× of the *request*, not of the region: a 41 KiB block
    // wastes at most 23 KiB, whatever else is live.
    const allocator = new SlotAllocator();
    const offset = allocator.allocate(41 * 1024);
    // 41 KiB aligns to itself and rounds up to the next power of two — 64 KiB, 1.56× the request.
    expect(allocator.usedBytes).toBe(64 * 1024);
    expect(offset).toBe(0);
  });

  it("reuses a freed slot before growing the region, and never overlaps two live slots", () => {
    const allocator = new SlotAllocator();
    const a = allocator.allocate(4096);
    const b = allocator.allocate(4096);
    const capacityAfterTwo = allocator.capacity;
    expect(b).not.toBe(a);
    allocator.free(a);
    expect(allocator.allocationCount).toBe(1);
    expect(allocator.freeBytes).toBe(4096);
    // Same bucket → the freed slot comes straight back, and the region did not move.
    const c = allocator.allocate(4096);
    expect(c).toBe(a);
    expect(allocator.capacity).toBe(capacityAfterTwo);
    // A request of a *different* bucket must not land inside a live slot.
    const d = allocator.allocate(64 * 1024);
    expect(d).toBeGreaterThanOrEqual(allocator.capacity - 64 * 1024);
    const live: [number, number][] = [];
    for (const [start, size] of [[c, 4096], [b, 4096], [d, 64 * 1024]] as [number, number][]) live.push([start, size]);
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const [s1, n1] = live[i]!;
        const [s2, n2] = live[j]!;
        expect(s1 + n1 <= s2 || s2 + n2 <= s1).toBe(true);
      }
    }
  });

  it("keeps the region's high-water mark when slots are freed (the buffer cannot shrink mid-frame)", () => {
    const allocator = new SlotAllocator();
    for (let i = 0; i < 8; i++) allocator.allocate(2048);
    const peak = allocator.capacity;
    expect(peak).toBe(8 * 2048);
    for (let i = 0; i < 8; i++) allocator.free(i * 2048);
    expect(allocator.allocationCount).toBe(0);
    expect(allocator.usedBytes).toBe(0);
    // The GPU buffer sized from `capacity` is reallocated only when the mark *grows*: freeing must
    // not lower it, or a chunk streaming back in would force a buffer recreate and a full re-upload.
    expect(allocator.capacity).toBe(peak);
    allocator.allocate(2048);
    expect(allocator.capacity).toBe(peak);
  });

  it("treats a double free as a no-op, so one slot cannot be handed out twice", () => {
    const allocator = new SlotAllocator();
    const a = allocator.allocate(1024);
    allocator.free(a);
    allocator.free(a);
    allocator.free(a);
    expect(allocator.allocationCount).toBe(0);
    expect(allocator.freeBytes).toBe(1024);
    const b = allocator.allocate(1024);
    const c = allocator.allocate(1024);
    expect(b).toBe(a);
    expect(c).not.toBe(b);
  });

  it("rejects a non-positive or non-finite request instead of returning offset 0 for it", () => {
    const allocator = new SlotAllocator();
    // Offset 0 is a *valid* slot, so a refused request must be distinguishable from it.
    for (const bytes of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(allocator.allocate(bytes)).toBe(-1);
    }
    expect(allocator.allocationCount).toBe(0);
    expect(allocator.capacity).toBe(0);
  });

  it("caps a slot at 4 MiB and says so rather than silently truncating", () => {
    const allocator = new SlotAllocator();
    // 4 MiB is ~52 000 population instances of one chunk: past it the request is a bug in the
    // caller's sizing, not something to round down.
    expect(allocator.allocate(4 * 1024 * 1024)).toBe(0);
    expect(() => allocator.allocate(4 * 1024 * 1024 + 1)).toThrow(/exceeds the 4194304-byte slot cap/);
  });

  it("survives a streaming pattern: thousands of allocate/free pairs stay inside the warm buckets", () => {
    const allocator = new SlotAllocator();
    // What a terrain streamer actually does: a handful of distinct block sizes (one per population
    // type's maxPerChunk), chunks arriving and leaving in arbitrary order. The claim is that the
    // region reaches a ceiling and stops growing, and that no two live slots ever overlap.
    const sizes = [36 * 80, 64 * 80, 256 * 80, 1024 * 80];
    const live = new Map<number, number>();
    let peak = 0;
    let seed = 12345;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    let requested = 0;
    for (let step = 0; step < 4000; step++) {
      // A streamer's own policy: grow towards the working set, and shrink below it. The cap is what
      // makes the region bounded — a walk that only ever grew would prove nothing about reuse.
      if (live.size < 24 && (live.size === 0 || random() < 0.7)) {
        const bytes = sizes[Math.floor(random() * sizes.length)]!;
        const offset = allocator.allocate(bytes);
        expect(offset).toBeGreaterThanOrEqual(0);
        // The load-bearing property: an offset handed out is never already live.
        expect(live.has(offset)).toBe(false);
        live.set(offset, SlotAllocator.slotBytesFor(bytes));
        requested += bytes;
      } else {
        const keys = [...live.keys()];
        const victim = keys[Math.floor(random() * keys.length)]!;
        allocator.free(victim);
        live.delete(victim);
      }
      if (allocator.capacity > peak) peak = allocator.capacity;
      // The high-water mark only ever grows, so the buffer sized from it is never reallocated
      // mid-stream; and it always accounts for exactly the live slots.
      expect(allocator.capacity).toBe(peak);
      expect(allocator.usedBytes).toBe([...live.values()].reduce((a, b) => a + b, 0));
    }
    // At most 24 live slots, the largest bucket 128 KiB: the region's ceiling is 3 MiB no matter how
    // long the stream runs, and far below the ~250 MiB the 4000 requests would need without reuse.
    expect(peak).toBeLessThanOrEqual(24 * SlotAllocator.slotBytesFor(1024 * 80));
    expect(peak).toBeLessThan(requested / 8);
    expect(allocator.allocationCount).toBe(live.size);
    allocator.clear();
    expect(allocator.capacity).toBe(0);
    expect(allocator.allocationCount).toBe(0);
    expect(allocator.freeBytes).toBe(0);
  });
});
