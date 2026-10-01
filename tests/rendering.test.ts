/**
 * Tests for Renderer and scene rendering over the mock WebGPU device.
 *
 * Verifies that Renderer.renderScene produces correct draw calls, exercises
 * shadow and color passes, respects frustum culling, records zero WebGPU
 * validation errors, and releases all GPU resources on dispose without leaks.
 */

import { describe, expect, it } from "vitest";
import {
  Camera,
  Color,
  createBox,
  createLodPrimitive,
  createPlane,
  CullReason,
  GraphicsDevice,
  Light,
  Material,
  Renderable,
  Renderer,
  rockGeometrySource,
  Scene,
  Vec3,
} from "@forge/engine";

describe("Renderer with mock WebGPU device", () => {
  it("renders a scene with camera, light, and geometry with zero validation errors", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const mock = device.mock;
    const renderer = new Renderer(device);
    const scene = new Scene({ name: "render-test" });
    scene.setBackgroundColor(Color.fromSrgbHex(0x101520));

    // Camera
    const camEntity = scene.createTransformedEntity("camera", new Vec3(0, 3, -8));
    const camera = new Camera();
    camera.fovY = Math.PI / 3;
    camera.near = 0.1;
    camera.far = 100;
    scene.world.addComponent(camEntity.id, camera);
    camEntity.transform.lookAt(new Vec3(0, 0, 0));

    // Directional light (shadow caster)
    const sunEntity = scene.createTransformedEntity("sun", new Vec3(5, 10, -5));
    const sun = new Light();
    sun.kind = "directional";
    sun.intensity = 2.0;
    sun.castShadow = true;
    scene.world.addComponent(sunEntity.id, sun);
    sunEntity.transform.lookAt(new Vec3(0, 0, 0));

    // Ground plane
    const groundEntity = scene.createTransformedEntity("ground", new Vec3(0, 0, 0));
    const groundMesh = createPlane(device, { width: 20, depth: 20 });
    const groundMat = new Material({ label: "ground-mat", color: 0x334455, roughness: 0.8 });
    const groundRenderable = new Renderable();
    groundRenderable.geometry = groundMesh;
    groundRenderable.material = groundMat;
    groundRenderable.castShadow = false;
    scene.world.addComponent(groundEntity.id, groundRenderable);

    // Box
    const boxEntity = scene.createTransformedEntity("cube", new Vec3(0, 1, 0));
    const boxMesh = createBox(device, { width: 1.5, height: 1.5, depth: 1.5 });
    const boxMat = new Material({ label: "cube-mat", color: 0xff4422, roughness: 0.4 });
    const boxRenderable = new Renderable();
    boxRenderable.geometry = boxMesh;
    boxRenderable.material = boxMat;
    boxRenderable.castShadow = true;
    scene.world.addComponent(boxEntity.id, boxRenderable);

    // Render frame
    renderer.renderScene(scene);

    // Assertions on frame execution
    expect(renderer.stats.drawCalls).toBeGreaterThanOrEqual(1);
    expect(renderer.stats.triangles).toBeGreaterThanOrEqual(12);
    expect(mock.drawCalls).toBeGreaterThanOrEqual(1);
    expect(mock.errors).toHaveLength(0);
    mock.assertClean();

    // Default settings: HDR on, three cascades, depth prepass + SSAO. The frame is one shadow pass
    // per cascade, the depth prepass, the SSAO estimate and its two blur passes, the forward pass
    // into the HDR target and the tonemap resolve into the swapchain (the 1x1 mock surface is too
    // small for a bloom chain, so none is declared).
    const passLabels = mock.passes.map((p) => p.label);
    expect(passLabels).toEqual([
      "forge.shadow.0",
      "forge.shadow.1",
      "forge.shadow.2",
      "forge.prepass",
      "forge.ssao",
      "forge.ssao.blur.h",
      "forge.ssao.blur.v",
      "forge.main",
      "forge.tonemap",
    ]);
    expect(renderer.passNames).toEqual(passLabels);
    expect(renderer.stats.shadowCascades).toBe(3);
    expect(renderer.stats.shadowsDrawn).toBe(3); // the cube, once per cascade (the ground does not cast)
    expect(renderer.stats.hdr).toBe(true);
    expect(mock.passes[0]!.depthTarget).toContain("depth24plus");
    expect(renderer.stats.depthPrepass).toBe(true);
    expect(renderer.stats.ssao).toBe(true);
    expect(mock.passes[7]!.colorTargets[0]).toContain("rgba16float");
    expect(mock.passes[8]!.colorTargets[0]).toBe("swapchain");

    // Clean teardown and leak check
    scene.dispose();
    renderer.dispose();
    groundMesh.dispose();
    groundMat.dispose();
    boxMesh.dispose();
    boxMat.dispose();
    await device.dispose();

    expect(mock.outstanding.buffers).toHaveLength(0);
    expect(mock.outstanding.textures).toHaveLength(0);
  });

  it("camera and light lookAt reach the frame: view faces the target, sun direction points at it", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const renderer = new Renderer(device);
    const scene = new Scene({ name: "lookat" });

    const camEntity = scene.createTransformedEntity("camera", new Vec3(0, 3.4, -9.5));
    const camera = new Camera();
    scene.world.addComponent(camEntity.id, camera);
    camEntity.transform.lookAt(new Vec3(0, 0.8, 0));

    const sunEntity = scene.createTransformedEntity("sun", new Vec3(7, 13, -7));
    const sun = new Light();
    scene.world.addComponent(sunEntity.id, sun);
    sunEntity.transform.lookAt(new Vec3(0, 0, 0));

    const boxEntity = scene.createTransformedEntity("cube", new Vec3(0, 0.9, 0));
    const box = new Renderable();
    box.geometry = createBox(device);
    box.material = new Material({ label: "m", color: 0xffffff });
    scene.world.addComponent(boxEntity.id, box);

    renderer.renderScene(scene);

    // The cube sits at the camera's target: it must be in front of the camera, centred, not culled.
    const inView = camera.view.transformPoint(new Vec3(0, 0.8, 0), new Vec3());
    expect(Math.abs(inView.x)).toBeLessThan(1e-4);
    expect(Math.abs(inView.y)).toBeLessThan(1e-4);
    expect(inView.z).toBeCloseTo(Math.hypot(3.4 - 0.8, 9.5), 3);
    expect(renderer.stats.culled).toBe(0);
    expect(renderer.stats.drawCalls).toBeGreaterThanOrEqual(1);

    // The light's travel direction is from the sun toward its lookAt target (downward, toward -X/+Z).
    const expected = new Vec3(-7, -13, 7).normalize();
    expect(sun.direction.x).toBeCloseTo(expected.x, 4);
    expect(sun.direction.y).toBeCloseTo(expected.y, 4);
    expect(sun.direction.z).toBeCloseTo(expected.z, 4);

    scene.dispose();
    renderer.dispose();
    box.geometry.dispose();
    box.material.dispose();
    await device.dispose();
  });

  it("derives camera projection aspect ratio from device surface when aspectOverride is 0", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    device.resize(800, 600);
    expect(device.aspect).toBeCloseTo(4 / 3, 5);

    const renderer = new Renderer(device);
    const scene = new Scene({ name: "aspect-test" });

    const camEntity = scene.createTransformedEntity("camera", new Vec3(0, 0, -5));
    const camera = new Camera();
    camera.fovY = Math.PI / 3;
    expect(camera.aspectOverride).toBe(0);
    scene.world.addComponent(camEntity.id, camera);
    camEntity.transform.lookAt(new Vec3(0, 0, 0));

    renderer.renderScene(scene);

    // In setPerspective, m[0] = f / aspect and m[5] = f, so m[5] / m[0] == aspect
    const computedAspect = camera.projection.m[5]! / camera.projection.m[0]!;
    expect(computedAspect).toBeCloseTo(4 / 3, 4);

    scene.dispose();
    renderer.dispose();
    await device.dispose();
  });

  it("handles empty scenes by clearing the frame without errors", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const mock = device.mock;
    const renderer = new Renderer(device);
    const scene = new Scene({ name: "empty-scene" });

    // Render empty scene (no camera or entities)
    renderer.renderScene(scene);
    expect(renderer.stats.drawCalls).toBe(0);
    mock.assertClean();

    scene.dispose();
    renderer.dispose();
    await device.dispose();
    expect(mock.outstanding.buffers).toHaveLength(0);
    expect(mock.outstanding.textures).toHaveLength(0);
  });

  it("culls objects outside the camera frustum", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const mock = device.mock;
    const renderer = new Renderer(device);
    const scene = new Scene({ name: "cull-scene" });

    const camEntity = scene.createTransformedEntity("camera", new Vec3(0, 0, -10));
    const camera = new Camera();
    scene.world.addComponent(camEntity.id, camera);
    camEntity.transform.lookAt(new Vec3(0, 0, 0));

    // In front of camera
    const inFront = scene.createTransformedEntity("in-front", new Vec3(0, 0, 0));
    const boxMesh = createBox(device, { width: 1, height: 1, depth: 1 });
    const mat = new Material({ label: "mat", color: 0x00ff00 });
    const r1 = new Renderable();
    r1.geometry = boxMesh;
    r1.material = mat;
    scene.world.addComponent(inFront.id, r1);

    // Behind camera (z = -20 while camera looks towards +z from z = -10)
    const behind = scene.createTransformedEntity("behind", new Vec3(0, 0, -20));
    const r2 = new Renderable();
    r2.geometry = boxMesh;
    r2.material = mat;
    scene.world.addComponent(behind.id, r2);

    renderer.renderScene(scene);

    expect(renderer.stats.culled).toBeGreaterThanOrEqual(1);
    expect(r1.isVisible).toBe(true);
    expect(r2.isVisible).toBe(false);
    mock.assertClean();

    scene.dispose();
    renderer.dispose();
    boxMesh.dispose();
    mat.dispose();
    await device.dispose();
    expect(mock.outstanding.buffers).toHaveLength(0);
    expect(mock.outstanding.textures).toHaveLength(0);
  });

  it("draws debug lines and releases debug buffers on dispose", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const mock = device.mock;
    const renderer = new Renderer(device);
    const scene = new Scene({ name: "debug-scene" });

    const camEntity = scene.createTransformedEntity("camera", new Vec3(0, 0, -5));
    const camera = new Camera();
    scene.world.addComponent(camEntity.id, camera);
    camEntity.transform.lookAt(new Vec3(0, 0, 0));

    renderer.drawLine(new Vec3(0, 0, 0), new Vec3(1, 1, 1), 0xff00ff00);
    renderer.renderScene(scene);

    expect(renderer.stats.debugLines).toBe(1);
    mock.assertClean();

    scene.dispose();
    renderer.dispose();
    await device.dispose();
    expect(mock.outstanding.buffers).toHaveLength(0);
    expect(mock.outstanding.textures).toHaveLength(0);
  });

  it("debugBounds draws AABBs for in-view AND frustum-culled renderables, and cleans up", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const mock = device.mock;
    const renderer = new Renderer(device);
    const scene = new Scene({ name: "bounds-scene" });

    const camEntity = scene.createTransformedEntity("camera", new Vec3(0, 0, -10));
    const camera = new Camera();
    scene.world.addComponent(camEntity.id, camera);
    camEntity.transform.lookAt(new Vec3(0, 0, 0));

    const boxMesh = createBox(device, { width: 1, height: 1, depth: 1 });
    const mat = new Material({ label: "mat", color: 0x00ff00 });
    const inFront = scene.createTransformedEntity("in-front", new Vec3(0, 0, 0));
    const r1 = new Renderable();
    r1.geometry = boxMesh;
    r1.material = mat;
    scene.world.addComponent(inFront.id, r1);
    // Behind the camera: frustum-culled, but the bounds overlay must still mark where it sits.
    const behind = scene.createTransformedEntity("behind", new Vec3(0, 0, -30));
    const r2 = new Renderable();
    r2.geometry = boxMesh;
    r2.material = mat;
    scene.world.addComponent(behind.id, r2);

    renderer.debugBounds = true;
    renderer.renderScene(scene);
    expect(renderer.stats.debugBounds).toBe(2);

    renderer.debugBounds = false;
    renderer.renderScene(scene);
    expect(renderer.stats.debugBounds).toBe(0);
    mock.assertClean();

    scene.dispose();
    renderer.dispose();
    boxMesh.dispose();
    mat.dispose();
    await device.dispose();
    expect(mock.outstanding.buffers).toHaveLength(0);
    expect(mock.outstanding.textures).toHaveLength(0);
  });
});

/**
 * Phase 14.4 at the renderer level: the LOD a batch draws is the level its own distance selects, in
 * *every* pass that draws it.
 *
 * The reason this is a renderer test and not only a culler test is the failure it guards against. The
 * device picks the level inside the indirect record, but the depth prepass and the shadow passes draw
 * directly, before any record exists: if they kept drawing level 0 while the main pass drew a coarser
 * level, the coarse surface would sit behind the finer prepass depth and — with the engine's
 * `less-equal` depth compare — be rejected, punching holes in the picture. So the renderer mirrors the
 * selection with the same pure rule the pass uses, and these cases check the mirror reaches the draws:
 * the prepass's own `drawIndexed` arguments, the twin's record words, and the frame's triangle count
 * must all say the same level.
 */
describe("Renderer LOD selection (14.4)", () => {
  /** A three-level rock chain: 864 / 294 / 96 indices, switching at 40 m and 120 m. */
  const SEGMENTS = [12, 7, 4];
  const DISTANCES = [40, 120];
  const WINDOWS = [
    { firstIndex: 0, indexCount: 864 },
    { firstIndex: 864, indexCount: 294 },
    { firstIndex: 1158, indexCount: 96 },
  ];
  /** The sky's fullscreen triangle is in every frame's count, so the rock's own is one short of it. */
  const SKY_TRIANGLES = 1;

  async function fixture(cameraZ: number, objectCulling: "cpu" | "gpu" = "cpu") {
    const device = await GraphicsDevice.create({ forceMock: true });
    device.resize(320, 180);
    const mock = device.mock;
    // "cpu" is the mock's default and runs the twin, so the records and `cullLodReduced` are this
    // frame's; "gpu" drives the real culler (which the mock validates but does not execute), so it is
    // the arm that shows the chain being registered with the device.
    const renderer = new Renderer(device, { shadowMapSize: 256, objectCulling });
    const scene = new Scene({ name: "lod-renderer" });
    const camEntity = scene.createTransformedEntity("camera", new Vec3(0, 0, cameraZ));
    const camera = new Camera();
    camera.fovY = Math.PI / 3;
    camera.near = 0.1;
    camera.far = 600;
    scene.world.addComponent(camEntity.id, camera);
    camEntity.transform.lookAt(new Vec3(0, 0, 0));
    const geometry = createLodPrimitive(device, {
      build: (level) => rockGeometrySource({ radius: 1, segments: SEGMENTS[level]!, seed: 3 }),
      levels: SEGMENTS.length,
      distances: DISTANCES,
    });
    const material = new Material({ label: "lod-rock", color: 0x887766, roughness: 0.9 });
    const rockEntity = scene.createTransformedEntity("rock", new Vec3(0, 0, 0));
    const renderable = new Renderable();
    renderable.geometry = geometry;
    renderable.material = material;
    renderable.castShadow = false;
    scene.world.addComponent(rockEntity.id, renderable);
    return {
      device,
      mock,
      renderer,
      scene,
      camEntity,
      geometry,
      material,
      renderable,
      async dispose() {
        renderer.dispose();
        material.dispose();
        geometry.dispose();
        scene.dispose();
        await device.dispose();
        expect(mock.outstanding.buffers).toEqual([]);
        expect(mock.outstanding.textures).toEqual([]);
      },
    };
  }

  /** The windows the frame's *direct* draws used (the prepass and the shadow passes). */
  function directWindows(mock: { commandLog: Record<string, unknown>[] }): { indexCount: number; firstIndex: number }[] {
    return mock.commandLog
      .filter((e) => e.type === "drawIndexed" && e["indirect"] === undefined)
      .map((e) => ({ indexCount: e["indexCount"] as number, firstIndex: e["firstIndex"] as number }));
  }

  /** The window the indirect record carries: what the main pass actually draws. */
  function recordWindow(mock: { liveBuffers: Set<{ label: string; data: ArrayBuffer }> }, batch: number): { indexCount: number; firstIndex: number } {
    const records = [...mock.liveBuffers].find((b) => b.label === "cull.drawRecords");
    if (!records) throw new Error("no cull.drawRecords buffer");
    const words = new Uint32Array(records.data);
    return { indexCount: words[batch * 8]!, firstIndex: words[batch * 8 + 2]! };
  }

  it("draws the finest level up close, in the prepass and the record alike", async () => {
    const f = await fixture(-10); // 10 m from the rock at the origin
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    // The chain is registered once, and this frame's batches all read it.
    expect(f.renderer.stats.lodSets).toBe(1);
    expect(f.renderer.stats.lodBatches).toBe(1);
    expect(f.renderer.stats.cullLodReduced).toBe(0);
    expect(f.renderer.stats.triangles).toBe(WINDOWS[0]!.indexCount / 3 + SKY_TRIANGLES);
    expect(recordWindow(f.mock, 0)).toEqual(WINDOWS[0]!);
    expect(directWindows(f.mock)).toContainEqual(WINDOWS[0]!);
    // A chain's own primary window is level 0, which is what a pass with no record falls back to.
    expect(f.geometry.drawStart).toBe(WINDOWS[0]!.firstIndex);
    expect(f.geometry.drawCount).toBe(WINDOWS[0]!.indexCount);
    await f.dispose();
  });

  it("drops to the coarsest level past the last threshold, in every pass that draws it", async () => {
    const f = await fixture(-140); // 140 m out: past the 120 m threshold
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(f.renderer.stats.lodSets).toBe(1);
    expect(f.renderer.stats.lodBatches).toBe(1);
    // The frame's own report: one batch drew a coarser level than the CPU's default.
    expect(f.renderer.stats.cullLodReduced).toBe(1);
    expect(f.renderer.stats.triangles).toBe(WINDOWS[2]!.indexCount / 3 + SKY_TRIANGLES);
    const record = recordWindow(f.mock, 0);
    expect(record).toEqual(WINDOWS[2]!);
    // The prepass drew the *same* level: had it drawn level 0, its finer depth would have rejected
    // the coarse surface the main pass shades, and the rock would have holes in it.
    const direct = directWindows(f.mock);
    expect(direct).toContainEqual(WINDOWS[2]!);
    expect(direct.some((w) => w.indexCount === WINDOWS[0]!.indexCount)).toBe(false);
    await f.dispose();
  });

  it("steps through the middle level between the two thresholds", async () => {
    const f = await fixture(-60); // 60 m: past 40, short of 120
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(f.renderer.stats.cullLodReduced).toBe(1);
    expect(recordWindow(f.mock, 0)).toEqual(WINDOWS[1]!);
    expect(directWindows(f.mock)).toContainEqual(WINDOWS[1]!);
    expect(f.renderer.stats.triangles).toBe(WINDOWS[1]!.indexCount / 3 + SKY_TRIANGLES);
    await f.dispose();
  });

  it("registers the chain with the device once and stages one set index per batch per frame", async () => {
    // The device arm: the culler owns the main pass's level, so what the renderer owes it is one
    // static table and one u32 per batch per frame. The passes that draw *directly* (the prepass, the
    // shadow maps) still need the level from the CPU mirror, and that is what this watches.
    const f = await fixture(-140, "gpu");
    for (let frame = 0; frame < 3; frame++) {
      f.renderer.renderScene(f.scene);
      expect(f.mock.errors).toEqual([]);
    }
    const tableWrites = () => f.mock.commandLog.filter((e) => e.type === "writeBuffer" && e["buffer"] === "objects.lodSets").length;
    const indexWrites = () => f.mock.commandLog.filter((e) => e.type === "writeBuffer" && e["buffer"] === "objects.batchLods").length;
    // Three frames, one table upload: the chain is static geometry, and rewriting it per frame would
    // be exactly the cost device LOD exists to remove. The per-batch indices are the per-frame part.
    expect(tableWrites()).toBe(1);
    expect(indexWrites()).toBe(3);
    expect(f.renderer.stats.lodSets).toBe(1);
    expect(f.renderer.stats.lodBatches).toBe(1);
    // The batch's set index is the table's first entry: one chain, one set, batch 0 points at it.
    const batchLods = [...f.mock.liveBuffers].find((b) => b.label === "objects.batchLods")!;
    expect(new Uint32Array(batchLods.data, 0, 1)[0]).toBe(0);
    // The prepass followed the mirror down to the coarsest level (140 m is past both thresholds).
    expect(directWindows(f.mock)).toContainEqual(WINDOWS[2]!);
    expect(directWindows(f.mock).some((w) => w.indexCount === WINDOWS[0]!.indexCount)).toBe(false);
    // The record's window is the mirror's answer, uploaded as the default: the pass overwrites those
    // two words with its own identical decision, so a batch the pass never reaches — past
    // MAX_CULLED_BATCHES, or a frame whose pass did not run — still draws the level its distance
    // asked for rather than the finest one. The mock executes no WGSL, so this is the default showing.
    expect(recordWindow(f.mock, 0)).toEqual(WINDOWS[2]!);
    await f.dispose();
  });

  it("hands the passes before the cull pass the distance verdict it will reach, in both modes", async () => {
    // `forge.objects.cull` runs after the shadow maps and the depth prepass — its occlusion test reads
    // the pyramid the prepass depth is reduced into — and both of those read the visibility words to
    // collapse a rejected batch in the vertex stage. In the device arm those words were the host's
    // zeros until the pass wrote them, so a batch the pass was about to reject still wrote prepass
    // depth, and depth the sky is rejected against while `forge.main` never shades it is a dark speck
    // on the horizon: 418 of them over the terrain demo, which is how this was found. 140 m against a
    // 50 m limit is far past the host's margin, so the host can state it before the frame is recorded.
    const verdict = async (objectCulling: "cpu" | "gpu") => {
      const f = await fixture(-140, objectCulling);
      f.renderable.maxDistance = 50;
      f.renderer.renderScene(f.scene);
      expect(f.mock.errors).toEqual([]);
      const buffer = [...f.mock.liveBuffers].find((b) => b.label === "cull.visibility")!;
      const words = [...new Uint32Array(buffer.data, 0, Math.max(1, f.renderer.stats.batches))];
      await f.dispose();
      return words;
    };
    expect(await verdict("gpu")).toEqual([CullReason.Distance]);
    // The twin reaches the same verdict on its own, which is the point: the two arms now hand the
    // prepass and the shadow maps the same words, so they draw the same frame.
    expect(await verdict("cpu")).toEqual([CullReason.Distance]);
  });

  it("leaves a geometry without a chain exactly as it was", async () => {
    // The overwhelming majority of geometries are single-level: they must not pay for the feature,
    // and their draws must not change.
    const device = await GraphicsDevice.create({ forceMock: true });
    device.resize(320, 180);
    const mock = device.mock;
    const renderer = new Renderer(device, { shadowMapSize: 256 });
    const scene = new Scene({ name: "no-lod" });
    const camEntity = scene.createTransformedEntity("camera", new Vec3(0, 0, -140));
    const camera = new Camera();
    camera.fovY = Math.PI / 3;
    camera.near = 0.1;
    camera.far = 600;
    scene.world.addComponent(camEntity.id, camera);
    camEntity.transform.lookAt(new Vec3(0, 0, 0));
    const geometry = createBox(device, { width: 2, height: 2, depth: 2 });
    const material = new Material({ label: "plain", color: 0x446688 });
    const entity = scene.createTransformedEntity("box", new Vec3(0, 0, 0));
    const renderable = new Renderable();
    renderable.geometry = geometry;
    renderable.material = material;
    scene.world.addComponent(entity.id, renderable);

    renderer.renderScene(scene);
    expect(mock.errors).toEqual([]);
    expect(geometry.lods).toBeNull();
    expect(renderer.stats.lodSets).toBe(0);
    expect(renderer.stats.lodBatches).toBe(0);
    expect(renderer.stats.cullLodReduced).toBe(0);
    expect(renderer.stats.triangles).toBe(12 + SKY_TRIANGLES);
    expect(recordWindow(mock, 0)).toEqual({ indexCount: 36, firstIndex: 0 });
    // No table buffer at all: nothing was registered, so nothing was allocated or uploaded.
    expect([...mock.liveBuffers].some((b) => b.label === "objects.lodSets")).toBe(false);
    renderer.dispose();
    material.dispose();
    geometry.dispose();
    scene.dispose();
    await device.dispose();
    expect(mock.outstanding.buffers).toEqual([]);
  });
});
