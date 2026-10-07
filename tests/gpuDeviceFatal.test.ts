/**
 * Device failure handling: the "Buffer with 'population.instances' label is invalid" bug.
 *
 * Real WebGPU never throws from `createBuffer`/`createTexture` when an *allocation* fails: the
 * device reports an error and returns the resource in an invalid state (wgpu: `Buffer::invalid`),
 * so every later use of it — a `createBindGroup`, a `setBindGroup`, a dispatch — reports its own
 * error. The console fills with messages naming the most recent victim (a population LOD bind
 * group over a dead instance buffer) instead of the cause (the device ran out of resources), and
 * each frame the engine drives the dead device harder.
 *
 * What these prove:
 *  - `GraphicsDevice.fatal` flips on the first *uncaptured* device error (the browser's
 *    `uncapturederror` event) and on device loss, keeping the first reason; an error the engine
 *    deliberately captures in an error scope does not.
 *  - The renderer stops driving the device once it is fatal: a frame that would have streamed a
 *    new population chunk allocates nothing, submits nothing, and appends no further errors —
 *    the cascade is cut off at the first report.
 *  - `Engine.step()` halts rendering on a fatal device and exposes `stats().deviceFatal` so the
 *    HUD can tell the user to reload.
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
  Renderer,
  Scene,
  SceneObject,
  Vec3,
  buildLodGeometry,
  rockGeometrySource,
  unindexedLodWindow,
  type PopulationSource,
  type PopulationCollector,
  type PopulationSubmission,
} from "@forge/engine";

/** The exact report the real device produced in the bug report (label + invalid buffer). */
const BUG_REPORT = "GPUValidationError: Buffer with 'population.instances' label is invalid";

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

  it("flips fatal on the first uncaptured device error and keeps the first reason", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const mock = device.mock;

    mock.reportUncapturedError(BUG_REPORT);
    expect(device.fatal).toBe(true);
    expect(device.lost).toBe(false);
    const first = device.fatalReason;
    expect(first).toContain("population.instances");

    // Later reports (the cascade a real device would produce) do not change the first reason.
    mock.reportUncapturedError("GPUValidationError: BindGroup with 'population.lod.group' label is invalid");
    expect(device.fatalReason).toBe(first);
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

  it("does not flip fatal for an error the engine captured in an error scope", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const mock = device.mock;

    device.beginErrorScope();
    mock.reportUncapturedError("scoped error, handled by the caller");
    const captured = await device.endErrorScope();
    expect(captured).toContain("scoped error");
    expect(device.fatal).toBe(false);
    expect(device.fatalReason).toBeNull();
    await device.dispose();
  });
});

describe("renderer halts on a fatal device", () => {
  it("allocates nothing and appends no errors once the device reports an allocation failure", async () => {
    const f = await rendererFixture();
    const src = rockGeometrySource({ radius: 0.6, seed: 5, segments: 4 });
    const merged = buildLodGeometry({ hi: unindexedLodWindow(src), lo: unindexedLodWindow(src) });
    const geometry = Geometry.create(f.device, merged.source);
    const material = new Material({ label: "rock", color: 0x886655 });
    const source = new StaticPopulation(lodSubmission(geometry, material, 5));
    f.scene.add(source);

    // Frame 1: the LOD population draws through its own buffer and compute group.
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(f.renderer.stats.populationLodBatches).toBe(1);
    const buffersBefore = [...f.mock.liveBuffers].filter((b) => b.label === "population.instances");
    expect(buffersBefore.length).toBe(1);
    const createdBefore = f.mock.created.buffer ?? 0;
    const submitsBefore = f.mock.submitCount;

    // The device fails the way the bug report's device did: a report naming the dead buffer.
    f.mock.reportUncapturedError(BUG_REPORT);
    expect(f.device.fatal).toBe(true);

    // Frame 2 must not drive the dead device at all: no new buffers, no new submissions, and —
    // the whole point — no further errors appended to the one that named the cause.
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([BUG_REPORT]);
    expect(f.mock.created.buffer ?? 0).toBe(createdBefore);
    expect(f.mock.submitCount).toBe(submitsBefore);
    const buffersAfter = [...f.mock.liveBuffers].filter((b) => b.label === "population.instances");
    expect(buffersAfter.length).toBe(1);
    expect(buffersAfter[0]).toBe(buffersBefore[0]);

    // A third frame stays just as quiet.
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([BUG_REPORT]);
    expect(f.mock.submitCount).toBe(submitsBefore);

    geometry.dispose();
    material.dispose();
    await f.dispose();
  });

  it("keeps a healthy device rendering (no false fatal)", async () => {
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

    geometry.dispose();
    material.dispose();
    await f.dispose();
  });
});

describe("Engine.step halts on a fatal device", () => {
  it("stops rendering and reports deviceFatal", async () => {
    const engine = await Engine.create({ forceMock: true });
    const mock = engine.gpu.mock;
    const scene = new Scene({ name: "fatal-engine-test" });
    const cameraEntity = scene.createTransformedEntity("camera", new Vec3(0, 3, -8));
    const camera = new Camera();
    camera.far = 100;
    scene.world.addComponent(cameraEntity.id, camera);
    cameraEntity.transform.lookAt(new Vec3(0, 0, 0));
    engine.setScene(scene);

    engine.step(1 / 60);
    expect(engine.gpu.fatal).toBe(false);
    expect(engine.stats().deviceFatal).toBe(false);
    const submitsBefore = mock.submitCount;

    mock.reportUncapturedError(BUG_REPORT);
    engine.step(1 / 60);
    expect(engine.gpu.fatal).toBe(true);
    expect(engine.stats().deviceFatal).toBe(true);
    // The halted frame renders nothing: no new submissions on the dead device.
    expect(mock.submitCount).toBe(submitsBefore);
    expect(engine.stats().lastError).toContain("population.instances");

    await engine.dispose();
  });
});
