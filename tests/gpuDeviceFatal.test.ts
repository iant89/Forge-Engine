/**
 * Device failure handling: the "Buffer with 'population.instances' label is invalid" bug.
 *
 * Real WebGPU never throws from `createBuffer`/`createTexture` when an *allocation* fails: the
 * device reports an error and returns the resource in an invalid state (wgpu: `Buffer::invalid`),
 * so every later use of it — a `createBindGroup`, a `setBindGroup`, a dispatch — reports its own
 * error. The console fills with messages naming the most recent victim (a population LOD bind
 * group over a dead instance buffer) instead of the cause.
 *
 * The engine's contract, pinned here:
 *
 *  - A *device-level* failure is fatal: the device was lost, or it cannot allocate (an OOM — the
 *    device is out of resources and further allocations will keep failing). `GraphicsDevice.fatal`
 *    flips, the renderer stops driving the device, `Engine.step()` halts, and the HUD tells the
 *    user to reload.
 *  - A *resource-level* failure is **not** fatal: WebGPU invalidates only the named resource; the
 *    rest of the device keeps working. The label goes into `deadResourceLabels`, and the renderer
 *    retires the dead object (the population path, whose buffers share the
 *    `population.instances` label) without halting — the frame loop, and every other demo scene,
 *    keeps rendering. A device that fails one population buffer must not take the skinning arm
 *    down with it.
 *
 * What these prove:
 *  - `fatal` flips on an uncaptured OOM/allocation error and on device loss (first reason kept);
 *    a resource error and a scoped error never flip it.
 *  - A resource error lands in `deadResourceLabels`, and the renderer retires the population on
 *    the next frame: no new buffers, no new submissions, no further errors — the cascade is cut
 *    off at the first report — while a plain mesh in the same scene keeps drawing.
 *  - `Engine.step()` halts on a fatal device, and keeps stepping on a resource error.
 */

import { describe, expect, it } from "vitest";
import {
  AABB,
  Camera,
  Engine,
  Geometry,
  GraphicsDevice,
  Material,
  PopulationInstanceBlock,
  Renderable,
  Renderer,
  Scene,
  SceneObject,
  Vec3,
  buildLodGeometry,
  createPlane,
  rockGeometrySource,
  unindexedLodWindow,
  type PopulationSource,
  type PopulationCollector,
  type PopulationSubmission,
} from "@forge/engine";

/** The exact report the real device produced in the bug report (label + invalid buffer). */
const BUG_REPORT = "GPUValidationError: Buffer with 'population.instances' label is invalid";
/** The device-level error that *causes* the cascade: the allocation itself failed. */
const OOM_REPORT = "GPUOutOfMemoryError: Allocation of 262144 bytes failed";

/** One hand-built LOD population offered every frame (the seam without terrain). */
class StaticPopulation extends SceneObject implements PopulationSource {
  readonly name = "static-population";
  constructor(private readonly submission: PopulationSubmission) {
    super();
  }
  collectPopulations(collector: PopulationCollector): void {
    collector.addPopulationBatch(this.submission);
  }
}

function lodSubmission(geometry: Geometry, material: Material, count: number): PopulationSubmission {
  const src = rockGeometrySource({ radius: 0.6, seed: 5, segments: 4 });
  const merged = buildLodGeometry({ hi: unindexedLodWindow(src), lo: unindexedLodWindow(src) });
  const block = new PopulationInstanceBlock(count);
  for (let k = 0; k < count; k++) {
    block.positions[k * 3] = k * 2 - (count - 1);
    block.positions[k * 3 + 1] = 0;
    block.positions[k * 3 + 2] = 0;
    block.scales[k * 3] = 1;
    block.scales[k * 3 + 1] = 1;
    block.scales[k * 3 + 2] = 1;
    block.rotations[k] = 0;
    block.tints[k] = 0;
    block.count = k + 1;
  }
  return {
    geometry,
    material,
    instances: block,
    bounds: new AABB(new Vec3(-(count - 1) - 1, -1, -1), new Vec3(count - 1 + 1, 1, 1)),
    castShadow: false,
    maxDistance: 0,
    lod: { hiTriangles: merged.hiTriangles, lodDistance: 8.5 },
  };
}

async function rendererFixture() {
  const device = await GraphicsDevice.create({ forceMock: true });
  device.resize(320, 180);
  const mock = device.mock;
  const renderer = new Renderer(device, { shadowMapSize: 256 });
  const scene = new Scene({ name: "device-fatal-test" });
  const cameraEntity = scene.createTransformedEntity("camera", new Vec3(0, 2, -8));
  const camera = new Camera();
  camera.far = 100;
  scene.world.addComponent(cameraEntity.id, camera);
  cameraEntity.transform.lookAt(new Vec3(0, 0, 0));
  // A plain mesh in the same scene: the control that must keep drawing while the population dies.
  const groundEntity = scene.createTransformedEntity("ground", new Vec3(0, -0.5, 0));
  const groundRenderable = new Renderable();
  groundRenderable.geometry = createPlane(device, { width: 20, depth: 20 });
  groundRenderable.material = new Material({ label: "ground-mat", color: 0x334455, roughness: 0.8 });
  groundRenderable.castShadow = false;
  scene.world.addComponent(groundEntity.id, groundRenderable);
  return {
    device,
    mock,
    renderer,
    scene,
    async dispose() {
      renderer.dispose();
      scene.dispose();
      await device.dispose();
    },
  };
}

describe("GraphicsDevice fatal state", () => {
  it("is not fatal while healthy", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    expect(device.fatal).toBe(false);
    expect(device.fatalReason).toBeNull();
    expect(device.lost).toBe(false);
    await device.dispose();
  });

  it("flips fatal on an uncaptured out-of-memory error and keeps the first reason", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const mock = device.mock;

    mock.reportUncapturedError(OOM_REPORT);
    expect(device.fatal).toBe(true);
    expect(device.lost).toBe(false);
    const first = device.fatalReason;
    expect(first).toContain("Allocation of 262144 bytes failed");

    // Later reports (the cascade a real device would produce) do not change the first reason.
    mock.reportUncapturedError(BUG_REPORT);
    expect(device.fatalReason).toBe(first);
    await device.dispose();
  });

  it("flips fatal when the message names the device as lost", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const mock = device.mock;

    mock.reportUncapturedError("GPUValidationError: Parent device is lost");
    expect(device.fatal).toBe(true);
    expect(device.fatalReason).toContain("device is lost");
    await device.dispose();
  });

  it("flips fatal on device loss with the lost reason", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const mock = device.mock;

    mock.lose("out-of-memory");
    // The lost promise resolves on a microtask; flush before asserting.
    await new Promise((r) => setTimeout(r, 0));
    expect(device.lost).toBe(true);
    expect(device.fatal).toBe(true);
    // `reason` is the spec enum; the mock's driver message carries the detail.
    expect(device.fatalReason).toBe("device lost (uncaptured-error: out-of-memory)");
    await device.dispose();
  });

  it("routes a resource error to the dead-resource set instead of the fatal flag", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const mock = device.mock;

    // The reported bug: one buffer failed allocation. WebGPU kills that buffer, not the device.
    mock.reportUncapturedError(BUG_REPORT);
    expect(device.fatal).toBe(false);
    expect(device.fatalReason).toBeNull();
    expect(device.isResourceDead("population.instances")).toBe(true);
    expect([...device.deadResourceLabels]).toContain("population.instances");
    expect(device.isResourceDead("skin.palettes")).toBe(false);
    await device.dispose();
  });

  it("does not flip fatal for an error the engine captured in an error scope", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const mock = device.mock;

    device.beginErrorScope();
    mock.reportUncapturedError(OOM_REPORT);
    const captured = await device.endErrorScope();
    expect(captured).toContain("Allocation of 262144 bytes failed");
    expect(device.fatal).toBe(false);
    expect(device.fatalReason).toBeNull();
    expect(device.deadResourceLabels.size).toBe(0);
    await device.dispose();
  });
});

describe("renderer retires a dead population without halting", () => {
  it("stops driving the dead buffer, keeps the rest of the scene, appends no errors", async () => {
    const f = await rendererFixture();
    const src = rockGeometrySource({ radius: 0.6, seed: 5, segments: 4 });
    const merged = buildLodGeometry({ hi: unindexedLodWindow(src), lo: unindexedLodWindow(src) });
    const geometry = Geometry.create(f.device, merged.source);
    const material = new Material({ label: "rock", color: 0x886655 });
    f.scene.add(new StaticPopulation(lodSubmission(geometry, material, 5)));

    // Frame 1: the LOD population draws through its own buffer and compute group.
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(f.renderer.stats.populationLodBatches).toBe(1);
    expect(f.renderer.stats.populationBuffers).toBe(1);
    const buffersBefore = [...f.mock.liveBuffers].filter((b) => b.label === "population.instances");
    expect(buffersBefore.length).toBe(1);
    const createdBefore = f.mock.created.buffer ?? 0;
    const submitsBefore = f.mock.submitCount;

    // The device fails the way the bug report's device did: a report naming the dead buffer.
    // That is a *resource* error — the device itself keeps working.
    f.mock.reportUncapturedError(BUG_REPORT);
    expect(f.device.fatal).toBe(false);
    expect(f.device.isResourceDead("population.instances")).toBe(true);

    // Frame 2 retires the dead population: the record is destroyed, no new buffer is probed, and
    // — the whole point — no further errors are appended to the one that named the cause.
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([BUG_REPORT]);
    expect(f.mock.created.buffer ?? 0).toBe(createdBefore);
    expect(f.renderer.stats.populationLodBatches).toBe(0);
    expect(f.renderer.stats.populationBuffers).toBe(0);
    expect([...f.mock.liveBuffers].filter((b) => b.label === "population.instances")).toHaveLength(0);
    // The rest of the scene (the ground) still drew: submissions did not collapse to the
    // population's share.
    expect(f.renderer.stats.drawCalls).toBeGreaterThanOrEqual(1);
    expect(f.mock.submitCount).toBeGreaterThanOrEqual(submitsBefore);

    // Frame 3 stays just as quiet — no re-probe of the dead buffer class.
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([BUG_REPORT]);
    expect(f.mock.created.buffer ?? 0).toBe(createdBefore);
    expect(f.renderer.stats.populationBuffers).toBe(0);

    geometry.dispose();
    material.dispose();
    await f.dispose();
  });

  it("keeps a healthy device rendering population (no false retirement)", async () => {
    const f = await rendererFixture();
    const src = rockGeometrySource({ radius: 0.6, seed: 5, segments: 4 });
    const merged = buildLodGeometry({ hi: unindexedLodWindow(src), lo: unindexedLodWindow(src) });
    const geometry = Geometry.create(f.device, merged.source);
    const material = new Material({ label: "rock", color: 0x886655 });
    f.scene.add(new StaticPopulation(lodSubmission(geometry, material, 3)));

    f.renderer.renderScene(f.scene);
    f.renderer.renderScene(f.scene);
    expect(f.device.fatal).toBe(false);
    expect(f.mock.errors).toEqual([]);
    expect(f.renderer.stats.populationLodBatches).toBe(1);
    expect(f.renderer.stats.populationBuffers).toBe(1);

    geometry.dispose();
    material.dispose();
    await f.dispose();
  });
});

describe("Engine halts only on a device-level failure", () => {
  it("stops rendering on an OOM and reports deviceFatal", async () => {
    const engine = await Engine.create({ forceMock: true });
    const mock = engine.gpu.mock;
    const scene = new Scene({ name: "fatal-engine-test" });
    const cameraEntity = scene.createTransformedEntity("camera", new Vec3(0, 3, -8));
    const camera = new Camera();
    camera.far = 100;
    scene.world.addComponent(cameraEntity.id, camera);
    cameraEntity.transform.lookAt(new Vec3(0, 0, 0));
    const groundEntity = scene.createTransformedEntity("ground", new Vec3(0, -1, 0));
    const groundRenderable = new Renderable();
    groundRenderable.geometry = createPlane(engine.gpu, { width: 20, depth: 20 });
    groundRenderable.material = new Material({ label: "ground-mat", color: 0x334455, roughness: 0.8 });
    groundRenderable.castShadow = false;
    scene.world.addComponent(groundEntity.id, groundRenderable);
    engine.setScene(scene);

    engine.step(1 / 60);
    expect(engine.gpu.fatal).toBe(false);
    expect(engine.stats().deviceFatal).toBe(false);
    const submitsBefore = mock.submitCount;

    mock.reportUncapturedError(OOM_REPORT);
    engine.step(1 / 60);
    expect(engine.gpu.fatal).toBe(true);
    expect(engine.stats().deviceFatal).toBe(true);
    // The halted frame renders nothing: no new submissions on the dead device.
    expect(mock.submitCount).toBe(submitsBefore);
    expect(engine.stats().lastError).toContain("Allocation of 262144 bytes failed");

    await engine.dispose();
  });

  it("keeps rendering when only a resource is dead", async () => {
    const engine = await Engine.create({ forceMock: true });
    const mock = engine.gpu.mock;
    const scene = new Scene({ name: "resource-dead-engine-test" });
    const cameraEntity = scene.createTransformedEntity("camera", new Vec3(0, 3, -8));
    const camera = new Camera();
    camera.far = 100;
    scene.world.addComponent(cameraEntity.id, camera);
    cameraEntity.transform.lookAt(new Vec3(0, 0, 0));
    const groundEntity = scene.createTransformedEntity("ground", new Vec3(0, -1, 0));
    const groundRenderable = new Renderable();
    groundRenderable.geometry = createPlane(engine.gpu, { width: 20, depth: 20 });
    groundRenderable.material = new Material({ label: "ground-mat", color: 0x334455, roughness: 0.8 });
    groundRenderable.castShadow = false;
    scene.world.addComponent(groundEntity.id, groundRenderable);
    engine.setScene(scene);

    engine.step(1 / 60);
    const submitsBefore = mock.submitCount;

    // The bug report's message: one population buffer died. The device — and every demo scene
    // that does not touch that buffer — must keep running.
    mock.reportUncapturedError(BUG_REPORT);
    expect(engine.gpu.fatal).toBe(false);
    expect(engine.stats().deviceFatal).toBe(false);

    engine.step(1 / 60);
    expect(engine.stats().deviceFatal).toBe(false);
    expect(mock.submitCount).toBeGreaterThan(submitsBefore);
    expect(engine.stats().lastError).toContain("population.instances");

    await engine.dispose();
  });
});
