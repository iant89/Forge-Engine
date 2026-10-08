/**
 * @suite rendering:frame
 * @group unit
 * @covers engine/src/debug/profiler.ts
 * @covers engine/src/gpu/device.ts
 * @covers engine/src/index.ts
 * @covers engine/src/math/color.ts
 * @covers engine/src/math/geometry.ts
 * @covers engine/src/math/mat.ts
 * @covers engine/src/math/vec.ts
 * @covers engine/src/rendering/clusters.ts
 * @covers engine/src/rendering/material.ts
 * @covers engine/src/rendering/objectCulling.ts
 * @covers engine/src/rendering/primitives.ts
 * @covers engine/src/rendering/renderer.ts
 * @covers engine/src/rendering/uniforms.ts
 * @covers engine/src/scene/components/index.ts
 * @covers engine/src/scene/scene.ts
 * @covers engine/src/scene/systems.ts
 * @desc Frame structure produced by Renderer over the mock device (docs/VERIFICATION.md#tests)
 */

export const suite = {
  name: "rendering:frame",
  group: "unit",
  covers:   [
    "engine/src/debug/profiler.ts",
    "engine/src/gpu/device.ts",
    "engine/src/index.ts",
    "engine/src/math/color.ts",
    "engine/src/math/geometry.ts",
    "engine/src/math/mat.ts",
    "engine/src/math/vec.ts",
    "engine/src/rendering/clusters.ts",
    "engine/src/rendering/material.ts",
    "engine/src/rendering/objectCulling.ts",
    "engine/src/rendering/primitives.ts",
    "engine/src/rendering/renderer.ts",
    "engine/src/rendering/uniforms.ts",
    "engine/src/scene/components/index.ts",
    "engine/src/scene/scene.ts",
    "engine/src/scene/systems.ts"
  ],
  desc: "Frame structure produced by Renderer over the mock device (docs/VERIFICATION.md#tests)",
};
/**
 * Frame structure produced by `Renderer` over the mock device (docs/VERIFICATION.md#tests).
 *
 * What these prove: the scene settings select the pass chain (HDR + bloom + tonemap, LDR direct,
 * shadows on/off, the analytic sky) and each chain runs with zero validation errors; off-screen
 * casters still reach the cascades; the sky pass depth-tests against a depth buffer the main pass
 * stored (and reverts to discarding it when the sky is off); a steady frame allocates no GPU
 * textures; a resize re-plans and retires the old shapes; everything the renderer created is
 * released by dispose(). The depth prepass lays down exactly the opaque surfaces, `forge.main` loads
 * that depth and never re-writes it for them, SSAO runs only on top of it (perspective cameras, half
 * resolution, estimate target aliased into the blur result) and every switch — scene, quality
 * profile, camera — falls back to the plain chain. The mock validates attachment formats,
 * bind-group signatures, dynamic offsets and view dimensions, so "no errors" is a real statement.
 */

import assert from "node:assert/strict";
import { assertCloseTo, assertContains, assertMatchObject, assertMatches, assertNotContains, finish, group, objectContaining, test } from "selrun";
import {
  CLUSTER_COUNT,
  CLUSTER_SLICES,
  CULL_FLAG_RECORDS,
  AABB,
  Frustum,
  Mat4,
  ObjectCullUniforms,
  ObjectUniforms,
  DRAW_RECORD_BYTES,
  DRAW_RECORD_INSTANCES,
  DRAW_RECORD_WORDS,
  CullReason,
  CLUSTER_TILES_X,
  CLUSTER_TILES_Y,
  Camera,
  ClusterGridBlock,
  ClusterLightBlock,
  ClusterRangeBlock,
  ClusterRangeEntry,
  ClusterUniforms,
  Color,
  createBox,
  createPlane,
  clusterSliceFor,
  GraphicsDevice,
  Light,
  LightBlock,
  LightUniforms,
  Material,
  MAX_LIGHTS_PER_CLUSTER,
  MAX_LIGHTS_PER_FRAME,
  MAX_POINT_SHADOWS,
  MAX_SPOT_SHADOWS,
  POINT_SHADOW_FACES,
  PerFrameUniforms,
  Profiler,
  Renderable,
  Renderer,
  Scene,
  ShadowUniforms,
  Vec3,
  type RendererOptions,
  type SystemContext,
} from "@forge/engine";

/** The prepass + SSAO chain the default settings put between the shadow passes and forge.main. */
const PREPASS_SSAO = ["forge.prepass", "forge.ssao", "forge.ssao.blur.h", "forge.ssao.blur.v"] as const;

interface Fixture {
  device: GraphicsDevice;
  mock: GraphicsDevice["mock"];
  renderer: Renderer;
  scene: Scene;
  camera: Camera;
  sun: Light;
  boxGeometry: ReturnType<typeof createBox>;
  boxMaterial: Material;
  dispose(): Promise<void>;
}

async function fixture(
  options: { width?: number; height?: number; renderer?: RendererOptions; extraBoxes?: Vec3[]; boxDistance?: number; includeDefaultBox?: boolean } = {},
): Promise<Fixture> {
  const device = await GraphicsDevice.create({ forceMock: true });
  device.resize(options.width ?? 320, options.height ?? 180);
  const mock = device.mock;
  const renderer = new Renderer(device, { shadowMapSize: 256, ...options.renderer });
  const scene = new Scene({ name: "frame-test" });
  scene.setBackgroundColor(Color.fromSrgbHex(0x101520));
  scene.settings.shadow.mapSize = 256;

  const camEntity = scene.createTransformedEntity("camera", new Vec3(0, 3, -8));
  const camera = new Camera();
  camera.far = 100;
  scene.world.addComponent(camEntity.id, camera);
  camEntity.transform.lookAt(new Vec3(0, 0, 0));

  const sunEntity = scene.createTransformedEntity("sun", new Vec3(5, 10, -5));
  const sun = new Light();
  sun.kind = "directional";
  sun.castShadow = true;
  scene.world.addComponent(sunEntity.id, sun);
  sunEntity.transform.lookAt(new Vec3(0, 0, 0));

  const geometries = [createPlane(device, { width: 40, depth: 40 }), createBox(device, { width: 1.5, height: 1.5, depth: 1.5 })];
  const materials = [new Material({ label: "ground", color: 0x334455 }), new Material({ label: "box", color: 0xff8800 })];
  const ground = scene.createTransformedEntity("ground", new Vec3(0, 0, 0));
  const groundR = new Renderable();
  groundR.geometry = geometries[0]!;
  groundR.material = materials[0]!;
  groundR.castShadow = false;
  scene.world.addComponent(ground.id, groundR);
  const boxPositions = [...(options.includeDefaultBox === false ? [] : [new Vec3(0, 0.75, 0)]), ...(options.extraBoxes ?? [])];
  for (const [i, position] of boxPositions.entries()) {
    const e = scene.createTransformedEntity(`box${i}`, position);
    const r = new Renderable();
    r.geometry = geometries[1]!;
    r.material = materials[1]!;
    r.castShadow = true;
    // A draw distance the culler enforces on the device: the batch is in the frame (the CPU's own
    // visibility test said so) and the device is what drops it (Phase 13.5's distance test).
    if (options.boxDistance !== undefined) r.maxDistance = options.boxDistance;
    scene.world.addComponent(e.id, r);
  }

  return {
    device,
    mock,
    renderer,
    scene,
    camera,
    sun,
    boxGeometry: geometries[1]!,
    boxMaterial: materials[1]!,
    async dispose() {
      scene.dispose();
      renderer.dispose();
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      await device.dispose();
      assert.deepEqual(mock.outstanding.buffers, []);
      assert.deepEqual(mock.outstanding.textures, []);
    },
  };
}

const labels = (f: Fixture) => f.mock.passes.map((p) => p.label);

/** The pipeline key (`pipeline.<key>`) each draw in `pass` was issued with, in draw order. */
function drawPipelines(f: Fixture, pass: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const e of f.mock.commandLog) {
    if (e.label !== pass) continue;
    if (e.type === "setPipeline") current = String(e["pipeline"]);
    else if (e.type === "draw" || e.type === "drawIndexed") out.push(current);
  }
  return out;
}

/** The SSAO uniform block as last uploaded (the mock keeps real buffer contents). */
function ssaoUniforms(f: Fixture): { f32: Float32Array; u32: Uint32Array } {
  const buffer = [...f.mock.liveBuffers].find((b) => b.label === "ssao.uniforms");
  assert.notEqual(buffer, undefined, "ssao.uniforms buffer");
  return { f32: new Float32Array(buffer!.data), u32: new Uint32Array(buffer!.data) };
}

group("frame structure", () => {
  test("publishes asynchronous GPU render and compute timings through Renderer.stats", async () => {
    const f = await fixture({ renderer: { gpuTimestamps: true, lightCulling: "gpu", objectCulling: "cpu", shadows: false, bloom: false, ssao: false } });
    const pointEntity = f.scene.createTransformedEntity("point", new Vec3(0, 2, 1));
    const point = new Light();
    point.kind = "point";
    point.range = 12;
    point.intensity = 4;
    f.scene.world.addComponent(pointEntity.id, point);

    const profiler = new Profiler();
    profiler.beginFrame(0);
    const context = { profiler, elapsed: 0, dt: 1 / 60, frame: 0 } as unknown as SystemContext;
    f.renderer.renderScene(f.scene, context);
    profiler.endFrame({ drawCalls: f.renderer.stats.drawCalls, triangles: f.renderer.stats.triangles });
    assert.equal(f.renderer.stats.gpuTimingAvailable, true);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.ok(f.renderer.stats.gpuFrameTimeMs > 0);
    assert.equal(profiler.lastFrame()?.gpuMs, f.renderer.stats.gpuFrameTimeMs);
    assert.ok((profiler.scopeStats("lights.assign")?.gpuMs ?? 0) > 0);
    assert.ok(f.renderer.stats.gpuRenderTimeMs > 0);
    assert.ok(f.renderer.stats.gpuComputeTimeMs > 0);
    assert.equal(f.renderer.stats.gpuPassTimes.some((pass) => pass.kind === "compute" && pass.name === "lights.assign"), true);
    assert.deepEqual(f.mock.errors, []);
    await f.dispose();
  });

  test("HDR: cascades, forward pass into rgba16float, a bloom chain and the tonemap resolve", async () => {
    const f = await fixture();
    f.scene.settings.shadow.cascades = 2;
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    assert.deepEqual(labels(f), [
      "forge.shadow.0",
      "forge.shadow.1",
      ...PREPASS_SSAO,
      "forge.main",
      "forge.bloom.prefilter",
      "forge.bloom.down.2",
      "forge.bloom.down.3",
      "forge.bloom.up.2",
      "forge.bloom.up.1",
      "forge.tonemap",
    ]);
    const s = f.renderer.stats;
    assert.equal(s.hdr, true);
    assert.equal(s.bloomMips, 3); // 180 px tall → 90, 45, 22 (next would be 11 < 16)
    assert.equal(s.shadowCascades, 2);
    assert.equal(s.shadowsDrawn, 2); // one caster batch × two cascades
    assert.equal(s.prepassDraws, 2); // ground + box, depth only (not counted in drawCalls, like shadows)
    assert.equal(s.drawCalls, 2 + 3 + 6); // ground + box, three SSAO and six post fullscreen draws
    assert.equal(s.triangles, 2 + 12); // fullscreen draws are not scene geometry
    assert.equal(s.passes, 13);
    assert.equal(s.culledPasses, 0);
    // Transients: atlas, hdr, depth, 3 AO targets, 3 bloom mips — the AO estimate and the AO result
    // share one physical texture (160x90 rg16float: 4 bytes a pixel).
    assert.equal(s.transientTextures, 9);
    assert.equal(s.physicalTextures, 8);
    assert.equal(s.aliasedBytes, 160 * 90 * 4);
    const main = f.mock.passes[6]!;
    assert.equal(main.label, "forge.main");
    assertContains(main.colorTargets[0], "rgba16float");
    assertContains(main.depthTarget, "depth24plus");
    assert.deepEqual(f.mock.passes[12]!.colorTargets, ["swapchain"]);
    await f.dispose();
  });

  test("LDR: the forward pass writes the swapchain directly and no post pass exists", async () => {
    const f = await fixture();
    f.scene.settings.hdr = false;
    f.scene.settings.shadow.cascades = 1;
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    assert.deepEqual(labels(f), ["forge.shadow.0", ...PREPASS_SSAO, "forge.main"]);
    assert.deepEqual(f.mock.passes[5]!.colorTargets, ["swapchain"]);
    assert.equal(f.renderer.stats.hdr, false);
    assert.equal(f.renderer.stats.bloomMips, 0);
    await f.dispose();
  });

  test("bloom and shadows are individually switchable, and the quality profile caps the scene", async () => {
    const f = await fixture({ renderer: { shadowCascades: 2, shadowMapSize: 256 } });
    // Without the prepass the chain is exactly the pre-prepass frame (the prepass has its own suite).
    f.scene.settings.depthPrepass = false;
    f.scene.settings.shadow.cascades = 4; // asks for 4; the profile allows 2
    f.scene.settings.shadow.mapSize = 2048; // asks for 2048; the profile allows 256
    f.scene.settings.bloom.enabled = false;
    f.renderer.renderScene(f.scene);
    assert.deepEqual(labels(f), ["forge.shadow.0", "forge.shadow.1", "forge.main", "forge.tonemap"]);
    assertContains(f.mock.passes[0]!.depthTarget, "256x256x2");

    f.mock.passes.length = 0;
    f.scene.settings.shadow.enabled = false;
    f.scene.settings.bloom.enabled = true;
    f.renderer.renderScene(f.scene);
    assert.deepEqual(labels(f).filter((l) => l.startsWith("forge.shadow.")), []);
    assert.equal((labels(f).filter((l) => l.startsWith("forge.bloom."))).length, 5);
    assert.equal(f.renderer.stats.shadowCascades, 0);

    f.mock.passes.length = 0;
    f.scene.settings.shadow.enabled = true;
    f.scene.settings.postProcessing = false; // kills bloom, keeps the HDR resolve
    f.renderer.renderScene(f.scene);
    assert.deepEqual(labels(f), ["forge.shadow.0", "forge.shadow.1", "forge.main", "forge.tonemap"]);

    f.mock.passes.length = 0;
    f.sun.castShadow = false; // no caster light → no cascades, even with shadows enabled
    f.renderer.renderScene(f.scene);
    assert.deepEqual(labels(f), ["forge.main", "forge.tonemap"]);
    assert.deepEqual(f.mock.errors, []);
    await f.dispose();
  });

  test("renders spot maps after cascades and preserves spot indices on both light paths", async () => {
    const f = await fixture();
    f.scene.settings.hdr = false;
    f.scene.settings.depthPrepass = false;
    f.scene.settings.shadow.cascades = 2;
    f.scene.settings.clusteredLighting = false;
    const testSpot = addSpotLight(f, "test-spot", new Vec3(0, 4, 2));
    testSpot.innerCone = 0.5;
    testSpot.outerCone = 0.85; // renderer orders the cosine edges so WGSL never receives reversed smoothstep bounds
    f.renderer.renderScene(f.scene);

    assert.deepEqual(f.mock.errors, []);
    assert.deepEqual(labels(f), ["forge.shadow.0", "forge.shadow.1", "forge.shadow.spot.0", "forge.main"]);
    assertContains(f.mock.passes[0]!.depthTarget, "256x256x3");
    assert.ok(f.mock.passes[2]!.drawCalls > 0);
    assert.equal(f.renderer.stats.shadowCascades, 2);
    assert.equal(f.renderer.stats.spotShadowMaps, 1);

    const shadow = bufferOf(f, "shadow.uniforms");
    assert.equal(shadow.i32[ShadowUniforms.offsetOf("count") >> 2], 2);
    assert.equal(shadow.i32[ShadowUniforms.offsetOf("spotCount") >> 2], 1);
    const spotMatrix = ShadowUniforms.offsetOf("spotViewProj") >> 2;
    assert.equal(Array.from(shadow.f32.slice(spotMatrix, spotMatrix + 16)).every(Number.isFinite), true);
    const spotParams = ShadowUniforms.offsetOf("spotParams") >> 2;
    assertCloseTo(shadow.f32[spotParams], 1 / 256, 7);

    const uniformLights = bufferOf(f, "lights.uniforms");
    const uniformRecords = LightBlock.field("lights", "uniform");
    const uniformSpot = (uniformRecords.offset + uniformRecords.stride!) / 4;
    assert.equal(uniformLights.i32[uniformSpot + (LightUniforms.offsetOf("shadowIndex") >> 2)], 0);
    assertCloseTo(uniformLights.f32[uniformSpot + (LightUniforms.offsetOf("spotAngles") >> 2)], 0.85, 6);
    assertCloseTo(uniformLights.f32[uniformSpot + (LightUniforms.offsetOf("spotAngles") >> 2) + 1], 0.5, 6);

    // The same spot moves into the cluster storage block without losing its shadow slot.
    f.mock.passes.length = 0;
    f.scene.settings.clusteredLighting = true;
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    assert.deepEqual(labels(f), ["forge.shadow.0", "forge.shadow.1", "forge.shadow.spot.0", "forge.main"]);
    const clusteredLights = bufferOf(f, "cluster.lights");
    const clusterRecords = ClusterLightBlock.field("lights", "storage");
    const clusterSpot = clusterRecords.offset / 4;
    assert.equal(clusteredLights.i32[clusterSpot + (LightUniforms.offsetOf("shadowIndex") >> 2)], 0);
    assert.equal(f.renderer.stats.spotShadowMaps, 1);
    await f.dispose();
  });

  test("caps spot maps at four and supports spotlight-only shadow frames", async () => {
    const f = await fixture();
    f.scene.settings.hdr = false;
    f.scene.settings.depthPrepass = false;
    f.scene.settings.clusteredLighting = false;
    for (let i = 0; i < MAX_SPOT_SHADOWS + 1; i++) {
      addSpotLight(f, `capacity-spot-${i}`, new Vec3(0, 4, 2));
    }
    f.renderer.renderScene(f.scene);
    assert.ok(f.renderer.stats.shadowCascades > 0);
    assert.equal(f.renderer.stats.spotShadowMaps, MAX_SPOT_SHADOWS);

    // Drop the sun after the first frame: the reused cascade array must not leak its old count into a spot-only frame.
    f.mock.passes.length = 0;
    f.sun.castShadow = false;
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    assert.deepEqual(labels(f), [
      "forge.shadow.spot.0",
      "forge.shadow.spot.1",
      "forge.shadow.spot.2",
      "forge.shadow.spot.3",
      "forge.main",
    ]);
    assertContains(f.mock.passes[0]!.depthTarget, `256x256x${MAX_SPOT_SHADOWS}`);
    assert.equal(f.renderer.stats.shadowCascades, 0);
    assert.equal(f.renderer.stats.spotShadowMaps, MAX_SPOT_SHADOWS);
    const shadow = bufferOf(f, "shadow.uniforms");
    assert.equal(shadow.i32[ShadowUniforms.offsetOf("count") >> 2], 0);
    assert.equal(shadow.i32[ShadowUniforms.offsetOf("spotCount") >> 2], MAX_SPOT_SHADOWS);
    const frame = bufferOf(f, "perframe.uniforms");
    assert.equal(frame.i32[PerFrameUniforms.offsetOf("cascadeCount") >> 2], 0);
    const records = LightBlock.field("lights", "uniform");
    const lights = bufferOf(f, "lights.uniforms");
    const shadowIndexWord = LightUniforms.offsetOf("shadowIndex") >> 2;
    const strideWords = records.stride! / 4;
    for (let i = 0; i < MAX_SPOT_SHADOWS; i++) {
      assert.equal(lights.i32[records.offset / 4 + (i + 1) * strideWords + shadowIndexWord], i);
    }
    assert.equal(lights.i32[records.offset / 4 + (MAX_SPOT_SHADOWS + 1) * strideWords + shadowIndexWord], -1);
    await f.dispose();
  });

  test("renders point cube faces after cascades and preserves point indices on both light paths", async () => {
    const f = await fixture();
    f.scene.settings.hdr = false;
    f.scene.settings.depthPrepass = false;
    f.scene.settings.shadow.cascades = 2;
    f.scene.settings.clusteredLighting = false;
    const testPoint = addPointLight(f, "test-point", 0, 4, 2);
    testPoint.castShadow = true;
    f.renderer.renderScene(f.scene);

    assert.deepEqual(f.mock.errors, []);
    const faceNames = Array.from({ length: POINT_SHADOW_FACES }, (_, face) => `forge.shadow.point.0.${face}`);
    assert.deepEqual(labels(f), ["forge.shadow.0", "forge.shadow.1", ...faceNames, "forge.main"]);
    // Two cascades + one point cube (six layers) share one depth array.
    assertContains(f.mock.passes[0]!.depthTarget, `256x256x${2 + POINT_SHADOW_FACES}`);
    assert.equal(f.renderer.stats.shadowCascades, 2);
    assert.equal(f.renderer.stats.spotShadowMaps, 0);
    assert.equal(f.renderer.stats.pointShadowMaps, 1);

    const shadow = bufferOf(f, "shadow.uniforms");
    assert.equal(shadow.i32[ShadowUniforms.offsetOf("count") >> 2], 2);
    assert.equal(shadow.i32[ShadowUniforms.offsetOf("spotCount") >> 2], 0);
    assert.equal(shadow.i32[ShadowUniforms.offsetOf("pointCount") >> 2], 1);
    const pointMatrix = ShadowUniforms.offsetOf("pointViewProj") >> 2;
    assert.equal(Array.from(shadow.f32.slice(pointMatrix, pointMatrix + POINT_SHADOW_FACES * 16)).every(Number.isFinite), true);
    const pointParams = ShadowUniforms.offsetOf("pointParams") >> 2;
    assertCloseTo(shadow.f32[pointParams], 1 / 256, 7);

    // The point light sits right after the directional caster in the uniform block.
    const uniformLights = bufferOf(f, "lights.uniforms");
    const uniformRecords = LightBlock.field("lights", "uniform");
    const uniformPoint = (uniformRecords.offset + uniformRecords.stride!) / 4;
    assert.equal(uniformLights.i32[uniformPoint + (LightUniforms.offsetOf("shadowIndex") >> 2)], 0);
    assert.equal(uniformLights.i32[uniformPoint + (LightUniforms.offsetOf("kind") >> 2)], 1);

    // The same point light moves into the cluster storage block without losing its shadow slot.
    f.mock.passes.length = 0;
    f.scene.settings.clusteredLighting = true;
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    assert.deepEqual(labels(f), ["forge.shadow.0", "forge.shadow.1", ...faceNames, "forge.main"]);
    const clusteredLights = bufferOf(f, "cluster.lights");
    const clusterRecords = ClusterLightBlock.field("lights", "storage");
    const clusterPoint = clusterRecords.offset / 4;
    assert.equal(clusteredLights.i32[clusterPoint + (LightUniforms.offsetOf("shadowIndex") >> 2)], 0);
    assert.equal(f.renderer.stats.pointShadowMaps, 1);
    await f.dispose();
  });

  test("assigns each caster only to the cube faces it can reach", async () => {
    const f = await fixture();
    f.scene.settings.hdr = false;
    f.scene.settings.depthPrepass = false;
    f.scene.settings.shadow.cascades = 1;
    f.scene.settings.clusteredLighting = false;
    // Directly above the default box: the box sits entirely in the -Y octant of the light, so only
    // face 3 (-Y) may draw it; the opposite face 2 (+Y) must stay empty.
    const light = addPointLight(f, "overhead-point", 0, 3, 0);
    light.castShadow = true;
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);

    const indexOf = (name: string) => labels(f).indexOf(name);
    const downFace = f.mock.passes[indexOf("forge.shadow.point.0.3")]!;
    const upFace = f.mock.passes[indexOf("forge.shadow.point.0.2")]!;
    assert.ok(downFace.drawCalls > 0);
    assert.equal(upFace.drawCalls, 0);
    // One caster instance, assigned to exactly one face.
    assert.equal(f.renderer.stats.shadowInstancesDrawn, f.renderer.stats.shadowCascades + 1);
    await f.dispose();
  });

  test("caps point cubes at two and supports point-only shadow frames", async () => {
    const f = await fixture();
    f.scene.settings.hdr = false;
    f.scene.settings.depthPrepass = false;
    f.scene.settings.clusteredLighting = false;
    for (let i = 0; i < MAX_POINT_SHADOWS + 1; i++) {
      const l = addPointLight(f, `capacity-point-${i}`, i * 2 - 2, 3, 0, 8);
      l.castShadow = true;
    }
    f.renderer.renderScene(f.scene);
    assert.ok(f.renderer.stats.shadowCascades > 0);
    assert.equal(f.renderer.stats.pointShadowMaps, MAX_POINT_SHADOWS);

    // Drop the sun: the reused cascade array must not leak its old count into a point-only frame.
    f.mock.passes.length = 0;
    f.sun.castShadow = false;
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    const expected: string[] = [];
    for (let p = 0; p < MAX_POINT_SHADOWS; p++) {
      for (let face = 0; face < POINT_SHADOW_FACES; face++) expected.push(`forge.shadow.point.${p}.${face}`);
    }
    expected.push("forge.main");
    assert.deepEqual(labels(f), expected);
    assertContains(f.mock.passes[0]!.depthTarget, `256x256x${MAX_POINT_SHADOWS * POINT_SHADOW_FACES}`);
    assert.equal(f.renderer.stats.shadowCascades, 0);
    assert.equal(f.renderer.stats.pointShadowMaps, MAX_POINT_SHADOWS);
    const shadow = bufferOf(f, "shadow.uniforms");
    assert.equal(shadow.i32[ShadowUniforms.offsetOf("count") >> 2], 0);
    assert.equal(shadow.i32[ShadowUniforms.offsetOf("pointCount") >> 2], MAX_POINT_SHADOWS);
    // Slot numbering: the two shadowed point lights keep slots 0 and 1; the third has no map.
    const records = LightBlock.field("lights", "uniform");
    const lights = bufferOf(f, "lights.uniforms");
    const shadowIndexWord = LightUniforms.offsetOf("shadowIndex") >> 2;
    const strideWords = records.stride! / 4;
    assert.equal(lights.i32[records.offset / 4 + 1 * strideWords + shadowIndexWord], 0);
    assert.equal(lights.i32[records.offset / 4 + 2 * strideWords + shadowIndexWord], 1);
    assert.equal(lights.i32[records.offset / 4 + 3 * strideWords + shadowIndexWord], -1);
    await f.dispose();
  });

  test("drops the point cube when no caster reaches the light", async () => {
    const f = await fixture();
    f.scene.settings.hdr = false;
    f.scene.settings.depthPrepass = false;
    f.scene.settings.shadow.cascades = 1;
    f.scene.settings.clusteredLighting = false;
    // Far outside the light's range: the sphere pre-test keeps every caster out of every face.
    const light = addPointLight(f, "distant-point", 30, 3, 30, 4);
    light.castShadow = true;
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    assert.deepEqual(labels(f), ["forge.shadow.0", "forge.main"]);
    assert.equal(f.renderer.stats.pointShadowMaps, 0);
    await f.dispose();
  });

  test("casters outside the view frustum still render into the cascades they intersect", async () => {
    // A box behind the camera's back is frustum-culled for the colour pass but sits well inside the
    // first cascade's light-space box, so it must still cast.
    const f = await fixture({ extraBoxes: [new Vec3(0, 0.75, -12)] });
    f.scene.settings.shadow.cascades = 1;
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    const s = f.renderer.stats;
    assert.equal(s.culled, 1);
    assert.equal(s.drawCalls - 3 - 6, 2); // ground + visible box; the culled one is not drawn in forge.main
    assert.equal(s.prepassDraws, 2); // ...nor in the depth prepass
    assert.equal(f.mock.passes[0]!.drawCalls, 2); // ...but both boxes reach the shadow pass
    assert.equal(s.shadowsDrawn, 2);
    await f.dispose();
  });

  test("assigns per-object cascade ranges without splitting the colour batch", async () => {
    const f = await fixture({ includeDefaultBox: false });
    f.scene.settings.shadow.cascades = 4;
    // The cascade fit is camera/light-only, so this setup frame gives us the exact frusta even though
    // there are no casters yet. Candidate bounds are then chosen from the intersection of the real
    // camera frustum and overlapping-but-distinct cascade masks.
    f.renderer.renderScene(f.scene);
    const cascadeFrustums = f.renderer.shadowCascades.map((cascade) => new Frustum().setFromViewProjection(cascade.viewProj));
    const cameraFrustum = new Frustum().setFromViewProjection(f.camera.viewProjection);
    const localBounds = f.boxGeometry.bounds;
    const worldBounds = new AABB();
    const candidates: { position: Vec3; mask: number }[] = [];
    for (const z of [-7, -6, -4, -2, 0, 2, 4, 6, 8, 10, 12, 16, 20, 24, 30, 40, 55, 70, 85]) {
      for (const x of [-16, -12, -8, -4, 0, 4, 8, 12, 16]) {
        for (const y of [-1, 0, 1, 2, 4, 8, 12]) {
          const position = new Vec3(x, y, z);
          const bounds = localBounds.transformByMatrix(new Mat4().translate(position), worldBounds);
          if (!cameraFrustum.intersectsAABB(bounds)) continue;
          let mask = 0;
          for (let cascade = 0; cascade < cascadeFrustums.length; cascade++) {
            if (cascadeFrustums[cascade]!.intersectsAABB(bounds)) mask |= 1 << cascade;
          }
          if (mask !== 0) candidates.push({ position, mask });
        }
      }
    }
    let pair: [typeof candidates[number], typeof candidates[number]] | null = null;
    for (let a = 0; a < candidates.length && !pair; a++) {
      for (let b = a + 1; b < candidates.length; b++) {
        const left = candidates[a]!;
        const right = candidates[b]!;
        if (left.mask !== right.mask && (left.mask & right.mask) !== 0) {
          pair = [left, right];
          break;
        }
      }
    }
    assert.notEqual(pair, null, "fixture has two visible casters with overlapping, distinct cascade masks");
    const selected = pair!;
    for (const [index, candidate] of selected.entries()) {
      const entity = f.scene.createTransformedEntity(`assigned-caster-${index}`, candidate.position);
      const renderable = new Renderable();
      renderable.geometry = f.boxGeometry;
      renderable.material = f.boxMaterial;
      f.scene.world.addComponent(entity.id, renderable);
    }

    f.mock.passes.length = 0;
    f.mock.commandLog.length = 0;
    f.renderer.renderScene(f.scene);
    const popcount = (mask: number) => {
      let count = 0;
      for (let bit = 0; bit < 4; bit++) count += (mask >> bit) & 1;
      return count;
    };
    const expectedInstances = selected.reduce((sum, candidate) => sum + popcount(candidate.mask), 0);
    assert.equal(f.renderer.stats.batches, 2); // ground + one shared colour batch for both casters
    assert.equal(f.renderer.stats.shadowInstancesDrawn, expectedInstances);
    assert.equal(f.renderer.stats.shadowInstancesCulled, 8 - expectedInstances);
    assert.equal(f.renderer.stats.shadowsDrawn, expectedInstances); // masks differ, so each assigned range is submitted separately

    for (let cascade = 0; cascade < 4; cascade++) {
      const expectedFirstInstances = selected.flatMap((candidate, index) => (candidate.mask & (1 << cascade)) !== 0 ? [index] : []);
      const pass = f.mock.passes.find((record) => record.label === `forge.shadow.${cascade}`)!;
      assert.equal(pass.instances, expectedFirstInstances.length);
      const actualFirstInstances = f.mock.commandLog
        .filter((entry) => entry.label === `forge.shadow.${cascade}` && entry.type === "drawIndexed")
        .map((entry) => Number(entry["firstInstance"]));
      assert.deepEqual(actualFirstInstances, expectedFirstInstances);
    }
    assert.deepEqual(f.mock.errors, []);
    await f.dispose();
  });

  test("allocates no textures on a steady frame and rebuilds only what a resize changes", async () => {
    const f = await fixture();
    f.scene.settings.shadow.cascades = 2;
    f.renderer.renderScene(f.scene);
    // The device's own accounting (Phase 9.3) counts every allocation, including the raw
    // `device.device.create*` calls the renderer makes internally. (The old assertions read
    // `mock.texturesCreated`, which never existed — they compared `undefined` to `undefined`.)
    const created = f.device.gpuMemory.texturesCreated;
    const buffers = f.device.gpuMemory.buffersCreated;
    for (let i = 0; i < 4; i++) f.renderer.renderScene(f.scene);
    assert.equal(f.device.gpuMemory.texturesCreated, created);
    assert.equal(f.device.gpuMemory.buffersCreated, buffers);
    assert.equal(f.renderer.stats.texturesCreated, 0);

    // Resize: frame-sized transients (hdr, depth, AO, bloom mips) are re-planned, the shadow atlas is
    // not. (200x120 shares no shape with the 320x180 frame; a half-size resize would re-use old mips.)
    f.renderer.resize(200, 120);
    f.renderer.renderScene(f.scene);
    assert.equal(f.renderer.stats.bloomMips, 2);
    assert.equal(f.renderer.stats.texturesCreated, 2 + 2 + 2); // hdr + depth, two AO (one aliased), two mips
    // The old shapes survive two idle frames (a toggle that flips back costs nothing), then go away.
    f.renderer.renderScene(f.scene);
    const outstandingBefore = f.mock.outstanding.textures.filter((t) => t.startsWith("rg.")).length;
    f.renderer.renderScene(f.scene);
    const outstandingAfter = f.mock.outstanding.textures.filter((t) => t.startsWith("rg.")).length;
    assert.equal(outstandingBefore - outstandingAfter, 2 + 2 + 3); // old hdr + depth, two AO, three bloom mips
    assert.equal(f.renderer.stats.texturesCreated, 0);
    assert.deepEqual(f.mock.errors, []);
    await f.dispose();
  });

  test("switching HDR off and on and toggling shadows leaks nothing and stays valid", async () => {
    const f = await fixture();
    for (const [hdr, shadows] of [
      [true, true],
      [false, true],
      [false, false],
      [true, false],
      [true, true],
    ] as const) {
      f.scene.settings.hdr = hdr;
      f.scene.settings.shadow.enabled = shadows;
      for (let i = 0; i < 4; i++) f.renderer.renderScene(f.scene);
      assert.deepEqual(f.mock.errors, [], `hdr=${hdr} shadows=${shadows}`);
    }
    assertContains(f.renderer.passNames, "forge.tonemap");
    await f.dispose();
  });

  test("sky: a fullscreen pass after forge.main over the same target, depth loaded explicitly", async () => {
    const f = await fixture();
    f.scene.settings.shadow.cascades = 1;
    f.scene.setSky({ quality: "low" });
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    assert.deepEqual(labels(f), [
      "forge.shadow.0",
      ...PREPASS_SSAO,
      "forge.main",
      "forge.sky",
      "forge.bloom.prefilter",
      "forge.bloom.down.2",
      "forge.bloom.down.3",
      "forge.bloom.up.2",
      "forge.bloom.up.1",
      "forge.tonemap",
    ]);
    const main = f.mock.passes[5]!;
    const sky = f.mock.passes[6]!;
    // The sky depth-tests against the scene depth, so forge.main must keep it (it discards otherwise),
    // and the sky pass must load it explicitly — the read-only attach's implicit load is exactly the
    // primitive that silently lost the depth on WebKit (flat beige sky-ground over the whole scene).
    assert.equal(main.depthStoreOp, "store");
    assert.equal(sky.depthLoadOp, "load");
    assert.equal(sky.depthStoreOp, "store");
    assert.equal(sky.depthTarget, main.depthTarget);
    assert.deepEqual(sky.colorTargets, main.colorTargets);
    assert.equal(sky.drawCalls, 1);
    assert.equal(sky.triangles, 1);
    const s = f.renderer.stats;
    assert.equal(s.sky, true);
    assert.equal(s.drawCalls, 2 + 1 + 3 + 6);
    assert.equal(s.transientTextures, 9); // the sky adds no texture: it draws into scene.hdr
    assert.equal(s.passes, 13);

    // Steady state: nothing is (re)created for the sky.
    const created = f.device.gpuMemory.texturesCreated;
    const buffers = f.device.gpuMemory.buffersCreated;
    for (let i = 0; i < 3; i++) f.renderer.renderScene(f.scene);
    assert.equal(f.device.gpuMemory.texturesCreated, created);
    assert.equal(f.device.gpuMemory.buffersCreated, buffers);
    assert.equal(f.renderer.stats.texturesCreated, 0);

    // LDR: the sky writes the swapchain directly, after the forward pass.
    f.mock.passes.length = 0;
    f.scene.settings.hdr = false;
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    assert.deepEqual(labels(f), ["forge.shadow.0", ...PREPASS_SSAO, "forge.main", "forge.sky"]);
    assert.deepEqual(f.mock.passes[6]!.colorTargets, ["swapchain"]);
    assert.equal(f.mock.passes[5]!.depthStoreOp, "store");

    // Off again (a solid background): no sky pass, and the depth buffer goes back to being discarded.
    f.mock.passes.length = 0;
    f.scene.setBackgroundColor(0x102030);
    f.renderer.renderScene(f.scene);
    assert.deepEqual(labels(f), ["forge.shadow.0", ...PREPASS_SSAO, "forge.main"]);
    assert.equal(f.mock.passes[5]!.depthStoreOp, "discard");
    assert.equal(f.renderer.stats.sky, false);

    // The quality profile can cap the march or veto the pass regardless of the scene.
    f.scene.setSky({ quality: "high" });
    f.renderer.renderScene(f.scene);
    assert.equal(f.renderer.stats.skySamples, 32);
    const capped = new Renderer(f.device, { shadowMapSize: 256, skyQuality: "low" });
    capped.renderScene(f.scene);
    assert.equal(capped.stats.sky, true);
    assert.equal(capped.stats.skySamples, 8);
    capped.dispose();
    const vetoed = new Renderer(f.device, { shadowMapSize: 256, sky: false });
    f.mock.passes.length = 0;
    vetoed.renderScene(f.scene);
    assertNotContains(labels(f), "forge.sky");
    assert.equal(vetoed.stats.skySamples, 0);
    vetoed.dispose();
    assert.deepEqual(f.mock.errors, []);
    await f.dispose();
  });

  test("sky: the sun comes from the settings, then the per-frame override, then the directional light", async () => {
    const f = await fixture();
    f.scene.settings.shadow.enabled = false;
    f.scene.settings.hdr = false;
    f.scene.setSky({ sunDirection: new Vec3(0, 2, 0) });
    assert.equal(f.scene.settings.sky.sunDirection!.y, 1); // normalised copy
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    assert.deepEqual(labels(f), [...PREPASS_SSAO, "forge.main", "forge.sky"]);
    // A one-frame override is consumed by the next frame and does not persist.
    f.renderer.setSkyOverride({ exposure: 0.5, quality: "high" });
    f.renderer.renderScene(f.scene);
    assert.equal(f.renderer.skyOverride, null);
    assert.equal(f.scene.settings.sky.exposure, 1);
    // Without an explicit direction the first directional light is the sun; without any light a
    // default is used — both must render cleanly.
    f.scene.settings.sky.sunDirection = null;
    f.renderer.renderScene(f.scene);
    f.scene.world.removeComponent(f.sun.entity, Light);
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    assertContains(f.renderer.passNames, "forge.sky");
    await f.dispose();
  });

  test("a frame without a camera clears the swapchain and still counts as rendered", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const renderer = new Renderer(device, { shadowMapSize: 256 });
    const scene = new Scene({ name: "empty" });
    renderer.renderScene(scene);
    assert.deepEqual(device.mock.passes.map((p) => p.label), ["forge.clear"]);
    assert.equal(renderer.framesRendered, 1);
    assert.deepEqual(device.mock.errors, []);
    scene.dispose();
    renderer.dispose();
    await device.dispose();
    assert.deepEqual(device.mock.outstanding.textures, []);
  });
});

group("depth prepass and SSAO", () => {
  test("the prepass lays the opaque depth down; forge.main loads it and never re-writes it", async () => {
    const f = await fixture();
    f.scene.settings.shadow.cascades = 1;
    f.mock.commandLog.length = 0;
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    const at = (name: string) => f.mock.passes.find((p) => p.label === name)!;
    const prepass = at("forge.prepass");
    const main = at("forge.main");
    // Depth only: no colour target; cleared, then stored for SSAO and the forward pass.
    assert.deepEqual(prepass.colorTargets, []);
    assertContains(prepass.depthTarget, "depth24plus");
    assert.equal(prepass.depthLoadOp, "clear");
    assert.equal(prepass.depthStoreOp, "store");
    assert.equal(prepass.drawCalls, 2);
    assert.equal(prepass.triangles, 2 + 12);
    // The forward pass continues on that depth buffer instead of clearing it...
    assert.equal(main.depthTarget, prepass.depthTarget);
    assert.equal(main.depthLoadOp, "load");
    // ...with the depth-only prepass variant laying it down, and the forward pipelines for the same
    // surfaces testing against it without writing.
    const prepassDraws = drawPipelines(f, "forge.prepass");
    assert.equal((prepassDraws).length, 2);
    for (const p of prepassDraws) assert.match(p, /^pipeline\.prepass\|none\|depth24plus\|/);
    const forward = drawPipelines(f, "forge.main");
    assert.equal((forward).length, 2);
    for (const p of forward) assertContains(p, "|nodepthwrite|");
    const s = f.renderer.stats;
    assert.equal(s.depthPrepass, true);
    assert.equal(s.prepassDraws, 2);
    assert.equal(s.drawCalls, 2 + 3 + 6); // prepass draws are reported apart, like shadowsDrawn
    await f.dispose();
  });

  test("transparent, cutout, fading and overlay surfaces stay out of the prepass and keep writing depth", async () => {
    const f = await fixture();
    f.scene.settings.shadow.enabled = false;
    const box = createBox(f.device, { width: 1, height: 1, depth: 1 });
    const cutout = new Material({ label: "cutout", color: 0x44aa44 });
    cutout.alphaTest = 0.5;
    const fading = new Material({ label: "fading", color: 0x4444aa, opacity: 0.5 });
    const glass = new Material({ label: "glass", color: 0xaaaaaa, transparent: true });
    const add = (name: string, x: number, material: Material, configure?: (r: Renderable) => void) => {
      const e = f.scene.createTransformedEntity(name, new Vec3(x, 0.5, -3));
      const r = new Renderable();
      r.geometry = box;
      r.material = material;
      configure?.(r);
      f.scene.world.addComponent(e.id, r);
    };
    add("cutout", -2, cutout);
    add("fading", -0.5, fading);
    add("glass", 1, glass, (r) => (r.transparent = true));
    add("overlay", 2.5, new Material({ label: "hud", color: 0xffffff }), (r) => (r.overlay = true));
    f.mock.commandLog.length = 0;
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    const s = f.renderer.stats;
    assert.equal(s.culled, 0);
    assert.equal(s.depthPrepass, true);
    assert.equal(s.prepassDraws, 2); // the ground and the opaque box only
    const forward = drawPipelines(f, "forge.main");
    assert.equal((forward).length, 6);
    // The two prepassed surfaces shade without writing depth; the other four draw exactly as they
    // would with no prepass at all, depth writes included.
    assert.equal((forward.filter((p) => p.includes("|nodepthwrite|"))).length, 2);
    assert.equal((forward.filter((p) => p.includes("|depthwrite|"))).length, 4);
    assert.equal(f.mock.passes.find((p) => p.label === "forge.prepass")!.drawCalls, 2);

    // Nothing eligible at all (everything transparent): no prepass pass, and so no SSAO either.
    f.mock.passes.length = 0;
    const all = f.scene.world.query([Renderable]);
    all.refresh();
    for (let i = 0; i < all.count; i++) f.scene.world.getComponent(all.entity(i), Renderable)!.transparent = true;
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    assert.equal(labels(f)[0], "forge.main");
    assert.deepEqual(labels(f).filter((l) => l.startsWith("forge.prepass") || l.startsWith("forge.ssao")), []);
    assert.equal(f.renderer.stats.depthPrepass, false);
    assert.equal(f.renderer.stats.ssao, false);
    assert.equal(f.mock.passes[0]!.depthLoadOp, "clear");
    box.dispose();
    for (const m of [cutout, fading, glass]) m.dispose();
    await f.dispose();
  });

  test("SSAO: a half-resolution estimate and a separable blur, the estimate's target aliased into the result", async () => {
    const f = await fixture();
    f.scene.settings.shadow.cascades = 1;
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    const at = (name: string) => f.mock.passes.find((p) => p.label === name)!;
    const estimate = at("forge.ssao");
    const blurH = at("forge.ssao.blur.h");
    const blurV = at("forge.ssao.blur.v");
    for (const pass of [estimate, blurH, blurV]) {
      assert.equal((pass.colorTargets).length, 1);
      assertContains(pass.colorTargets[0], "160x90"); // half of 320x180
      assertContains(pass.colorTargets[0], "rg16float");
      assert.equal(pass.depthTarget, null);
      assert.equal(pass.drawCalls, 1);
      assert.equal(pass.triangles, 1);
    }
    // The estimate's texture is dead once the horizontal blur has read it: the vertical blur writes
    // the very same physical texture, and the graph reports the bytes that saved.
    assert.equal(blurV.colorTargets[0], estimate.colorTargets[0]);
    assert.notEqual(blurH.colorTargets[0], estimate.colorTargets[0]);
    const s = f.renderer.stats;
    assert.equal(s.ssao, true);
    assert.equal(s.aliasedBytes, 160 * 90 * 4);
    assert.equal(s.physicalTextures, s.transientTextures - 1);

    // The uniform block: inverse projection, pixels-per-metre at depth 1, both extents, clamps.
    let u = ssaoUniforms(f);
    const tanHalf = Math.tan(f.camera.fovY / 2);
    assertCloseTo(u.f32[16], f.scene.settings.ssao.radius, 6); // radius
    assertCloseTo(u.f32[19], (0.5 * 180) / tanHalf, 3); // projScale
    assert.deepEqual([u.f32[20], u.f32[21], u.f32[22], u.f32[23]], [320, 180, 160, 90]);
    assert.equal(u.u32[24], 12); // sampleCount
    assertCloseTo(u.f32[1 * 4 + 1], tanHalf, 5); // invProj[1][1] = 1 / m[5]
    f.scene.settings.ssao.samples = 500;
    f.renderer.renderScene(f.scene);
    u = ssaoUniforms(f);
    assert.equal(u.u32[24], 32);
    f.scene.settings.ssao.samples = 0;
    f.renderer.renderScene(f.scene);
    assert.equal(ssaoUniforms(f).u32[24], 1);
    assert.deepEqual(f.mock.errors, []);
    await f.dispose();
  });

  test("SSAO needs the prepass and a perspective camera; the scene and the quality profile switch either off", async () => {
    const f = await fixture();
    f.scene.settings.shadow.enabled = false;
    f.scene.settings.hdr = false;
    const run = (renderer = f.renderer) => {
      f.mock.passes.length = 0;
      f.mock.commandLog.length = 0;
      renderer.renderScene(f.scene);
      assert.deepEqual(f.mock.errors, []);
      return labels(f);
    };
    assert.deepEqual(run(), [...PREPASS_SSAO, "forge.main"]);

    // SSAO off: the prepass stays (it pays for itself), the AO passes go, the AO flag clears.
    f.scene.settings.ssao.enabled = false;
    assert.deepEqual(run(), ["forge.prepass", "forge.main"]);
    assert.equal(f.renderer.stats.ssao, false);
    assert.equal(f.renderer.stats.depthPrepass, true);
    assert.equal(f.mock.passes[1]!.depthLoadOp, "load");
    f.scene.settings.ssao.enabled = true;
    f.scene.settings.ssao.intensity = 0; // nothing to apply: nothing computed
    assert.deepEqual(run(), ["forge.prepass", "forge.main"]);
    f.scene.settings.ssao.intensity = 1;

    // Prepass off: SSAO has no depth to read, and forge.main clears and writes depth itself again.
    f.scene.settings.depthPrepass = false;
    assert.deepEqual(run(), ["forge.main"]);
    assert.equal(f.mock.passes[0]!.depthLoadOp, "clear");
    for (const p of drawPipelines(f, "forge.main")) assertContains(p, "|depthwrite|");
    assert.equal(f.renderer.stats.depthPrepass, false);
    assert.equal(f.renderer.stats.prepassDraws, 0);
    assert.equal(f.renderer.stats.ssao, false);
    f.scene.settings.depthPrepass = true;

    // Orthographic camera: the prepass runs, SSAO does not (its bilateral key is perspective clip.w).
    f.camera.setOrthographic(10, 16 / 9, 0.1, 100);
    assert.deepEqual(run(), ["forge.prepass", "forge.main"]);
    f.camera.setPerspective(Math.PI / 3, 16 / 9, 0.1, 100);
    assert.deepEqual(run(), [...PREPASS_SSAO, "forge.main"]);

    // The quality profile vetoes either, whatever the scene asks for.
    const noPrepass = new Renderer(f.device, { shadowMapSize: 256, depthPrepass: false });
    assert.deepEqual(run(noPrepass), ["forge.main"]);
    assert.equal(noPrepass.stats.ssao, false);
    noPrepass.dispose();
    const noSsao = new Renderer(f.device, { shadowMapSize: 256, ssao: false });
    assert.deepEqual(run(noSsao), ["forge.prepass", "forge.main"]);
    noSsao.dispose();
    await f.dispose();
  });

  test("allocates nothing on a steady SSAO frame, and switching it all on and off leaks nothing", async () => {
    const f = await fixture();
    f.scene.settings.shadow.cascades = 2;
    f.renderer.renderScene(f.scene);
    f.renderer.renderScene(f.scene);
    const created = f.device.gpuMemory.texturesCreated;
    const buffers = f.device.gpuMemory.buffersCreated;
    for (let i = 0; i < 4; i++) f.renderer.renderScene(f.scene);
    assert.equal(f.device.gpuMemory.texturesCreated, created);
    assert.equal(f.device.gpuMemory.buffersCreated, buffers);
    assert.equal(f.renderer.stats.texturesCreated, 0);
    assert.equal(f.renderer.stats.ssao, true);

    for (const [prepass, ssao, hdr] of [
      [false, false, true],
      [true, false, true],
      [true, true, false],
      [false, true, false],
      [true, true, true],
    ] as const) {
      f.scene.settings.depthPrepass = prepass;
      f.scene.settings.ssao.enabled = ssao;
      f.scene.settings.hdr = hdr;
      for (let i = 0; i < 4; i++) f.renderer.renderScene(f.scene);
      assert.deepEqual(f.mock.errors, [], `prepass=${prepass} ssao=${ssao} hdr=${hdr}`);
      assert.equal(f.renderer.stats.depthPrepass, prepass);
      assert.equal(f.renderer.stats.ssao, prepass && ssao);
    }
    // The fixture's dispose() asserts that no buffer or texture (SSAO uniforms, AO fallback, pooled
    // AO targets) outlives the renderer.
    await f.dispose();
  });
});

// ------------------------------------------------------------------ clustered (Forward+) lighting

/** A GPU buffer's live contents, by label (the mock keeps real bytes, so this is what was uploaded). */
function bufferOf(f: Fixture, label: string): { f32: Float32Array; i32: Int32Array; u32: Uint32Array; writeCount: number; size: number } {
  const buffer = [...f.mock.liveBuffers].find((b) => b.label === label);
  assert.notEqual(buffer, undefined, `"${label}" buffer`);
  return {
    f32: new Float32Array(buffer!.data),
    i32: new Int32Array(buffer!.data),
    u32: new Uint32Array(buffer!.data),
    writeCount: buffer!.writeCount,
    size: buffer!.size,
  };
}

function addPointLight(f: Fixture, name: string, x: number, y: number, z: number, range = 6, intensity = 10): Light {
  const e = f.scene.createTransformedEntity(name, new Vec3(x, y, z));
  const l = new Light();
  l.kind = "point";
  l.range = range;
  l.intensity = intensity;
  l.castShadow = false;
  f.scene.world.addComponent(e.id, l);
  return l;
}

function addSpotLight(f: Fixture, name: string, position: Vec3, target = new Vec3(0, 0.75, 0)): Light {
  const e = f.scene.createTransformedEntity(name, position);
  e.transform.lookAt(target);
  const l = new Light();
  l.kind = "spot";
  l.range = 16;
  l.innerCone = 0.95;
  l.outerCone = 0.75;
  l.followRotation = true;
  l.castShadow = true;
  f.scene.world.addComponent(e.id, l);
  return l;
}

/** `perFrame.flags` as last uploaded. */
function frameFlags(f: Fixture): number {
  return bufferOf(f, "perframe.uniforms").u32[PerFrameUniforms.offsetOf("flags") >> 2]!;
}

group("clustered (Forward+) lighting", () => {
  const LIGHTS_OFFSET = ClusterLightBlock.field("lights", "storage");
  const CLUSTER_FIELDS = {
    invExtent: ClusterUniforms.offsetOf("invExtent"),
    gridScale: ClusterUniforms.offsetOf("gridScale"),
    near: ClusterUniforms.offsetOf("near"),
    logNear: ClusterUniforms.offsetOf("logNear"),
    sliceScale: ClusterUniforms.offsetOf("sliceScale"),
    slices: ClusterUniforms.offsetOf("slices"),
    lightCount: ClusterUniforms.offsetOf("lightCount"),
    stride: ClusterUniforms.offsetOf("stride"),
  };

  test("local lights go to the cluster grid and the uniform list keeps only the global ones", async () => {
    const f = await fixture();
    addPointLight(f, "lamp-a", -2, 1.5, 0);
    addPointLight(f, "lamp-b", 2, 1.5, 1, 4, 25);
    addPointLight(f, "lamp-c", 0, 2.5, -2, 8, 5);
    // Clustering changes what the fragment stage reads, not what the graph records: render the same
    // scene with it off and on and the pass list must be identical.
    f.scene.settings.clusteredLighting = false;
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    const unclustered = labels(f);
    f.mock.passes.length = 0;
    f.scene.settings.clusteredLighting = true;
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);

    const s = f.renderer.stats;
    assert.equal(s.clusteredLighting, true);
    assert.equal(s.lights, 4); // the sun plus three lamps
    assert.equal(s.clusteredLights, 3);
    assert.ok(s.clustersUsed > 0);
    assert.ok(s.clusterIndices >= s.clustersUsed);
    assert.ok(s.maxLightsPerCluster >= 1);
    assert.equal(s.lightsDropped, false);

    // Clustering is a data change, not a pass: the frame structure is untouched.
    assert.deepEqual(labels(f), unclustered);
    assertContains(labels(f), "forge.main");
    assert.equal(frameFlags(f) & 32, 32);

    // The uniform block holds the directional light only (it is the cascade caster, index 0).
    const uniform = bufferOf(f, "lights.uniforms");
    assert.equal(uniform.i32[0], 1);
    assert.equal(uniform.i32[1], 1); // shadowedCount

    // The cluster block holds the three lamps, with the same record layout the uniform block uses.
    const clustered = bufferOf(f, "cluster.lights");
    assert.equal(clustered.i32[0], 3);
    const stride = LIGHTS_OFFSET.stride! >> 2;
    const at = (i: number) => LIGHTS_OFFSET.offset / 4 + i * stride;
    assert.equal(clustered.f32[at(0) + 3], 6); // lamp-a range
    assert.equal(clustered.f32[at(1) + 3], 4); // lamp-b range
    assert.equal(clustered.f32[at(1) + 2], 1); // lamp-b z
    assert.equal(clustered.i32[at(0) + 14], 1); // kind: point
    assert.equal(clustered.i32[at(0) + 15], -1); // no shadow index: point shadows are 13.9
    assert.equal(clustered.f32[at(2) + 7], 5); // lamp-c intensity (directionIntensity.w)

    // The quantisation block is what the fragment stage's cluster lookup runs on.
    const c = bufferOf(f, "cluster.uniforms");
    assert.equal(c.f32[CLUSTER_FIELDS.gridScale >> 2], CLUSTER_TILES_X);
    assert.equal(c.f32[(CLUSTER_FIELDS.gridScale >> 2) + 1], CLUSTER_TILES_Y);
    assert.equal(c.f32[CLUSTER_FIELDS.slices >> 2], CLUSTER_SLICES);
    assert.equal(c.i32[CLUSTER_FIELDS.lightCount >> 2], 3);
    assert.equal(c.i32[CLUSTER_FIELDS.stride >> 2], MAX_LIGHTS_PER_CLUSTER);
    assertCloseTo(c.f32[CLUSTER_FIELDS.invExtent >> 2], 1 / 320, 9);
    assertCloseTo(c.f32[(CLUSTER_FIELDS.invExtent >> 2) + 1], 1 / 180, 9);
    await f.dispose();
  });

  test("uploads the grid the builder wrote: fixed-stride blocks, every list ascending and in range", async () => {
    const f = await fixture();
    for (let i = 0; i < 12; i++) addPointLight(f, `lamp${i}`, ((i % 4) - 1.5) * 3, 1 + (i % 3), ((i >> 2) - 1) * 3, 5, 5 + i);
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    const grid = bufferOf(f, "cluster.grid");
    const s = f.renderer.stats;
    const countsAt = ClusterGridBlock.offsetOf("counts", "storage") >> 2;
    const listAt = ClusterGridBlock.offsetOf("indices", "storage") >> 2;
    let total = 0;
    let nonEmpty = 0;
    for (let c = 0; c < CLUSTER_COUNT; c++) {
      const n = grid.u32[countsAt + c]!;
      assert.ok(n <= MAX_LIGHTS_PER_CLUSTER); // the cap is the stride: never more
      total += n;
      if (n > 0) nonEmpty++;
    }
    assert.equal(total, s.clusterIndices);
    assert.equal(nonEmpty, s.clustersUsed);
    // Cluster c owns slots [c*MAX, c*MAX+n) of the list: lists are ascending (the shader's
    // accumulation order must not depend on the path) and every entry addresses a real light record.
    for (let c = 0; c < CLUSTER_COUNT; c++) {
      const n = grid.u32[countsAt + c]!;
      const start = listAt + c * MAX_LIGHTS_PER_CLUSTER;
      for (let k = 0; k < n; k++) assert.ok(grid.u32[start + k]! < s.clusteredLights);
      for (let k = 1; k < n; k++) assert.ok(grid.u32[start + k]! > grid.u32[start + k - 1]!);
    }
    assert.equal(s.lightsDropped, false);
    await f.dispose();
  });

  test("the uploaded quantisation reproduces the builder's slice for any depth (CPU/GPU agreement)", async () => {
    const f = await fixture();
    addPointLight(f, "lamp", 0, 1.5, 2, 6);
    f.renderer.renderScene(f.scene);
    const c = bufferOf(f, "cluster.uniforms");
    // What the fragment stage sees: f32 roundings of the builder's float64 constants.
    const near = c.f32[CLUSTER_FIELDS.near >> 2]!;
    const logNear = c.f32[CLUSTER_FIELDS.logNear >> 2]!;
    const sliceScale = c.f32[CLUSTER_FIELDS.sliceScale >> 2]!;
    const slices = c.f32[CLUSTER_FIELDS.slices >> 2]!;
    const nearF64 = Math.max(1e-4, f.camera.near); // the clamp the renderer applies
    const far = f.renderer.clusterBuildInfo!.far; // the builder's slice span, not the camera's far
    assert.equal(near, Math.fround(nearF64));
    assert.equal(logNear, Math.fround(Math.log(nearF64)));
    assert.equal(slices, CLUSTER_SLICES);
    assert.equal(sliceScale, Math.fround(CLUSTER_SLICES / Math.log(far / nearF64)));
    // The shader computes clamp(i32((log(max(depth, near)) - logNear) * sliceScale), 0, slices-1);
    // clusterSliceFor is that expression in float64. They must land on the same slice across the
    // span, or the CPU builds a list the GPU indexes into the wrong way.
    for (const depth of [nearF64, nearF64 * 1.5, 0.5, 1, 3, 7.5, 12, far * 0.5, far, far * 2]) {
      const shaderSlice = Math.min(CLUSTER_SLICES - 1, Math.max(0, Math.trunc((Math.log(Math.max(depth, near)) - logNear) * sliceScale)));
      assert.equal(shaderSlice, clusterSliceFor(depth, nearF64, far), `depth ${depth}`);
    }
    await f.dispose();
  });

  test("stays off for a directional-only scene, an orthographic camera, the scene switch and the profile veto", async () => {
    const f = await fixture();
    f.renderer.renderScene(f.scene);
    assert.equal(f.renderer.stats.clusteredLighting, false); // no local lights at all
    assert.equal(frameFlags(f) & 32, 0);
    const gridWrites = bufferOf(f, "cluster.grid").writeCount;

    addPointLight(f, "lamp", 0, 1.5, 0);
    f.renderer.renderScene(f.scene);
    assert.equal(f.renderer.stats.clusteredLighting, true);
    assert.ok(bufferOf(f, "cluster.grid").writeCount > gridWrites);

    // Scene switch.
    f.scene.settings.clusteredLighting = false;
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    assert.equal(f.renderer.stats.clusteredLighting, false);
    assert.equal(frameFlags(f) & 32, 0);
    assert.equal(bufferOf(f, "lights.uniforms").i32[0], 2); // both lights back in the uniform list
    assert.equal(f.renderer.clusterBuildInfo, null);
    f.scene.settings.clusteredLighting = true;

    // Quality-profile veto (EngineConfig.clusteredLighting → RendererOptions).
    const veto = new Renderer(f.device, { shadowMapSize: 256, clusteredLighting: false });
    veto.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    assert.equal(veto.stats.clusteredLighting, false);
    assert.equal(bufferOf(f, "lights.uniforms").i32[0], 2);
    veto.dispose();

    // Orthographic camera: clip.w is not a view depth, so there is no depth axis to cluster on.
    f.camera.setOrthographic(12, 16 / 9, 0.1, 100);
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    assert.equal(f.renderer.stats.clusteredLighting, false);
    assert.equal(frameFlags(f) & 32, 0);
    f.camera.setPerspective(Math.PI / 3, 16 / 9, 0.1, 100);
    f.renderer.renderScene(f.scene);
    assert.equal(f.renderer.stats.clusteredLighting, true);
    await f.dispose();
  });

  test("carries more lights than the uniform list ever could, and reports the old cap honestly", async () => {
    const f = await fixture();
    const total = MAX_LIGHTS_PER_FRAME + 24; // 40 lamps: 2.5x the uniform block
    for (let i = 0; i < total; i++) addPointLight(f, `lamp${i}`, ((i % 8) - 3.5) * 1.6, 1 + (i % 4) * 0.6, ((i >> 3) - 2) * 1.6, 4, 4 + i);
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    const s = f.renderer.stats;
    assert.equal(s.lights, total + 1);
    assert.equal(s.clusteredLights, total); // every lamp reaches the shader
    assert.equal(s.lightsDropped, false);
    assert.equal(bufferOf(f, "lights.uniforms").i32[0], 1); // the sun alone
    assert.equal(bufferOf(f, "cluster.lights").i32[0], total);
    assert.ok(s.clusterIndices > total);

    // The same scene with clustering off: the fixed list truncates, and the stats say so instead of
    // letting 24 lamps vanish without a trace.
    f.scene.settings.clusteredLighting = false;
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    assert.equal(f.renderer.stats.lightsDropped, true);
    assert.equal(bufferOf(f, "lights.uniforms").i32[0], MAX_LIGHTS_PER_FRAME);
    await f.dispose();
  });

  test("allocates nothing on a steady clustered frame, and toggling it leaks nothing", async () => {
    const f = await fixture();
    addPointLight(f, "lamp-a", -2, 1.5, 0);
    addPointLight(f, "lamp-b", 2, 1.5, 1, 4, 25);
    f.renderer.renderScene(f.scene);
    f.renderer.renderScene(f.scene);
    const buffers = f.device.gpuMemory.buffersCreated;
    const textures = f.device.gpuMemory.texturesCreated;
    for (let i = 0; i < 4; i++) f.renderer.renderScene(f.scene);
    assert.equal(f.device.gpuMemory.buffersCreated, buffers);
    assert.equal(f.device.gpuMemory.texturesCreated, textures);
    assert.equal(f.renderer.stats.texturesCreated, 0);
    assert.equal(f.renderer.stats.clusteredLighting, true);

    for (const [clustered, hdr, shadows] of [
      [true, true, true],
      [false, true, true],
      [true, false, false],
      [false, false, true],
      [true, true, false],
    ] as const) {
      f.scene.settings.clusteredLighting = clustered;
      f.scene.settings.hdr = hdr;
      f.scene.settings.shadow.enabled = shadows;
      for (let i = 0; i < 3; i++) f.renderer.renderScene(f.scene);
      assert.deepEqual(f.mock.errors, [], `clustered=${clustered} hdr=${hdr} shadows=${shadows}`);
      assert.equal(f.renderer.stats.clusteredLighting, clustered);
    }
    // The fixture's dispose() asserts nothing (cluster buffers included) outlives the renderer.
    await f.dispose();
  });

  test("hands the fill to the GPU when asked, and reports the same grid either way", async () => {
    // The two fills are A/B-able on one scene. On the mock nothing executes, so what is checked here
    // is the *handover*: the counts are still the CPU's (the fragment stage and the stats read them),
    // the lists are not uploaded at all, and the device is handed the pass that writes them. The
    // shader itself is pinned in tests/rendering/lightCulling.test.ts and compiled by check:browser.
    const scene = async (mode: "cpu" | "gpu") => {
      const f = await fixture({ renderer: { lightCulling: mode } });
      addPointLight(f, "lamp-a", -2, 1.5, 0);
      addPointLight(f, "lamp-b", 2, 1.5, 1, 4, 25);
      addPointLight(f, "lamp-c", 0, 2.5, -2, 8, 5);
      f.renderer.renderScene(f.scene);
      assert.deepEqual(f.mock.errors, [], mode);
      const grid = bufferOf(f, "cluster.grid");
      const s = { ...f.renderer.stats };
      const result = f.renderer.clusterBuildInfo!;
      const listBase = ClusterGridBlock.field("indices", "storage").offset >> 2;
      const indices = [...grid.u32.subarray(listBase, listBase + 4 * MAX_LIGHTS_PER_CLUSTER)];
      const writes = f.mock.commandLog.filter((e) => e.type === "writeBuffer" && e["buffer"] === "cluster.grid");
      const dispatches = f.mock.commandLog.filter((e) => e.type === "dispatch");
      return { f, s, result, indices, writes, dispatches, passes: labels(f), graphPasses: [...f.renderer.passNames], flags: frameFlags(f) };
    };

    const cpu = await scene("cpu");
    const gpu = await scene("gpu");

    // Same frame, same grid, same everything a reader of `stats` can see — the file that produced the
    // lists is the only difference.
    assert.equal(cpu.s.clusterFill, "cpu");
    assert.equal(gpu.s.clusterFill, "gpu");
    // Everything but the fill's own bookkeeping: the pass list carries the assignment pass, and
    // `clusterFill` names which half ran.
    const strip = (s: Renderer["stats"]) => {
      const { clusterFill, passes, ...rest } = s;
      return rest;
    };
    assert.deepEqual(strip(gpu.s), strip(cpu.s));
    assert.deepEqual(gpu.result, cpu.result);
    assert.ok(gpu.s.clusterIndices > 0);
    assert.ok(gpu.s.clustersUsed > 0);
    assert.equal(gpu.flags & 32, 32);

    // The CPU path uploads the counts and the list prefix; the GPU path uploads the counts only, and
    // the device gets one pass that writes every list the counts describe.
    assert.equal((cpu.writes).length, 2);
    assert.equal((gpu.writes).length, 1);
    assert.equal(gpu.writes[0]!.size, CLUSTER_COUNT * 4);
    assert.equal(cpu.indices.some((v) => v !== 0), true);
    assert.equal(gpu.indices.every((v) => v === 0), true); // nothing wrote it: the pass is the writer
    // The graph names the pass; the compute pass inside it is the one the device sees.
    assertContains(gpu.graphPasses, "forge.lights.assign");
    assertNotContains(cpu.graphPasses, "forge.lights.assign");
    assertContains(gpu.passes, "lights.assign");
    assertNotContains(cpu.passes, "lights.assign");
    assert.deepEqual(cpu.dispatches, []);
    // One dispatch per frame, in whole workgroups over the grid (12 x 256 = 3072 clusters).
    assertMatches(gpu.dispatches, [objectContaining({ label: "lights.assign", x: CLUSTER_COUNT / 256, y: 1, z: 1 })]);
    // The ranges the shader reads: the CPU's light count and the packed keys, uploaded once per
    // clustered frame (the CPU path has no such buffer at all).
    const rangeWrites = (f: Fixture) =>
      f.mock.commandLog.filter((e) => e.type === "writeBuffer" && e["buffer"] === "lights.ranges").map((e) => e["size"] as number);
    assert.deepEqual(rangeWrites(cpu.f), []);
    const entry = ClusterRangeBlock.field("entries", "storage");
    const keyBase = entry.offset >> 2;
    const stride = entry.stride! >> 2;
    const influenceSlot = ClusterRangeEntry.field("influence", "storage").offset >> 2;
    assert.deepEqual(rangeWrites(gpu.f), [entry.offset + gpu.s.clusteredLights * entry.stride!]);
    const ranges = bufferOf(gpu.f, "lights.ranges");
    assert.equal(ranges.u32[0], gpu.s.clusteredLights);
    for (let i = 0; i < gpu.s.clusteredLights; i++) {
      // Live: the light reaches at least one cluster. (A light that reaches nothing packs to zero.)
      assert.equal(ranges.u32[keyBase + i * stride]! >>> 24, 1, `key ${i}`);
      assert.ok(ranges.f32[keyBase + i * stride + influenceSlot]! > 0);
    }

    // A frame that did not cluster records no assignment pass at all: the pass belongs to the frame
    // that fills a grid, the way forge.ssao belongs to a frame that computes SSAO. The frame it did
    // not cluster must not be read against the last clustered frame's grid either.
    const off = gpu.f;
    const before = off.mock.commandLog.length;
    off.scene.settings.clusteredLighting = false;
    off.renderer.renderScene(off.scene);
    assert.deepEqual(off.mock.errors, []);
    assert.equal(off.renderer.stats.clusterFill, "none");
    assertNotContains(labels(off), "forge.lights.assign");
    assertNotContains(off.renderer.passNames, "forge.lights.assign");
    assert.deepEqual(off.mock.commandLog.slice(before).filter((e) => e["buffer"] === "lights.ranges"), []);
    assert.deepEqual(off.mock.commandLog.slice(before).filter((e) => e.type === "dispatch"), []);

    // Switching back mid-run returns to the CPU fill; the lists are the CPU's again on the next frame,
    // and the culler's scratch is released with the renderer (the fixture's dispose asserts that).
    off.scene.settings.clusteredLighting = true;
    off.renderer.lightCulling = "cpu";
    off.renderer.renderScene(off.scene);
    assert.equal(off.renderer.stats.clusterFill, "cpu");
    assertNotContains(off.renderer.passNames, "forge.lights.assign");
    // The CPU fill reproduces the GPU path's grid from the same scene, index count included.
    assert.equal(off.renderer.stats.clusterIndices, gpu.s.clusterIndices);
    assert.equal(off.renderer.stats.clustersUsed, gpu.s.clustersUsed);
    assert.equal(bufferOf(off, "cluster.grid").u32.some((v) => v !== 0), true);

    // And a round trip back to the GPU fill has to bring the pass *with* it. Switching to "cpu"
    // releases the culler's device resources; the renderer must not keep the released culler, because
    // a disposed `GpuLightCuller.record` returns without adding `forge.lights.assign` — the frame would
    // then render with no fill at all, reading whatever index blocks the last upload left behind (a
    // grid describing some other frame's lights). That is the bug the real-WebGPU gate caught on the
    // many-light rig, where the stale lists clipped light off a band of the frame; on the mock it is
    // visible as the missing pass.
    const beforeBack = off.mock.commandLog.length;
    off.renderer.lightCulling = "gpu";
    off.renderer.renderScene(off.scene);
    assert.equal(off.renderer.stats.clusterFill, "gpu");
    assertContains(off.renderer.passNames, "forge.lights.assign");
    assertMatches(off.mock.commandLog.slice(beforeBack).filter((e) => e.type === "dispatch"), [
      objectContaining({ label: "lights.assign", x: CLUSTER_COUNT / 256, y: 1, z: 1 }),
    ]);
    assert.deepEqual(off.mock.errors, []);

    await cpu.f.dispose();
    await gpu.f.dispose();
  });
});

// ------------------------------------------------------------------ object culling (Phase 13.5)

group("object culling", () => {
  test("culls batches on the CPU by default, and the frame says which", async () => {
    const f = await fixture();
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    // The mock device has no compute, so "auto" resolves to the twin — and its verdict is immediate:
    // every batch is tested in the same frame, and the words it wrote are in the buffer the draw
    // group binds.
    assert.equal(f.renderer.objectCulling, "cpu");
    assert.ok(f.renderer.stats.batches > 0);
    assert.equal(f.renderer.stats.cullTested, f.renderer.stats.batches);
    assert.equal(bufferOf(f, "cull.visibility").u32.every((v) => v === 0), true);
    assertNotContains(f.renderer.passNames, "forge.objects.cull");
    assert.equal(f.renderer.stats.cullFrustum + f.renderer.stats.cullDistance + f.renderer.stats.cullOccluded, 0);

    // Point the camera at the sky: what it can no longer see is culled, and its word says why.
    const cam = f.scene.findCamera()!;
    cam.entity.transform.lookAt(new Vec3(0, 200, 0));
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    const s = f.renderer.stats;
    assert.equal(s.cullTested, s.batches);
    assert.ok(s.cullFrustum > 0);
    const words = bufferOf(f, "cull.visibility").u32;
    assert.equal(([...words.slice(0, s.batches)].filter((w) => w === CullReason.Frustum)).length, s.cullFrustum);
    await f.dispose();
  });

  test("runs the device path as a pass, and its counters are the device's own", async () => {
    const f = await fixture({ renderer: { objectCulling: "gpu" } });
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    assert.equal(f.renderer.objectCulling, "gpu");
    assertContains(f.renderer.passNames, "forge.objects.cull");
    // The prepass depth is the pyramid's input, so the occlusion stage rides along with it...
    assertContains(f.renderer.passNames, "forge.hiz.0");
    // ...and the cull pass covers the batch count in whole workgroups.
    const dispatch = f.mock.commandLog.filter((e) => e.type === "dispatch").at(-1);
    assertMatchObject(dispatch, { label: "objects.cull", x: Math.ceil(f.renderer.stats.batches / 64), y: 1, z: 1 });
    // The device has not reported anything back yet (and on the mock never will: it records the pass
    // without executing it), so this is the *zeroed* visibility buffer — a frame whose words were
    // never written draws everything rather than keeping the last frame's verdicts.
    assert.equal(f.renderer.stats.cullTested, 0);
    assert.ok(f.renderer.stats.drawCalls > 0);
    assert.equal(bufferOf(f, "cull.visibility").u32.every((v) => v === 0), true);

    // Switching back to the twin puts the CPU's numbers back and takes the pass out of the frame; a
    // round trip to "gpu" has to bring it back with it (a released culler must not be kept: a
    // disposed one records nothing, and the frame would then read a stale buffer).
    f.renderer.objectCulling = "cpu";
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    assertNotContains(f.renderer.passNames, "forge.objects.cull");
    assert.equal(f.renderer.stats.cullTested, f.renderer.stats.batches);
    const before = f.mock.commandLog.length;
    f.renderer.objectCulling = "gpu";
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    assertContains(f.renderer.passNames, "forge.objects.cull");
    assertContains(f.mock.commandLog.slice(before).filter((e) => e.type === "dispatch").map((e) => e["label"]), "objects.cull");
    await f.dispose();
  });

  test("submits the frame through the culler's records, and a culled batch's draw carries no instances", async () => {
    const f = await fixture();
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    const batches = f.renderer.stats.batches;
    // The records are one slot per batch, and the slot's stride is the constant the draw loop indexes
    // with (8 words, so every offset is 16-aligned for `drawIndexedIndirect`).
    const records = bufferOf(f, "cull.drawRecords");
    assert.ok(records.size >= batches * DRAW_RECORD_BYTES);
    assert.ok(records.u32[0] > 0); // the batch's index count
    assert.equal(records.u32[DRAW_RECORD_INSTANCES], 1); // one instance per batch in this fixture
    // Every main-pass draw went through a record, and the mock reads the record out of the buffer —
    // so this is the device-side instance count, not the renderer's intention.
    // (The shadow and prepass draws are direct, so the claim is the count: `indirectDraws` increments
    // once per main-pass draw, and the log has that many indirect records read out of the buffer.)
    const indirect = f.mock.commandLog.filter((e) => e.type === "drawIndexed" && e["indirect"] === true);
    assert.equal(f.renderer.stats.indirectDraws, batches);
    assert.equal(indirect.length, f.renderer.stats.indirectDraws);
    assert.equal(indirect.every((e) => e["instanceCount"] === 1), true);
    assert.equal(f.renderer.stats.cullVisible, batches);
    assert.equal(f.renderer.stats.cullRecordZeroed, 0);

    // Point the camera at the sky: whatever it can no longer see gets a zero-instance record, and the
    // compaction list names the batches that survived.
    const cam = f.scene.findCamera()!;
    cam.entity.transform.lookAt(new Vec3(0, 200, 0));
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    const s = f.renderer.stats;
    assert.ok(s.cullFrustum > 0);
    assert.equal(s.cullVisible, s.batches - s.cullFrustum - s.cullDistance - s.cullOccluded);
    assert.equal(s.cullRecordZeroed, s.cullFrustum + s.cullDistance + s.cullOccluded);
    const after = bufferOf(f, "cull.drawRecords");
    let zeroed = 0;
    for (let i = 0; i < s.batches; i++) {
      if (after.u32[i * DRAW_RECORD_WORDS + DRAW_RECORD_INSTANCES] === 0) zeroed++;
    }
    assert.equal(zeroed, s.cullRecordZeroed);
    const list = bufferOf(f, "cull.visibleBatches");
    const listed = [...list.u32.slice(0, s.cullVisible)];
    assert.equal(new Set(listed).size, listed.length);
    assert.equal(listed.every((index) => index < s.batches), true);
    // Every listed batch is one the records left drawable, and every unlisted one is zeroed: the list
    // and the records are the same verdict, which is what a consumer of either relies on.
    for (let i = 0; i < s.batches; i++) {
      const visible = listed.includes(i);
      assert.equal(after.u32[i * DRAW_RECORD_WORDS + DRAW_RECORD_INSTANCES] > 0, visible);
    }
    await f.dispose();
  });

  test("saves the culled batches' vertex work, which the direct path still pays", async () => {
    // Phase 13.5 collapsed a culled batch's clip position, which still ran the vertex stage for every
    // instance of it; a zero-instance record is a draw the device does not run at all. Both arms draw
    // the same frame (check:browser compares the pixels), and this is what one of them does not do.
    //
    // The batch here is culled by *distance*, not by the camera: an off-screen caster would have been
    // marked shadow-only and never reached the main pass, and then the two arms would agree by
    // accident. A distance-culled batch is in the frame the CPU built and dropped by the device alone.
    const f = await fixture({ boxDistance: 1 });
    const beforeIndirect = f.mock.verticesDrawn;
    f.renderer.renderScene(f.scene);
    const indirect = { vertices: f.mock.verticesDrawn - beforeIndirect, zeroed: f.renderer.stats.cullRecordZeroed, calls: f.renderer.stats.drawCalls };
    assert.ok(f.renderer.stats.cullDistance > 0);
    assert.equal(indirect.zeroed, f.renderer.stats.cullDistance);

    f.renderer.indirectDraws = false;
    const beforeDirect = f.mock.verticesDrawn;
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    const direct = { vertices: f.mock.verticesDrawn - beforeDirect, calls: f.renderer.stats.drawCalls };
    // The same verdicts and the same issued calls — the difference is the shading the culled batches
    // no longer pay for, and it is exactly their vertex count (the batch counts travel in the bounds).
    assert.equal(direct.calls, indirect.calls);
    assert.equal(f.renderer.stats.indirectDraws, 0);
    assert.ok(direct.vertices > indirect.vertices);
    // ...and the difference is exactly the culled batches' vertices: their index count (the record's
    // first word) times their instance count (which rides in the bounds entry, `max.w`). The records
    // still hold the indirect frame's verdicts: a direct frame uploads none.
    // The counts come from the per-batch uniform blocks: one 256-byte slot per batch, in batch order
    // (`reserveObject`), which is the same order the records and the visibility words are in.
    const uniforms = bufferOf(f, "draw.uniforms");
    const countWord = ObjectUniforms.offsetOf("instanceCount", "uniform") >> 2;
    const records = bufferOf(f, "cull.drawRecords").u32;
    let culledVertices = 0;
    for (let i = 0; i < f.renderer.stats.batches; i++) {
      if (records[i * DRAW_RECORD_WORDS + DRAW_RECORD_INSTANCES] !== 0) continue;
      culledVertices += records[i * DRAW_RECORD_WORDS]! * uniforms.u32[i * 64 + countWord]!;
    }
    assert.ok(culledVertices > 0);
    assert.equal(direct.vertices - indirect.vertices, culledVertices);
    await f.dispose();
  });

  test("writes records only when the frame asks for them", async () => {
    const f = await fixture({ renderer: { objectCulling: "gpu" } });
    const flags = () => bufferOf(f, "objects.cull.uniforms").u32[ObjectCullUniforms.offsetOf("flags", "uniform") >> 2]!;
    f.renderer.renderScene(f.scene);
    assert.equal(flags() & CULL_FLAG_RECORDS, CULL_FLAG_RECORDS);

    f.renderer.indirectDraws = false;
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    assert.equal(flags() & CULL_FLAG_RECORDS, 0);
    assert.equal(f.renderer.stats.indirectDraws, 0);
    // The direct path still pays for every batch's vertices, which is the whole difference.
    const writes = bufferOf(f, "cull.drawRecords").writeCount;
    f.renderer.renderScene(f.scene);
    assert.equal(bufferOf(f, "cull.drawRecords").writeCount, writes);

    f.renderer.objectCulling = "cpu";
    f.renderer.indirectDraws = true;
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    // The twin writes the record words itself, and the frame is submitted through them.
    assert.ok(f.renderer.stats.indirectDraws > 0);
    await f.dispose();
  });

  test("skips the occlusion stage when the renderer is told to, and finds it again after", async () => {
    // The pyramid outlives the frame (it is the size of the target), so "does this frame occlude" has
    // to be per-frame state: a frame with no pyramid passes that still declared `forge.hiz.0` would
    // read a depth buffer nothing wrote, and the graph would refuse the frame.
    const f = await fixture({ renderer: { objectCulling: "gpu" } });
    f.renderer.renderScene(f.scene);
    assertContains(f.renderer.passNames, "forge.hiz.0");

    f.renderer.occlusionCulling = false;
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    assertContains(f.renderer.passNames, "forge.objects.cull");
    assert.equal(f.renderer.passNames.some((p) => p.startsWith("forge.hiz")), false);

    f.renderer.occlusionCulling = true;
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    assertContains(f.renderer.passNames, "forge.hiz.0");
    await f.dispose();
  });
});

await finish();
