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

import { describe, expect, it } from "vitest";
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
  MAX_SPOT_SHADOWS,
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
      expect(mock.outstanding.buffers).toEqual([]);
      expect(mock.outstanding.textures).toEqual([]);
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
  expect(buffer, "ssao.uniforms buffer").toBeDefined();
  return { f32: new Float32Array(buffer!.data), u32: new Uint32Array(buffer!.data) };
}

describe("frame structure", () => {
  it("publishes asynchronous GPU render and compute timings through Renderer.stats", async () => {
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
    expect(f.renderer.stats.gpuTimingAvailable).toBe(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(f.renderer.stats.gpuFrameTimeMs).toBeGreaterThan(0);
    expect(profiler.lastFrame()?.gpuMs).toBe(f.renderer.stats.gpuFrameTimeMs);
    expect(profiler.scopeStats("lights.assign")?.gpuMs).toBeGreaterThan(0);
    expect(f.renderer.stats.gpuRenderTimeMs).toBeGreaterThan(0);
    expect(f.renderer.stats.gpuComputeTimeMs).toBeGreaterThan(0);
    expect(f.renderer.stats.gpuPassTimes.some((pass) => pass.kind === "compute" && pass.name === "lights.assign")).toBe(true);
    expect(f.mock.errors).toEqual([]);
    await f.dispose();
  });

  it("HDR: cascades, forward pass into rgba16float, a bloom chain and the tonemap resolve", async () => {
    const f = await fixture();
    f.scene.settings.shadow.cascades = 2;
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(labels(f)).toEqual([
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
    expect(s.hdr).toBe(true);
    expect(s.bloomMips).toBe(3); // 180 px tall → 90, 45, 22 (next would be 11 < 16)
    expect(s.shadowCascades).toBe(2);
    expect(s.shadowsDrawn).toBe(2); // one caster batch × two cascades
    expect(s.prepassDraws).toBe(2); // ground + box, depth only (not counted in drawCalls, like shadows)
    expect(s.drawCalls).toBe(2 + 3 + 6); // ground + box, three SSAO and six post fullscreen draws
    expect(s.triangles).toBe(2 + 12); // fullscreen draws are not scene geometry
    expect(s.passes).toBe(13);
    expect(s.culledPasses).toBe(0);
    // Transients: atlas, hdr, depth, 3 AO targets, 3 bloom mips — the AO estimate and the AO result
    // share one physical texture (160x90 rg16float: 4 bytes a pixel).
    expect(s.transientTextures).toBe(9);
    expect(s.physicalTextures).toBe(8);
    expect(s.aliasedBytes).toBe(160 * 90 * 4);
    const main = f.mock.passes[6]!;
    expect(main.label).toBe("forge.main");
    expect(main.colorTargets[0]).toContain("rgba16float");
    expect(main.depthTarget).toContain("depth24plus");
    expect(f.mock.passes[12]!.colorTargets).toEqual(["swapchain"]);
    await f.dispose();
  });

  it("LDR: the forward pass writes the swapchain directly and no post pass exists", async () => {
    const f = await fixture();
    f.scene.settings.hdr = false;
    f.scene.settings.shadow.cascades = 1;
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(labels(f)).toEqual(["forge.shadow.0", ...PREPASS_SSAO, "forge.main"]);
    expect(f.mock.passes[5]!.colorTargets).toEqual(["swapchain"]);
    expect(f.renderer.stats.hdr).toBe(false);
    expect(f.renderer.stats.bloomMips).toBe(0);
    await f.dispose();
  });

  it("bloom and shadows are individually switchable, and the quality profile caps the scene", async () => {
    const f = await fixture({ renderer: { shadowCascades: 2, shadowMapSize: 256 } });
    // Without the prepass the chain is exactly the pre-prepass frame (the prepass has its own suite).
    f.scene.settings.depthPrepass = false;
    f.scene.settings.shadow.cascades = 4; // asks for 4; the profile allows 2
    f.scene.settings.shadow.mapSize = 2048; // asks for 2048; the profile allows 256
    f.scene.settings.bloom.enabled = false;
    f.renderer.renderScene(f.scene);
    expect(labels(f)).toEqual(["forge.shadow.0", "forge.shadow.1", "forge.main", "forge.tonemap"]);
    expect(f.mock.passes[0]!.depthTarget).toContain("256x256x2");

    f.mock.passes.length = 0;
    f.scene.settings.shadow.enabled = false;
    f.scene.settings.bloom.enabled = true;
    f.renderer.renderScene(f.scene);
    expect(labels(f).filter((l) => l.startsWith("forge.shadow."))).toEqual([]);
    expect(labels(f).filter((l) => l.startsWith("forge.bloom."))).toHaveLength(5);
    expect(f.renderer.stats.shadowCascades).toBe(0);

    f.mock.passes.length = 0;
    f.scene.settings.shadow.enabled = true;
    f.scene.settings.postProcessing = false; // kills bloom, keeps the HDR resolve
    f.renderer.renderScene(f.scene);
    expect(labels(f)).toEqual(["forge.shadow.0", "forge.shadow.1", "forge.main", "forge.tonemap"]);

    f.mock.passes.length = 0;
    f.sun.castShadow = false; // no caster light → no cascades, even with shadows enabled
    f.renderer.renderScene(f.scene);
    expect(labels(f)).toEqual(["forge.main", "forge.tonemap"]);
    expect(f.mock.errors).toEqual([]);
    await f.dispose();
  });

  it("renders spot maps after cascades and preserves spot indices on both light paths", async () => {
    const f = await fixture();
    f.scene.settings.hdr = false;
    f.scene.settings.depthPrepass = false;
    f.scene.settings.shadow.cascades = 2;
    f.scene.settings.clusteredLighting = false;
    const testSpot = addSpotLight(f, "test-spot", new Vec3(0, 4, 2));
    testSpot.innerCone = 0.5;
    testSpot.outerCone = 0.85; // renderer orders the cosine edges so WGSL never receives reversed smoothstep bounds
    f.renderer.renderScene(f.scene);

    expect(f.mock.errors).toEqual([]);
    expect(labels(f)).toEqual(["forge.shadow.0", "forge.shadow.1", "forge.shadow.spot.0", "forge.main"]);
    expect(f.mock.passes[0]!.depthTarget).toContain("256x256x3");
    expect(f.mock.passes[2]!.drawCalls).toBeGreaterThan(0);
    expect(f.renderer.stats.shadowCascades).toBe(2);
    expect(f.renderer.stats.spotShadowMaps).toBe(1);

    const shadow = bufferOf(f, "shadow.uniforms");
    expect(shadow.i32[ShadowUniforms.offsetOf("count") >> 2]).toBe(2);
    expect(shadow.i32[ShadowUniforms.offsetOf("spotCount") >> 2]).toBe(1);
    const spotMatrix = ShadowUniforms.offsetOf("spotViewProj") >> 2;
    expect(Array.from(shadow.f32.slice(spotMatrix, spotMatrix + 16)).every(Number.isFinite)).toBe(true);
    const spotParams = ShadowUniforms.offsetOf("spotParams") >> 2;
    expect(shadow.f32[spotParams]).toBeCloseTo(1 / 256, 7);

    const uniformLights = bufferOf(f, "lights.uniforms");
    const uniformRecords = LightBlock.field("lights", "uniform");
    const uniformSpot = (uniformRecords.offset + uniformRecords.stride!) / 4;
    expect(uniformLights.i32[uniformSpot + (LightUniforms.offsetOf("shadowIndex") >> 2)]).toBe(0);
    expect(uniformLights.f32[uniformSpot + (LightUniforms.offsetOf("spotAngles") >> 2)]).toBeCloseTo(0.85, 6);
    expect(uniformLights.f32[uniformSpot + (LightUniforms.offsetOf("spotAngles") >> 2) + 1]).toBeCloseTo(0.5, 6);

    // The same spot moves into the cluster storage block without losing its shadow slot.
    f.mock.passes.length = 0;
    f.scene.settings.clusteredLighting = true;
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(labels(f)).toEqual(["forge.shadow.0", "forge.shadow.1", "forge.shadow.spot.0", "forge.main"]);
    const clusteredLights = bufferOf(f, "cluster.lights");
    const clusterRecords = ClusterLightBlock.field("lights", "storage");
    const clusterSpot = clusterRecords.offset / 4;
    expect(clusteredLights.i32[clusterSpot + (LightUniforms.offsetOf("shadowIndex") >> 2)]).toBe(0);
    expect(f.renderer.stats.spotShadowMaps).toBe(1);
    await f.dispose();
  });

  it("caps spot maps at four and supports spotlight-only shadow frames", async () => {
    const f = await fixture();
    f.scene.settings.hdr = false;
    f.scene.settings.depthPrepass = false;
    f.scene.settings.clusteredLighting = false;
    for (let i = 0; i < MAX_SPOT_SHADOWS + 1; i++) {
      addSpotLight(f, `capacity-spot-${i}`, new Vec3(0, 4, 2));
    }
    f.renderer.renderScene(f.scene);
    expect(f.renderer.stats.shadowCascades).toBeGreaterThan(0);
    expect(f.renderer.stats.spotShadowMaps).toBe(MAX_SPOT_SHADOWS);

    // Drop the sun after the first frame: the reused cascade array must not leak its old count into a spot-only frame.
    f.mock.passes.length = 0;
    f.sun.castShadow = false;
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(labels(f)).toEqual([
      "forge.shadow.spot.0",
      "forge.shadow.spot.1",
      "forge.shadow.spot.2",
      "forge.shadow.spot.3",
      "forge.main",
    ]);
    expect(f.mock.passes[0]!.depthTarget).toContain(`256x256x${MAX_SPOT_SHADOWS}`);
    expect(f.renderer.stats.shadowCascades).toBe(0);
    expect(f.renderer.stats.spotShadowMaps).toBe(MAX_SPOT_SHADOWS);
    const shadow = bufferOf(f, "shadow.uniforms");
    expect(shadow.i32[ShadowUniforms.offsetOf("count") >> 2]).toBe(0);
    expect(shadow.i32[ShadowUniforms.offsetOf("spotCount") >> 2]).toBe(MAX_SPOT_SHADOWS);
    const frame = bufferOf(f, "perframe.uniforms");
    expect(frame.i32[PerFrameUniforms.offsetOf("cascadeCount") >> 2]).toBe(0);
    const records = LightBlock.field("lights", "uniform");
    const lights = bufferOf(f, "lights.uniforms");
    const shadowIndexWord = LightUniforms.offsetOf("shadowIndex") >> 2;
    const strideWords = records.stride! / 4;
    for (let i = 0; i < MAX_SPOT_SHADOWS; i++) {
      expect(lights.i32[records.offset / 4 + (i + 1) * strideWords + shadowIndexWord]).toBe(i);
    }
    expect(lights.i32[records.offset / 4 + (MAX_SPOT_SHADOWS + 1) * strideWords + shadowIndexWord]).toBe(-1);
    await f.dispose();
  });

  it("casters outside the view frustum still render into the cascades they intersect", async () => {
    // A box behind the camera's back is frustum-culled for the colour pass but sits well inside the
    // first cascade's light-space box, so it must still cast.
    const f = await fixture({ extraBoxes: [new Vec3(0, 0.75, -12)] });
    f.scene.settings.shadow.cascades = 1;
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    const s = f.renderer.stats;
    expect(s.culled).toBe(1);
    expect(s.drawCalls - 3 - 6).toBe(2); // ground + visible box; the culled one is not drawn in forge.main
    expect(s.prepassDraws).toBe(2); // ...nor in the depth prepass
    expect(f.mock.passes[0]!.drawCalls).toBe(2); // ...but both boxes reach the shadow pass
    expect(s.shadowsDrawn).toBe(2);
    await f.dispose();
  });

  it("assigns per-object cascade ranges without splitting the colour batch", async () => {
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
    expect(pair, "fixture has two visible casters with overlapping, distinct cascade masks").not.toBeNull();
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
    expect(f.renderer.stats.batches).toBe(2); // ground + one shared colour batch for both casters
    expect(f.renderer.stats.shadowInstancesDrawn).toBe(expectedInstances);
    expect(f.renderer.stats.shadowInstancesCulled).toBe(8 - expectedInstances);
    expect(f.renderer.stats.shadowsDrawn).toBe(expectedInstances); // masks differ, so each assigned range is submitted separately

    for (let cascade = 0; cascade < 4; cascade++) {
      const expectedFirstInstances = selected.flatMap((candidate, index) => (candidate.mask & (1 << cascade)) !== 0 ? [index] : []);
      const pass = f.mock.passes.find((record) => record.label === `forge.shadow.${cascade}`)!;
      expect(pass.instances).toBe(expectedFirstInstances.length);
      const actualFirstInstances = f.mock.commandLog
        .filter((entry) => entry.label === `forge.shadow.${cascade}` && entry.type === "drawIndexed")
        .map((entry) => Number(entry["firstInstance"]));
      expect(actualFirstInstances).toEqual(expectedFirstInstances);
    }
    expect(f.mock.errors).toEqual([]);
    await f.dispose();
  });

  it("allocates no textures on a steady frame and rebuilds only what a resize changes", async () => {
    const f = await fixture();
    f.scene.settings.shadow.cascades = 2;
    f.renderer.renderScene(f.scene);
    // The device's own accounting (Phase 9.3) counts every allocation, including the raw
    // `device.device.create*` calls the renderer makes internally. (The old assertions read
    // `mock.texturesCreated`, which never existed — they compared `undefined` to `undefined`.)
    const created = f.device.gpuMemory.texturesCreated;
    const buffers = f.device.gpuMemory.buffersCreated;
    for (let i = 0; i < 4; i++) f.renderer.renderScene(f.scene);
    expect(f.device.gpuMemory.texturesCreated).toBe(created);
    expect(f.device.gpuMemory.buffersCreated).toBe(buffers);
    expect(f.renderer.stats.texturesCreated).toBe(0);

    // Resize: frame-sized transients (hdr, depth, AO, bloom mips) are re-planned, the shadow atlas is
    // not. (200x120 shares no shape with the 320x180 frame; a half-size resize would re-use old mips.)
    f.renderer.resize(200, 120);
    f.renderer.renderScene(f.scene);
    expect(f.renderer.stats.bloomMips).toBe(2);
    expect(f.renderer.stats.texturesCreated).toBe(2 + 2 + 2); // hdr + depth, two AO (one aliased), two mips
    // The old shapes survive two idle frames (a toggle that flips back costs nothing), then go away.
    f.renderer.renderScene(f.scene);
    const outstandingBefore = f.mock.outstanding.textures.filter((t) => t.startsWith("rg.")).length;
    f.renderer.renderScene(f.scene);
    const outstandingAfter = f.mock.outstanding.textures.filter((t) => t.startsWith("rg.")).length;
    expect(outstandingBefore - outstandingAfter).toBe(2 + 2 + 3); // old hdr + depth, two AO, three bloom mips
    expect(f.renderer.stats.texturesCreated).toBe(0);
    expect(f.mock.errors).toEqual([]);
    await f.dispose();
  });

  it("switching HDR off and on and toggling shadows leaks nothing and stays valid", async () => {
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
      expect(f.mock.errors, `hdr=${hdr} shadows=${shadows}`).toEqual([]);
    }
    expect(f.renderer.passNames).toContain("forge.tonemap");
    await f.dispose();
  });

  it("sky: a fullscreen pass after forge.main over the same target, depth loaded explicitly", async () => {
    const f = await fixture();
    f.scene.settings.shadow.cascades = 1;
    f.scene.setSky({ quality: "low" });
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(labels(f)).toEqual([
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
    expect(main.depthStoreOp).toBe("store");
    expect(sky.depthLoadOp).toBe("load");
    expect(sky.depthStoreOp).toBe("store");
    expect(sky.depthTarget).toBe(main.depthTarget);
    expect(sky.colorTargets).toEqual(main.colorTargets);
    expect(sky.drawCalls).toBe(1);
    expect(sky.triangles).toBe(1);
    const s = f.renderer.stats;
    expect(s.sky).toBe(true);
    expect(s.drawCalls).toBe(2 + 1 + 3 + 6);
    expect(s.transientTextures).toBe(9); // the sky adds no texture: it draws into scene.hdr
    expect(s.passes).toBe(13);

    // Steady state: nothing is (re)created for the sky.
    const created = f.device.gpuMemory.texturesCreated;
    const buffers = f.device.gpuMemory.buffersCreated;
    for (let i = 0; i < 3; i++) f.renderer.renderScene(f.scene);
    expect(f.device.gpuMemory.texturesCreated).toBe(created);
    expect(f.device.gpuMemory.buffersCreated).toBe(buffers);
    expect(f.renderer.stats.texturesCreated).toBe(0);

    // LDR: the sky writes the swapchain directly, after the forward pass.
    f.mock.passes.length = 0;
    f.scene.settings.hdr = false;
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(labels(f)).toEqual(["forge.shadow.0", ...PREPASS_SSAO, "forge.main", "forge.sky"]);
    expect(f.mock.passes[6]!.colorTargets).toEqual(["swapchain"]);
    expect(f.mock.passes[5]!.depthStoreOp).toBe("store");

    // Off again (a solid background): no sky pass, and the depth buffer goes back to being discarded.
    f.mock.passes.length = 0;
    f.scene.setBackgroundColor(0x102030);
    f.renderer.renderScene(f.scene);
    expect(labels(f)).toEqual(["forge.shadow.0", ...PREPASS_SSAO, "forge.main"]);
    expect(f.mock.passes[5]!.depthStoreOp).toBe("discard");
    expect(f.renderer.stats.sky).toBe(false);

    // The quality profile can cap the march or veto the pass regardless of the scene.
    f.scene.setSky({ quality: "high" });
    f.renderer.renderScene(f.scene);
    expect(f.renderer.stats.skySamples).toBe(32);
    const capped = new Renderer(f.device, { shadowMapSize: 256, skyQuality: "low" });
    capped.renderScene(f.scene);
    expect(capped.stats.sky).toBe(true);
    expect(capped.stats.skySamples).toBe(8);
    capped.dispose();
    const vetoed = new Renderer(f.device, { shadowMapSize: 256, sky: false });
    f.mock.passes.length = 0;
    vetoed.renderScene(f.scene);
    expect(labels(f)).not.toContain("forge.sky");
    expect(vetoed.stats.skySamples).toBe(0);
    vetoed.dispose();
    expect(f.mock.errors).toEqual([]);
    await f.dispose();
  });

  it("sky: the sun comes from the settings, then the per-frame override, then the directional light", async () => {
    const f = await fixture();
    f.scene.settings.shadow.enabled = false;
    f.scene.settings.hdr = false;
    f.scene.setSky({ sunDirection: new Vec3(0, 2, 0) });
    expect(f.scene.settings.sky.sunDirection!.y).toBe(1); // normalised copy
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(labels(f)).toEqual([...PREPASS_SSAO, "forge.main", "forge.sky"]);
    // A one-frame override is consumed by the next frame and does not persist.
    f.renderer.setSkyOverride({ exposure: 0.5, quality: "high" });
    f.renderer.renderScene(f.scene);
    expect(f.renderer.skyOverride).toBeNull();
    expect(f.scene.settings.sky.exposure).toBe(1);
    // Without an explicit direction the first directional light is the sun; without any light a
    // default is used — both must render cleanly.
    f.scene.settings.sky.sunDirection = null;
    f.renderer.renderScene(f.scene);
    f.scene.world.removeComponent(f.sun.entity, Light);
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(f.renderer.passNames).toContain("forge.sky");
    await f.dispose();
  });

  it("a frame without a camera clears the swapchain and still counts as rendered", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const renderer = new Renderer(device, { shadowMapSize: 256 });
    const scene = new Scene({ name: "empty" });
    renderer.renderScene(scene);
    expect(device.mock.passes.map((p) => p.label)).toEqual(["forge.clear"]);
    expect(renderer.framesRendered).toBe(1);
    expect(device.mock.errors).toEqual([]);
    scene.dispose();
    renderer.dispose();
    await device.dispose();
    expect(device.mock.outstanding.textures).toEqual([]);
  });
});

describe("depth prepass and SSAO", () => {
  it("the prepass lays the opaque depth down; forge.main loads it and never re-writes it", async () => {
    const f = await fixture();
    f.scene.settings.shadow.cascades = 1;
    f.mock.commandLog.length = 0;
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    const at = (name: string) => f.mock.passes.find((p) => p.label === name)!;
    const prepass = at("forge.prepass");
    const main = at("forge.main");
    // Depth only: no colour target; cleared, then stored for SSAO and the forward pass.
    expect(prepass.colorTargets).toEqual([]);
    expect(prepass.depthTarget).toContain("depth24plus");
    expect(prepass.depthLoadOp).toBe("clear");
    expect(prepass.depthStoreOp).toBe("store");
    expect(prepass.drawCalls).toBe(2);
    expect(prepass.triangles).toBe(2 + 12);
    // The forward pass continues on that depth buffer instead of clearing it...
    expect(main.depthTarget).toBe(prepass.depthTarget);
    expect(main.depthLoadOp).toBe("load");
    // ...with the depth-only prepass variant laying it down, and the forward pipelines for the same
    // surfaces testing against it without writing.
    const prepassDraws = drawPipelines(f, "forge.prepass");
    expect(prepassDraws).toHaveLength(2);
    for (const p of prepassDraws) expect(p).toMatch(/^pipeline\.prepass\|none\|depth24plus\|/);
    const forward = drawPipelines(f, "forge.main");
    expect(forward).toHaveLength(2);
    for (const p of forward) expect(p).toContain("|nodepthwrite|");
    const s = f.renderer.stats;
    expect(s.depthPrepass).toBe(true);
    expect(s.prepassDraws).toBe(2);
    expect(s.drawCalls).toBe(2 + 3 + 6); // prepass draws are reported apart, like shadowsDrawn
    await f.dispose();
  });

  it("transparent, cutout, fading and overlay surfaces stay out of the prepass and keep writing depth", async () => {
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
    expect(f.mock.errors).toEqual([]);
    const s = f.renderer.stats;
    expect(s.culled).toBe(0);
    expect(s.depthPrepass).toBe(true);
    expect(s.prepassDraws).toBe(2); // the ground and the opaque box only
    const forward = drawPipelines(f, "forge.main");
    expect(forward).toHaveLength(6);
    // The two prepassed surfaces shade without writing depth; the other four draw exactly as they
    // would with no prepass at all, depth writes included.
    expect(forward.filter((p) => p.includes("|nodepthwrite|"))).toHaveLength(2);
    expect(forward.filter((p) => p.includes("|depthwrite|"))).toHaveLength(4);
    expect(f.mock.passes.find((p) => p.label === "forge.prepass")!.drawCalls).toBe(2);

    // Nothing eligible at all (everything transparent): no prepass pass, and so no SSAO either.
    f.mock.passes.length = 0;
    const all = f.scene.world.query([Renderable]);
    all.refresh();
    for (let i = 0; i < all.count; i++) f.scene.world.getComponent(all.entity(i), Renderable)!.transparent = true;
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(labels(f)[0]).toBe("forge.main");
    expect(labels(f).filter((l) => l.startsWith("forge.prepass") || l.startsWith("forge.ssao"))).toEqual([]);
    expect(f.renderer.stats.depthPrepass).toBe(false);
    expect(f.renderer.stats.ssao).toBe(false);
    expect(f.mock.passes[0]!.depthLoadOp).toBe("clear");
    box.dispose();
    for (const m of [cutout, fading, glass]) m.dispose();
    await f.dispose();
  });

  it("SSAO: a half-resolution estimate and a separable blur, the estimate's target aliased into the result", async () => {
    const f = await fixture();
    f.scene.settings.shadow.cascades = 1;
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    const at = (name: string) => f.mock.passes.find((p) => p.label === name)!;
    const estimate = at("forge.ssao");
    const blurH = at("forge.ssao.blur.h");
    const blurV = at("forge.ssao.blur.v");
    for (const pass of [estimate, blurH, blurV]) {
      expect(pass.colorTargets).toHaveLength(1);
      expect(pass.colorTargets[0]).toContain("160x90"); // half of 320x180
      expect(pass.colorTargets[0]).toContain("rg16float");
      expect(pass.depthTarget).toBeNull();
      expect(pass.drawCalls).toBe(1);
      expect(pass.triangles).toBe(1);
    }
    // The estimate's texture is dead once the horizontal blur has read it: the vertical blur writes
    // the very same physical texture, and the graph reports the bytes that saved.
    expect(blurV.colorTargets[0]).toBe(estimate.colorTargets[0]);
    expect(blurH.colorTargets[0]).not.toBe(estimate.colorTargets[0]);
    const s = f.renderer.stats;
    expect(s.ssao).toBe(true);
    expect(s.aliasedBytes).toBe(160 * 90 * 4);
    expect(s.physicalTextures).toBe(s.transientTextures - 1);

    // The uniform block: inverse projection, pixels-per-metre at depth 1, both extents, clamps.
    let u = ssaoUniforms(f);
    const tanHalf = Math.tan(f.camera.fovY / 2);
    expect(u.f32[16]).toBeCloseTo(f.scene.settings.ssao.radius, 6); // radius
    expect(u.f32[19]).toBeCloseTo((0.5 * 180) / tanHalf, 3); // projScale
    expect([u.f32[20], u.f32[21], u.f32[22], u.f32[23]]).toEqual([320, 180, 160, 90]);
    expect(u.u32[24]).toBe(12); // sampleCount
    expect(u.f32[1 * 4 + 1]).toBeCloseTo(tanHalf, 5); // invProj[1][1] = 1 / m[5]
    f.scene.settings.ssao.samples = 500;
    f.renderer.renderScene(f.scene);
    u = ssaoUniforms(f);
    expect(u.u32[24]).toBe(32);
    f.scene.settings.ssao.samples = 0;
    f.renderer.renderScene(f.scene);
    expect(ssaoUniforms(f).u32[24]).toBe(1);
    expect(f.mock.errors).toEqual([]);
    await f.dispose();
  });

  it("SSAO needs the prepass and a perspective camera; the scene and the quality profile switch either off", async () => {
    const f = await fixture();
    f.scene.settings.shadow.enabled = false;
    f.scene.settings.hdr = false;
    const run = (renderer = f.renderer) => {
      f.mock.passes.length = 0;
      f.mock.commandLog.length = 0;
      renderer.renderScene(f.scene);
      expect(f.mock.errors).toEqual([]);
      return labels(f);
    };
    expect(run()).toEqual([...PREPASS_SSAO, "forge.main"]);

    // SSAO off: the prepass stays (it pays for itself), the AO passes go, the AO flag clears.
    f.scene.settings.ssao.enabled = false;
    expect(run()).toEqual(["forge.prepass", "forge.main"]);
    expect(f.renderer.stats.ssao).toBe(false);
    expect(f.renderer.stats.depthPrepass).toBe(true);
    expect(f.mock.passes[1]!.depthLoadOp).toBe("load");
    f.scene.settings.ssao.enabled = true;
    f.scene.settings.ssao.intensity = 0; // nothing to apply: nothing computed
    expect(run()).toEqual(["forge.prepass", "forge.main"]);
    f.scene.settings.ssao.intensity = 1;

    // Prepass off: SSAO has no depth to read, and forge.main clears and writes depth itself again.
    f.scene.settings.depthPrepass = false;
    expect(run()).toEqual(["forge.main"]);
    expect(f.mock.passes[0]!.depthLoadOp).toBe("clear");
    for (const p of drawPipelines(f, "forge.main")) expect(p).toContain("|depthwrite|");
    expect(f.renderer.stats.depthPrepass).toBe(false);
    expect(f.renderer.stats.prepassDraws).toBe(0);
    expect(f.renderer.stats.ssao).toBe(false);
    f.scene.settings.depthPrepass = true;

    // Orthographic camera: the prepass runs, SSAO does not (its bilateral key is perspective clip.w).
    f.camera.setOrthographic(10, 16 / 9, 0.1, 100);
    expect(run()).toEqual(["forge.prepass", "forge.main"]);
    f.camera.setPerspective(Math.PI / 3, 16 / 9, 0.1, 100);
    expect(run()).toEqual([...PREPASS_SSAO, "forge.main"]);

    // The quality profile vetoes either, whatever the scene asks for.
    const noPrepass = new Renderer(f.device, { shadowMapSize: 256, depthPrepass: false });
    expect(run(noPrepass)).toEqual(["forge.main"]);
    expect(noPrepass.stats.ssao).toBe(false);
    noPrepass.dispose();
    const noSsao = new Renderer(f.device, { shadowMapSize: 256, ssao: false });
    expect(run(noSsao)).toEqual(["forge.prepass", "forge.main"]);
    noSsao.dispose();
    await f.dispose();
  });

  it("allocates nothing on a steady SSAO frame, and switching it all on and off leaks nothing", async () => {
    const f = await fixture();
    f.scene.settings.shadow.cascades = 2;
    f.renderer.renderScene(f.scene);
    f.renderer.renderScene(f.scene);
    const created = f.device.gpuMemory.texturesCreated;
    const buffers = f.device.gpuMemory.buffersCreated;
    for (let i = 0; i < 4; i++) f.renderer.renderScene(f.scene);
    expect(f.device.gpuMemory.texturesCreated).toBe(created);
    expect(f.device.gpuMemory.buffersCreated).toBe(buffers);
    expect(f.renderer.stats.texturesCreated).toBe(0);
    expect(f.renderer.stats.ssao).toBe(true);

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
      expect(f.mock.errors, `prepass=${prepass} ssao=${ssao} hdr=${hdr}`).toEqual([]);
      expect(f.renderer.stats.depthPrepass).toBe(prepass);
      expect(f.renderer.stats.ssao).toBe(prepass && ssao);
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
  expect(buffer, `"${label}" buffer`).toBeDefined();
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

describe("clustered (Forward+) lighting", () => {
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

  it("local lights go to the cluster grid and the uniform list keeps only the global ones", async () => {
    const f = await fixture();
    addPointLight(f, "lamp-a", -2, 1.5, 0);
    addPointLight(f, "lamp-b", 2, 1.5, 1, 4, 25);
    addPointLight(f, "lamp-c", 0, 2.5, -2, 8, 5);
    // Clustering changes what the fragment stage reads, not what the graph records: render the same
    // scene with it off and on and the pass list must be identical.
    f.scene.settings.clusteredLighting = false;
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    const unclustered = labels(f);
    f.mock.passes.length = 0;
    f.scene.settings.clusteredLighting = true;
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);

    const s = f.renderer.stats;
    expect(s.clusteredLighting).toBe(true);
    expect(s.lights).toBe(4); // the sun plus three lamps
    expect(s.clusteredLights).toBe(3);
    expect(s.clustersUsed).toBeGreaterThan(0);
    expect(s.clusterIndices).toBeGreaterThanOrEqual(s.clustersUsed);
    expect(s.maxLightsPerCluster).toBeGreaterThanOrEqual(1);
    expect(s.lightsDropped).toBe(false);

    // Clustering is a data change, not a pass: the frame structure is untouched.
    expect(labels(f)).toEqual(unclustered);
    expect(labels(f)).toContain("forge.main");
    expect(frameFlags(f) & 32).toBe(32);

    // The uniform block holds the directional light only (it is the cascade caster, index 0).
    const uniform = bufferOf(f, "lights.uniforms");
    expect(uniform.i32[0]).toBe(1);
    expect(uniform.i32[1]).toBe(1); // shadowedCount

    // The cluster block holds the three lamps, with the same record layout the uniform block uses.
    const clustered = bufferOf(f, "cluster.lights");
    expect(clustered.i32[0]).toBe(3);
    const stride = LIGHTS_OFFSET.stride! >> 2;
    const at = (i: number) => LIGHTS_OFFSET.offset / 4 + i * stride;
    expect(clustered.f32[at(0) + 3]).toBe(6); // lamp-a range
    expect(clustered.f32[at(1) + 3]).toBe(4); // lamp-b range
    expect(clustered.f32[at(1) + 2]).toBe(1); // lamp-b z
    expect(clustered.i32[at(0) + 14]).toBe(1); // kind: point
    expect(clustered.i32[at(0) + 15]).toBe(-1); // no shadow index: point shadows are 13.9
    expect(clustered.f32[at(2) + 7]).toBe(5); // lamp-c intensity (directionIntensity.w)

    // The quantisation block is what the fragment stage's cluster lookup runs on.
    const c = bufferOf(f, "cluster.uniforms");
    expect(c.f32[CLUSTER_FIELDS.gridScale >> 2]).toBe(CLUSTER_TILES_X);
    expect(c.f32[(CLUSTER_FIELDS.gridScale >> 2) + 1]).toBe(CLUSTER_TILES_Y);
    expect(c.f32[CLUSTER_FIELDS.slices >> 2]).toBe(CLUSTER_SLICES);
    expect(c.i32[CLUSTER_FIELDS.lightCount >> 2]).toBe(3);
    expect(c.i32[CLUSTER_FIELDS.stride >> 2]).toBe(MAX_LIGHTS_PER_CLUSTER);
    expect(c.f32[CLUSTER_FIELDS.invExtent >> 2]).toBeCloseTo(1 / 320, 9);
    expect(c.f32[(CLUSTER_FIELDS.invExtent >> 2) + 1]).toBeCloseTo(1 / 180, 9);
    await f.dispose();
  });

  it("uploads the grid the builder wrote: fixed-stride blocks, every list ascending and in range", async () => {
    const f = await fixture();
    for (let i = 0; i < 12; i++) addPointLight(f, `lamp${i}`, ((i % 4) - 1.5) * 3, 1 + (i % 3), ((i >> 2) - 1) * 3, 5, 5 + i);
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    const grid = bufferOf(f, "cluster.grid");
    const s = f.renderer.stats;
    const countsAt = ClusterGridBlock.offsetOf("counts", "storage") >> 2;
    const listAt = ClusterGridBlock.offsetOf("indices", "storage") >> 2;
    let total = 0;
    let nonEmpty = 0;
    for (let c = 0; c < CLUSTER_COUNT; c++) {
      const n = grid.u32[countsAt + c]!;
      expect(n).toBeLessThanOrEqual(MAX_LIGHTS_PER_CLUSTER); // the cap is the stride: never more
      total += n;
      if (n > 0) nonEmpty++;
    }
    expect(total).toBe(s.clusterIndices);
    expect(nonEmpty).toBe(s.clustersUsed);
    // Cluster c owns slots [c*MAX, c*MAX+n) of the list: lists are ascending (the shader's
    // accumulation order must not depend on the path) and every entry addresses a real light record.
    for (let c = 0; c < CLUSTER_COUNT; c++) {
      const n = grid.u32[countsAt + c]!;
      const start = listAt + c * MAX_LIGHTS_PER_CLUSTER;
      for (let k = 0; k < n; k++) expect(grid.u32[start + k]!).toBeLessThan(s.clusteredLights);
      for (let k = 1; k < n; k++) expect(grid.u32[start + k]!).toBeGreaterThan(grid.u32[start + k - 1]!);
    }
    expect(s.lightsDropped).toBe(false);
    await f.dispose();
  });

  it("the uploaded quantisation reproduces the builder's slice for any depth (CPU/GPU agreement)", async () => {
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
    expect(near).toBe(Math.fround(nearF64));
    expect(logNear).toBe(Math.fround(Math.log(nearF64)));
    expect(slices).toBe(CLUSTER_SLICES);
    expect(sliceScale).toBe(Math.fround(CLUSTER_SLICES / Math.log(far / nearF64)));
    // The shader computes clamp(i32((log(max(depth, near)) - logNear) * sliceScale), 0, slices-1);
    // clusterSliceFor is that expression in float64. They must land on the same slice across the
    // span, or the CPU builds a list the GPU indexes into the wrong way.
    for (const depth of [nearF64, nearF64 * 1.5, 0.5, 1, 3, 7.5, 12, far * 0.5, far, far * 2]) {
      const shaderSlice = Math.min(CLUSTER_SLICES - 1, Math.max(0, Math.trunc((Math.log(Math.max(depth, near)) - logNear) * sliceScale)));
      expect(shaderSlice, `depth ${depth}`).toBe(clusterSliceFor(depth, nearF64, far));
    }
    await f.dispose();
  });

  it("stays off for a directional-only scene, an orthographic camera, the scene switch and the profile veto", async () => {
    const f = await fixture();
    f.renderer.renderScene(f.scene);
    expect(f.renderer.stats.clusteredLighting).toBe(false); // no local lights at all
    expect(frameFlags(f) & 32).toBe(0);
    const gridWrites = bufferOf(f, "cluster.grid").writeCount;

    addPointLight(f, "lamp", 0, 1.5, 0);
    f.renderer.renderScene(f.scene);
    expect(f.renderer.stats.clusteredLighting).toBe(true);
    expect(bufferOf(f, "cluster.grid").writeCount).toBeGreaterThan(gridWrites);

    // Scene switch.
    f.scene.settings.clusteredLighting = false;
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(f.renderer.stats.clusteredLighting).toBe(false);
    expect(frameFlags(f) & 32).toBe(0);
    expect(bufferOf(f, "lights.uniforms").i32[0]).toBe(2); // both lights back in the uniform list
    expect(f.renderer.clusterBuildInfo).toBeNull();
    f.scene.settings.clusteredLighting = true;

    // Quality-profile veto (EngineConfig.clusteredLighting → RendererOptions).
    const veto = new Renderer(f.device, { shadowMapSize: 256, clusteredLighting: false });
    veto.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(veto.stats.clusteredLighting).toBe(false);
    expect(bufferOf(f, "lights.uniforms").i32[0]).toBe(2);
    veto.dispose();

    // Orthographic camera: clip.w is not a view depth, so there is no depth axis to cluster on.
    f.camera.setOrthographic(12, 16 / 9, 0.1, 100);
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(f.renderer.stats.clusteredLighting).toBe(false);
    expect(frameFlags(f) & 32).toBe(0);
    f.camera.setPerspective(Math.PI / 3, 16 / 9, 0.1, 100);
    f.renderer.renderScene(f.scene);
    expect(f.renderer.stats.clusteredLighting).toBe(true);
    await f.dispose();
  });

  it("carries more lights than the uniform list ever could, and reports the old cap honestly", async () => {
    const f = await fixture();
    const total = MAX_LIGHTS_PER_FRAME + 24; // 40 lamps: 2.5x the uniform block
    for (let i = 0; i < total; i++) addPointLight(f, `lamp${i}`, ((i % 8) - 3.5) * 1.6, 1 + (i % 4) * 0.6, ((i >> 3) - 2) * 1.6, 4, 4 + i);
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    const s = f.renderer.stats;
    expect(s.lights).toBe(total + 1);
    expect(s.clusteredLights).toBe(total); // every lamp reaches the shader
    expect(s.lightsDropped).toBe(false);
    expect(bufferOf(f, "lights.uniforms").i32[0]).toBe(1); // the sun alone
    expect(bufferOf(f, "cluster.lights").i32[0]).toBe(total);
    expect(s.clusterIndices).toBeGreaterThan(total);

    // The same scene with clustering off: the fixed list truncates, and the stats say so instead of
    // letting 24 lamps vanish without a trace.
    f.scene.settings.clusteredLighting = false;
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(f.renderer.stats.lightsDropped).toBe(true);
    expect(bufferOf(f, "lights.uniforms").i32[0]).toBe(MAX_LIGHTS_PER_FRAME);
    await f.dispose();
  });

  it("allocates nothing on a steady clustered frame, and toggling it leaks nothing", async () => {
    const f = await fixture();
    addPointLight(f, "lamp-a", -2, 1.5, 0);
    addPointLight(f, "lamp-b", 2, 1.5, 1, 4, 25);
    f.renderer.renderScene(f.scene);
    f.renderer.renderScene(f.scene);
    const buffers = f.device.gpuMemory.buffersCreated;
    const textures = f.device.gpuMemory.texturesCreated;
    for (let i = 0; i < 4; i++) f.renderer.renderScene(f.scene);
    expect(f.device.gpuMemory.buffersCreated).toBe(buffers);
    expect(f.device.gpuMemory.texturesCreated).toBe(textures);
    expect(f.renderer.stats.texturesCreated).toBe(0);
    expect(f.renderer.stats.clusteredLighting).toBe(true);

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
      expect(f.mock.errors, `clustered=${clustered} hdr=${hdr} shadows=${shadows}`).toEqual([]);
      expect(f.renderer.stats.clusteredLighting).toBe(clustered);
    }
    // The fixture's dispose() asserts nothing (cluster buffers included) outlives the renderer.
    await f.dispose();
  });

  it("hands the fill to the GPU when asked, and reports the same grid either way", async () => {
    // The two fills are A/B-able on one scene. On the mock nothing executes, so what is checked here
    // is the *handover*: the counts are still the CPU's (the fragment stage and the stats read them),
    // the lists are not uploaded at all, and the device is handed the pass that writes them. The
    // shader itself is pinned in tests/lightCulling.test.ts and compiled by check:browser.
    const scene = async (mode: "cpu" | "gpu") => {
      const f = await fixture({ renderer: { lightCulling: mode } });
      addPointLight(f, "lamp-a", -2, 1.5, 0);
      addPointLight(f, "lamp-b", 2, 1.5, 1, 4, 25);
      addPointLight(f, "lamp-c", 0, 2.5, -2, 8, 5);
      f.renderer.renderScene(f.scene);
      expect(f.mock.errors, mode).toEqual([]);
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
    expect(cpu.s.clusterFill).toBe("cpu");
    expect(gpu.s.clusterFill).toBe("gpu");
    // Everything but the fill's own bookkeeping: the pass list carries the assignment pass, and
    // `clusterFill` names which half ran.
    const strip = (s: Renderer["stats"]) => {
      const { clusterFill, passes, ...rest } = s;
      return rest;
    };
    expect(strip(gpu.s)).toEqual(strip(cpu.s));
    expect(gpu.result).toEqual(cpu.result);
    expect(gpu.s.clusterIndices).toBeGreaterThan(0);
    expect(gpu.s.clustersUsed).toBeGreaterThan(0);
    expect(gpu.flags & 32).toBe(32);

    // The CPU path uploads the counts and the list prefix; the GPU path uploads the counts only, and
    // the device gets one pass that writes every list the counts describe.
    expect(cpu.writes).toHaveLength(2);
    expect(gpu.writes).toHaveLength(1);
    expect(gpu.writes[0]!.size).toBe(CLUSTER_COUNT * 4);
    expect(cpu.indices.some((v) => v !== 0)).toBe(true);
    expect(gpu.indices.every((v) => v === 0)).toBe(true); // nothing wrote it: the pass is the writer
    // The graph names the pass; the compute pass inside it is the one the device sees.
    expect(gpu.graphPasses).toContain("forge.lights.assign");
    expect(cpu.graphPasses).not.toContain("forge.lights.assign");
    expect(gpu.passes).toContain("lights.assign");
    expect(cpu.passes).not.toContain("lights.assign");
    expect(cpu.dispatches).toEqual([]);
    // One dispatch per frame, in whole workgroups over the grid (12 x 256 = 3072 clusters).
    expect(gpu.dispatches).toEqual([expect.objectContaining({ label: "lights.assign", x: CLUSTER_COUNT / 256, y: 1, z: 1 })]);
    // The ranges the shader reads: the CPU's light count and the packed keys, uploaded once per
    // clustered frame (the CPU path has no such buffer at all).
    const rangeWrites = (f: Fixture) =>
      f.mock.commandLog.filter((e) => e.type === "writeBuffer" && e["buffer"] === "lights.ranges").map((e) => e["size"] as number);
    expect(rangeWrites(cpu.f)).toEqual([]);
    const entry = ClusterRangeBlock.field("entries", "storage");
    const keyBase = entry.offset >> 2;
    const stride = entry.stride! >> 2;
    const influenceSlot = ClusterRangeEntry.field("influence", "storage").offset >> 2;
    expect(rangeWrites(gpu.f)).toEqual([entry.offset + gpu.s.clusteredLights * entry.stride!]);
    const ranges = bufferOf(gpu.f, "lights.ranges");
    expect(ranges.u32[0]).toBe(gpu.s.clusteredLights);
    for (let i = 0; i < gpu.s.clusteredLights; i++) {
      // Live: the light reaches at least one cluster. (A light that reaches nothing packs to zero.)
      expect(ranges.u32[keyBase + i * stride]! >>> 24, `key ${i}`).toBe(1);
      expect(ranges.f32[keyBase + i * stride + influenceSlot]!).toBeGreaterThan(0);
    }

    // A frame that did not cluster records no assignment pass at all: the pass belongs to the frame
    // that fills a grid, the way forge.ssao belongs to a frame that computes SSAO. The frame it did
    // not cluster must not be read against the last clustered frame's grid either.
    const off = gpu.f;
    const before = off.mock.commandLog.length;
    off.scene.settings.clusteredLighting = false;
    off.renderer.renderScene(off.scene);
    expect(off.mock.errors).toEqual([]);
    expect(off.renderer.stats.clusterFill).toBe("none");
    expect(labels(off)).not.toContain("forge.lights.assign");
    expect(off.renderer.passNames).not.toContain("forge.lights.assign");
    expect(off.mock.commandLog.slice(before).filter((e) => e["buffer"] === "lights.ranges")).toEqual([]);
    expect(off.mock.commandLog.slice(before).filter((e) => e.type === "dispatch")).toEqual([]);

    // Switching back mid-run returns to the CPU fill; the lists are the CPU's again on the next frame,
    // and the culler's scratch is released with the renderer (the fixture's dispose asserts that).
    off.scene.settings.clusteredLighting = true;
    off.renderer.lightCulling = "cpu";
    off.renderer.renderScene(off.scene);
    expect(off.renderer.stats.clusterFill).toBe("cpu");
    expect(off.renderer.passNames).not.toContain("forge.lights.assign");
    // The CPU fill reproduces the GPU path's grid from the same scene, index count included.
    expect(off.renderer.stats.clusterIndices).toBe(gpu.s.clusterIndices);
    expect(off.renderer.stats.clustersUsed).toBe(gpu.s.clustersUsed);
    expect(bufferOf(off, "cluster.grid").u32.some((v) => v !== 0)).toBe(true);

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
    expect(off.renderer.stats.clusterFill).toBe("gpu");
    expect(off.renderer.passNames).toContain("forge.lights.assign");
    expect(off.mock.commandLog.slice(beforeBack).filter((e) => e.type === "dispatch")).toEqual([
      expect.objectContaining({ label: "lights.assign", x: CLUSTER_COUNT / 256, y: 1, z: 1 }),
    ]);
    expect(off.mock.errors).toEqual([]);

    await cpu.f.dispose();
    await gpu.f.dispose();
  });
});

// ------------------------------------------------------------------ object culling (Phase 13.5)

describe("object culling", () => {
  it("culls batches on the CPU by default, and the frame says which", async () => {
    const f = await fixture();
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    // The mock device has no compute, so "auto" resolves to the twin — and its verdict is immediate:
    // every batch is tested in the same frame, and the words it wrote are in the buffer the draw
    // group binds.
    expect(f.renderer.objectCulling).toBe("cpu");
    expect(f.renderer.stats.batches).toBeGreaterThan(0);
    expect(f.renderer.stats.cullTested).toBe(f.renderer.stats.batches);
    expect(bufferOf(f, "cull.visibility").u32.every((v) => v === 0)).toBe(true);
    expect(f.renderer.passNames).not.toContain("forge.objects.cull");
    expect(f.renderer.stats.cullFrustum + f.renderer.stats.cullDistance + f.renderer.stats.cullOccluded).toBe(0);

    // Point the camera at the sky: what it can no longer see is culled, and its word says why.
    const cam = f.scene.findCamera()!;
    cam.entity.transform.lookAt(new Vec3(0, 200, 0));
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    const s = f.renderer.stats;
    expect(s.cullTested).toBe(s.batches);
    expect(s.cullFrustum).toBeGreaterThan(0);
    const words = bufferOf(f, "cull.visibility").u32;
    expect([...words.slice(0, s.batches)].filter((w) => w === CullReason.Frustum)).toHaveLength(s.cullFrustum);
    await f.dispose();
  });

  it("runs the device path as a pass, and its counters are the device's own", async () => {
    const f = await fixture({ renderer: { objectCulling: "gpu" } });
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(f.renderer.objectCulling).toBe("gpu");
    expect(f.renderer.passNames).toContain("forge.objects.cull");
    // The prepass depth is the pyramid's input, so the occlusion stage rides along with it...
    expect(f.renderer.passNames).toContain("forge.hiz.0");
    // ...and the cull pass covers the batch count in whole workgroups.
    const dispatch = f.mock.commandLog.filter((e) => e.type === "dispatch").at(-1);
    expect(dispatch).toMatchObject({ label: "objects.cull", x: Math.ceil(f.renderer.stats.batches / 64), y: 1, z: 1 });
    // The device has not reported anything back yet (and on the mock never will: it records the pass
    // without executing it), so this is the *zeroed* visibility buffer — a frame whose words were
    // never written draws everything rather than keeping the last frame's verdicts.
    expect(f.renderer.stats.cullTested).toBe(0);
    expect(f.renderer.stats.drawCalls).toBeGreaterThan(0);
    expect(bufferOf(f, "cull.visibility").u32.every((v) => v === 0)).toBe(true);

    // Switching back to the twin puts the CPU's numbers back and takes the pass out of the frame; a
    // round trip to "gpu" has to bring it back with it (a released culler must not be kept: a
    // disposed one records nothing, and the frame would then read a stale buffer).
    f.renderer.objectCulling = "cpu";
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(f.renderer.passNames).not.toContain("forge.objects.cull");
    expect(f.renderer.stats.cullTested).toBe(f.renderer.stats.batches);
    const before = f.mock.commandLog.length;
    f.renderer.objectCulling = "gpu";
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(f.renderer.passNames).toContain("forge.objects.cull");
    expect(f.mock.commandLog.slice(before).filter((e) => e.type === "dispatch").map((e) => e["label"])).toContain("objects.cull");
    await f.dispose();
  });

  it("submits the frame through the culler's records, and a culled batch's draw carries no instances", async () => {
    const f = await fixture();
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    const batches = f.renderer.stats.batches;
    // The records are one slot per batch, and the slot's stride is the constant the draw loop indexes
    // with (8 words, so every offset is 16-aligned for `drawIndexedIndirect`).
    const records = bufferOf(f, "cull.drawRecords");
    expect(records.size).toBeGreaterThanOrEqual(batches * DRAW_RECORD_BYTES);
    expect(records.u32[0]).toBeGreaterThan(0); // the batch's index count
    expect(records.u32[DRAW_RECORD_INSTANCES]).toBe(1); // one instance per batch in this fixture
    // Every main-pass draw went through a record, and the mock reads the record out of the buffer —
    // so this is the device-side instance count, not the renderer's intention.
    // (The shadow and prepass draws are direct, so the claim is the count: `indirectDraws` increments
    // once per main-pass draw, and the log has that many indirect records read out of the buffer.)
    const indirect = f.mock.commandLog.filter((e) => e.type === "drawIndexed" && e["indirect"] === true);
    expect(f.renderer.stats.indirectDraws).toBe(batches);
    expect(indirect.length).toBe(f.renderer.stats.indirectDraws);
    expect(indirect.every((e) => e["instanceCount"] === 1)).toBe(true);
    expect(f.renderer.stats.cullVisible).toBe(batches);
    expect(f.renderer.stats.cullRecordZeroed).toBe(0);

    // Point the camera at the sky: whatever it can no longer see gets a zero-instance record, and the
    // compaction list names the batches that survived.
    const cam = f.scene.findCamera()!;
    cam.entity.transform.lookAt(new Vec3(0, 200, 0));
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    const s = f.renderer.stats;
    expect(s.cullFrustum).toBeGreaterThan(0);
    expect(s.cullVisible).toBe(s.batches - s.cullFrustum - s.cullDistance - s.cullOccluded);
    expect(s.cullRecordZeroed).toBe(s.cullFrustum + s.cullDistance + s.cullOccluded);
    const after = bufferOf(f, "cull.drawRecords");
    let zeroed = 0;
    for (let i = 0; i < s.batches; i++) {
      if (after.u32[i * DRAW_RECORD_WORDS + DRAW_RECORD_INSTANCES] === 0) zeroed++;
    }
    expect(zeroed).toBe(s.cullRecordZeroed);
    const list = bufferOf(f, "cull.visibleBatches");
    const listed = [...list.u32.slice(0, s.cullVisible)];
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed.every((index) => index < s.batches)).toBe(true);
    // Every listed batch is one the records left drawable, and every unlisted one is zeroed: the list
    // and the records are the same verdict, which is what a consumer of either relies on.
    for (let i = 0; i < s.batches; i++) {
      const visible = listed.includes(i);
      expect(after.u32[i * DRAW_RECORD_WORDS + DRAW_RECORD_INSTANCES] > 0).toBe(visible);
    }
    await f.dispose();
  });

  it("saves the culled batches' vertex work, which the direct path still pays", async () => {
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
    expect(f.renderer.stats.cullDistance).toBeGreaterThan(0);
    expect(indirect.zeroed).toBe(f.renderer.stats.cullDistance);

    f.renderer.indirectDraws = false;
    const beforeDirect = f.mock.verticesDrawn;
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    const direct = { vertices: f.mock.verticesDrawn - beforeDirect, calls: f.renderer.stats.drawCalls };
    // The same verdicts and the same issued calls — the difference is the shading the culled batches
    // no longer pay for, and it is exactly their vertex count (the batch counts travel in the bounds).
    expect(direct.calls).toBe(indirect.calls);
    expect(f.renderer.stats.indirectDraws).toBe(0);
    expect(direct.vertices).toBeGreaterThan(indirect.vertices);
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
    expect(culledVertices).toBeGreaterThan(0);
    expect(direct.vertices - indirect.vertices).toBe(culledVertices);
    await f.dispose();
  });

  it("writes records only when the frame asks for them", async () => {
    const f = await fixture({ renderer: { objectCulling: "gpu" } });
    const flags = () => bufferOf(f, "objects.cull.uniforms").u32[ObjectCullUniforms.offsetOf("flags", "uniform") >> 2]!;
    f.renderer.renderScene(f.scene);
    expect(flags() & CULL_FLAG_RECORDS).toBe(CULL_FLAG_RECORDS);

    f.renderer.indirectDraws = false;
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(flags() & CULL_FLAG_RECORDS).toBe(0);
    expect(f.renderer.stats.indirectDraws).toBe(0);
    // The direct path still pays for every batch's vertices, which is the whole difference.
    const writes = bufferOf(f, "cull.drawRecords").writeCount;
    f.renderer.renderScene(f.scene);
    expect(bufferOf(f, "cull.drawRecords").writeCount).toBe(writes);

    f.renderer.objectCulling = "cpu";
    f.renderer.indirectDraws = true;
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    // The twin writes the record words itself, and the frame is submitted through them.
    expect(f.renderer.stats.indirectDraws).toBeGreaterThan(0);
    await f.dispose();
  });

  it("skips the occlusion stage when the renderer is told to, and finds it again after", async () => {
    // The pyramid outlives the frame (it is the size of the target), so "does this frame occlude" has
    // to be per-frame state: a frame with no pyramid passes that still declared `forge.hiz.0` would
    // read a depth buffer nothing wrote, and the graph would refuse the frame.
    const f = await fixture({ renderer: { objectCulling: "gpu" } });
    f.renderer.renderScene(f.scene);
    expect(f.renderer.passNames).toContain("forge.hiz.0");

    f.renderer.occlusionCulling = false;
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(f.renderer.passNames).toContain("forge.objects.cull");
    expect(f.renderer.passNames.some((p) => p.startsWith("forge.hiz"))).toBe(false);

    f.renderer.occlusionCulling = true;
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(f.renderer.passNames).toContain("forge.hiz.0");
    await f.dispose();
  });
});
