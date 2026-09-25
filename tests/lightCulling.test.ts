/**
 * GPU light assignment — `engine/src/rendering/lightCulling.ts` (Phase 13.4, docs/RENDERING.md §4c).
 *
 * The GPU fill is only worth having if it is *the same fill*: the fragment stage indexes the grid
 * with the CPU's counts, so a device that wrote a different list would light a surface differently
 * from the CPU path — a difference no screenshot of one path can show. What is pinned here is
 * therefore equivalence, not "it runs":
 *
 * - `assignClustersOnCpu` (the shader's own twin, in TypeScript) against `ClusterGrid.rasterize`
 *   byte for byte, over hand-written scenes *and* a deterministic sweep — including the scenes that
 *   exercise the interesting half: lists saturated at the per-cluster cap, where the fill evicts the
 *   least influential light and then restores light order, and scenes full of influence ties, where
 *   "the same list" depends on which minimum the eviction picks.
 * - `coversKey` against the coverage the CPU fill actually walks, so the packed key — the one value
 *   that crosses from TypeScript into WGSL — cannot mean two different things.
 * - The recorded pass: the range upload holds exactly the packed keys and influences the renderer
 *   would have uploaded, one dispatch covers the grid in whole workgroups, and the bind group follows
 *   the renderer's grid buffer.
 *
 * The real shader is checked by `check:browser` (a real device compiles and runs it) and by
 * `tools/wgsl-check.mjs` (the struct declarations it embeds are the generated ones).
 */

import { describe, expect, it } from "vitest";
import {
  BufferUsage,
  CLUSTER_COUNT,
  CLUSTER_INDEX_CAPACITY,
  CLUSTER_TILES_X,
  CLUSTER_TILES_Y,
  ClusterGrid,
  ClusterGridBlock,
  ClusterRangeBlock,
  GraphicsDevice,
  LIGHT_CULL_SHADER,
  LIGHT_CULL_WORKGROUP,
  MAX_CLUSTERED_LIGHTS,
  MAX_LIGHTS_PER_CLUSTER,
  Mat4,
  PipelineFactory,
  RenderGraph,
  Vec3,
  RANGE_KEY_BITS,
  assignClustersOnCpu,
  coversKey,
  validateWgsl,
  type ClusterCameraParams,
  type ClusterLightSource,
  type ClusterRanges,
} from "@forge/engine";
import { GpuLightCuller } from "@forge/engine";

const EYE = new Vec3(0, 5, -20);
const TARGET = new Vec3(0, 1, 0);
const NEAR = 0.1;
const FAR = 60;

function cameraAt(eye: Vec3, target: Vec3, fov = Math.PI / 3, far = FAR): ClusterCameraParams {
  const view = new Mat4().setLookAt(eye, target, new Vec3(0, 1, 0));
  const proj = new Mat4().setPerspective(fov, 16 / 9, NEAR, far);
  return { view, proj00: proj.m[0]!, proj11: proj.m[5]!, near: NEAR, far };
}

const camera = () => cameraAt(EYE, TARGET);

/** A point light with an explicit rank, so a test can choose which light loses an eviction. */
function light(x: number, y: number, z: number, range = 6, intensity = 10, colorLuma = 1, spot = false): ClusterLightSource {
  return { x, y, z, range, spot, dirX: 0, dirY: -1, dirZ: 0, outerCone: 0.6, intensity, colorLuma };
}

/** Deterministic RNG: the sweep below must be the same scene set on every run and every machine. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** How many dispatches bound this buffer (the mock counts touches per resource). */
const touchCount = (buffer: GPUBuffer): number => (buffer as unknown as { computeTouchCount: number }).computeTouchCount;

interface Grids {
  /** The reference: the CPU range + count + fill, as 13.3 shipped it. */
  cpu: ClusterGrid;
  cpuResult: ReturnType<ClusterGrid["rasterize"]>;
  /** The GPU path: the same range + count, then the shader's twin into a fresh index block. */
  gpu: ClusterGrid;
  ranges: ClusterRanges;
  gpuResult: ReturnType<ClusterGrid["count"]>;
  indices: Uint32Array;
  packed: Uint32Array;
  influences: Float32Array;
}

/**
 * Both rasterisers over one scene. The twin writes into its own zeroed index block, exactly like a
 * device buffer nothing has touched, so a cluster the two paths disagree about cannot hide behind a
 * stale value the CPU left from an earlier frame.
 */
function rasterize(lights: readonly ClusterLightSource[], params: ClusterCameraParams = camera()): Grids {
  const cpu = new ClusterGrid();
  const cpuResult = cpu.rasterize(cpu.prepare(lights, params, lights.length));

  const gpu = new ClusterGrid();
  const ranges = gpu.prepare(lights, params, lights.length);
  const gpuResult = gpu.count(ranges);
  const indices = new Uint32Array(CLUSTER_INDEX_CAPACITY);
  const packed = new Uint32Array(MAX_CLUSTERED_LIGHTS);
  const influences = new Float32Array(MAX_CLUSTERED_LIGHTS);
  gpu.packRanges(packed, ranges);
  for (let i = 0; i < ranges.lights; i++) influences[i] = gpu.influenceOf(i);
  assignClustersOnCpu(packed, influences, ranges.lights, gpu.counts, indices);
  return { cpu, cpuResult, gpu, ranges, gpuResult, indices, packed, influences };
}

/** Every aggregate and every list slot both paths wrote. */
function expectSameGrid(g: Grids, label = ""): void {
  expect(g.gpuResult, `${label} aggregates`).toEqual(g.cpuResult);
  expect([...g.gpu.counts], `${label} counts`).toEqual([...g.cpu.counts]);
  expect([...g.indices], `${label} lists`).toEqual([...g.cpu.indices]);
}

describe("the assign pass is the CPU fill in another language", () => {
  it("writes the same lists for scattered point lights", () => {
    const g = rasterize([
      light(0, 1, 0),
      light(-4, 2, 3, 5),
      light(5, 0.5, -2, 8),
      light(1.5, 3, 6, 3, 40),
      light(0, 1, 40, 400), // reaches the whole grid
    ]);
    expect(g.gpuResult.live).toBe(5);
    expect(g.gpuResult.clustersUsed).toBe(CLUSTER_COUNT);
    expectSameGrid(g);
  });

  it("writes the same lists when a list is full: evictions, then light order", () => {
    // One cluster's worth of lights: 40 lamps in a tight cluster around the camera's centre, all
    // reaching the same tiles, so every list saturates at MAX_LIGHTS_PER_CLUSTER and the fill has to
    // evict. Unequal influences make the *choice* observable; the tie group below makes the
    // tie-break observable.
    const lights: ClusterLightSource[] = [];
    for (let i = 0; i < 40; i++) lights.push(light(0, 1, 0, 12, 10 + i));
    const g = rasterize(lights);
    expect(g.gpuResult.maxPerCluster).toBe(MAX_LIGHTS_PER_CLUSTER);
    expect(g.gpuResult.dropped).toBe(true);
    expectSameGrid(g);

    // Equal ranks everywhere: the eviction falls back on "first minimum", and the list still has to
    // come out in light order.
    const ties: ClusterLightSource[] = [];
    for (let i = 0; i < 40; i++) ties.push(light(0, 1, 0, 12, 10, 1));
    const t = rasterize(ties);
    expect(t.gpuResult.dropped).toBe(true);
    expectSameGrid(t, "ties:");
    // Conservation sanity: with equal ranks, the kept set is a prefix's worth of light indices, and
    // every list is still sorted (it is what the fragment stage's accumulation order depends on).
    for (let c = 0; c < CLUSTER_COUNT; c++) {
      const list = t.indices.subarray(c * MAX_LIGHTS_PER_CLUSTER, c * MAX_LIGHTS_PER_CLUSTER + t.gpu.counts[c]!);
      for (let k = 1; k < list.length; k++) expect(list[k]!).toBeGreaterThan(list[k - 1]!);
    }
  });

  it("writes the same lists for spot lights, off-frame lights and degenerate input", () => {
    const g = rasterize([
      light(0, 2, 5, 20, 30, 1, true),
      light(-3, 2, 5, 20, 30, 1, true),
      light(200, 2, 5), // off-frame
      light(0, 2, -100, 5), // behind the camera
      light(0, 2, 5, Number.NaN),
      light(0, 2, 5, 0),
      light(0, 1, 0, 1e5), // a range far past the far plane: every cluster, both paths
    ]);
    expectSameGrid(g, "mixed:");
  });

  it("agrees on every scene of a deterministic sweep", () => {
    // 60 scenes with a fixed seed: dense and sparse coverage, ranges from 1 m to 400 m, spot and
    // point, tie-heavy ranks, cameras that move — the cases a hand-written scene list forgets.
    const random = rng(0x13_04_c0de);
    for (let trial = 0; trial < 60; trial++) {
      const count = 1 + Math.floor(random() * 48);
      const lights: ClusterLightSource[] = [];
      for (let i = 0; i < count; i++) {
        const tie = random() < 0.4;
        lights.push(
          light(
            (random() - 0.5) * 30,
            random() * 6,
            (random() - 0.5) * 30,
            1 + random() * 25,
            tie ? 10 : 1 + random() * 40,
            tie ? 1 : Math.round(random() * 3) / 3,
            random() < 0.25,
          ),
        );
      }
      const params = cameraAt(new Vec3((random() - 0.5) * 6, 1 + random() * 8, -20 + random() * 6), TARGET);
      const g = rasterize(lights, params);
      expectSameGrid(g, `scene ${trial}:`);
    }
  });

  it("decodes a packed range exactly as the CPU fill walks the grid", () => {
    // Below the cap there is no eviction, so cluster membership *is* coverage: the set of lights the
    // CPU fill put in a cluster must equal the set the shader's key test admits for it.
    const lights = [light(0, 1, 0, 4), light(-3, 1.5, 2, 6), light(6, 2, -4, 9), light(0, 0.5, 20, 30)];
    const g = rasterize(lights);
    expect(g.gpuResult.dropped).toBe(false);
    for (let c = 0; c < CLUSTER_COUNT; c++) {
      const expected: number[] = [];
      for (let i = 0; i < lights.length; i++) {
        const tileX = c % CLUSTER_TILES_X;
        const row = (c / CLUSTER_TILES_X) | 0;
        if (coversKey(g.packed[i]!, tileX, row % CLUSTER_TILES_Y, (row / CLUSTER_TILES_Y) | 0)) expected.push(i);
      }
      const start = c * MAX_LIGHTS_PER_CLUSTER;
      expect([...g.indices.subarray(start, start + g.gpu.counts[c]!)], `cluster ${c}`).toEqual(expected);
      expect([...g.cpu.lightsOf(c)], `cluster ${c} (cpu)`).toEqual(expected);
    }
    // ... and a light that reaches nothing packs to a key no cluster matches.
    const dead = rasterize([light(0, 1, -100, 5)]);
    expect(dead.ranges.live).toBe(0);
    expect(dead.packed[0]).toBe(0);
    expect(coversKey(0, 0, 0, 0)).toBe(false);
  });

  it("reports the aggregates the GPU path needs without reading anything back", () => {
    // The whole reason the assign pass can write no stats: they are functions of the counts, which the
    // CPU's counting pass produced. Two frames, one counted-only (the GPU path) and one filled (the
    // CPU path), report identical numbers — the dropped flag included.
    const lights: ClusterLightSource[] = [];
    for (let i = 0; i < MAX_CLUSTERED_LIGHTS + 6; i++) lights.push(light(0, 1, 0, 30, 10 + i));
    const g = rasterize(lights);
    expect(g.cpuResult.dropped).toBe(true);
    expect(g.gpuResult).toEqual(g.cpuResult);
    expect(g.gpuResult.clustersUsed).toBe(g.cpuResult.clustersUsed);
    expect(g.gpuResult.indexCount).toBe(g.cpuResult.indexCount);
    expect(g.gpuResult.maxPerCluster).toBe(g.cpuResult.maxPerCluster);
    void g.gpu.lightsOf(0);
  });
});

describe("GpuLightCuller", () => {
  async function setup(lights: readonly ClusterLightSource[], params: ClusterCameraParams = camera()) {
    const device = await GraphicsDevice.create({ forceMock: true });
    const mock = device.mock;
    const graph = new RenderGraph(device);
    const grid = new ClusterGrid();
    const ranges = grid.prepare(lights, params, lights.length);
    const result = grid.count(ranges);
    const gridBuffer = device.device.createBuffer({
      label: "cluster.grid",
      size: ClusterGridBlock.byteSize("storage"),
      usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
    });
    const culler = new GpuLightCuller(device, new PipelineFactory(device).shaders);
    return { device, mock, graph, grid, ranges, result, gridBuffer, culler };
  }

  it("uploads exactly the packed keys and influences, and dispatches over the grid", async () => {
    const lights = [light(0, 1, 0, 5), light(-4, 2, 3, 8), light(5, 0.5, -2, 12, 40)];
    const { device, mock, graph, grid, ranges, gridBuffer, culler } = await setup(lights);
    graph.begin();
    culler.record(graph, grid, ranges, gridBuffer);
    expect(mock.errors).toEqual([]);
    expect(graph.execute().executed).toEqual(["forge.lights.assign"]);
    expect(mock.errors).toEqual([]);

    // What the shader reads: the range block, entry for entry, against the CPU's own packer.
    const rangesBuffer = [...mock.liveBuffers].find((b) => b.label === "lights.ranges");
    expect(rangesBuffer, "lights.ranges").toBeDefined();
    expect(rangesBuffer!.size).toBe(ClusterRangeBlock.byteSize("storage"));
    const u32 = new Uint32Array(rangesBuffer!.data);
    const f32 = new Float32Array(rangesBuffer!.data);
    const entrySlot = ClusterRangeBlock.field("entries", "storage").offset >> 2;
    const entryStride = ClusterRangeBlock.field("entries", "storage").stride! >> 2;
    expect(u32[0]).toBe(3);
    const reference = new Uint32Array(MAX_CLUSTERED_LIGHTS);
    grid.packRanges(reference, ranges);
    for (let i = 0; i < lights.length; i++) {
      expect(u32[entrySlot + i * entryStride], `key ${i}`).toBe(reference[i]);
      expect(f32[entrySlot + i * entryStride + 1], `influence ${i}`).toBe(grid.influenceOf(i));
    }
    // Only the live prefix is uploaded (a frame with three lamps does not push 2 KB every frame).
    expect(rangesBuffer!.lastWriteBytes).toBe((entrySlot + lights.length * entryStride) * 4);
    expect(mock.queue.bytesUploaded).toBe(rangesBuffer!.lastWriteBytes);

    // One dispatch, whole workgroups, and the grid buffer is what the pass writes.
    const dispatch = mock.commandLog.find((e) => e.type === "dispatch");
    expect(dispatch).toMatchObject({ label: "lights.assign", x: CLUSTER_COUNT / LIGHT_CULL_WORKGROUP, y: 1, z: 1 });
    expect(CLUSTER_COUNT % LIGHT_CULL_WORKGROUP).toBe(0);
    expect(touchCount(gridBuffer)).toBe(1);

    // dispose releases the staging buffer and nothing else (the grid belongs to the renderer).
    culler.dispose();
    expect(mock.outstanding.buffers).toEqual(["cluster.grid"]);
    culler.dispose(); // idempotent
    gridBuffer.destroy();
    await device.dispose();
  });

  it("uploads a light count of zero and writes nothing when no light is local", async () => {
    // A scene whose lights are all directional: clustering ran, so the pass is recorded, but the frame
    // has nothing to assign and uploads a four-byte header instead of a stale range block.
    const { device, mock, graph, grid, ranges, gridBuffer, culler } = await setup([]);
    expect(ranges.lights).toBe(0);
    graph.begin();
    culler.record(graph, grid, ranges, gridBuffer);
    expect(graph.execute().executed).toEqual(["forge.lights.assign"]);
    expect(mock.errors).toEqual([]);
    const rangesBuffer = [...mock.liveBuffers].find((b) => b.label === "lights.ranges")!;
    expect(new Uint32Array(rangesBuffer.data)[0]).toBe(0);
    expect(rangesBuffer.lastWriteBytes).toBe(4);
    expect(touchCount(gridBuffer)).toBe(1);
    culler.dispose();
    gridBuffer.destroy();
    await device.dispose();
  });

  it("rebinds when the renderer's grid buffer changes (a device rebuild)", async () => {
    const { device, mock, graph, grid, ranges, gridBuffer, culler } = await setup([light(0, 1, 0, 5)]);
    graph.begin();
    culler.record(graph, grid, ranges, gridBuffer);
    graph.execute();
    expect(mock.errors).toEqual([]);

    const second = device.device.createBuffer({
      label: "cluster.grid.2",
      size: ClusterGridBlock.byteSize("storage"),
      usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
    });
    graph.begin();
    culler.record(graph, grid, ranges, second);
    graph.execute();
    expect(mock.errors).toEqual([]);
    // The pass must write the buffer it was handed, not the one it first saw.
    expect(touchCount(second)).toBe(1);
    expect(touchCount(gridBuffer)).toBe(1);

    culler.dispose();
    gridBuffer.destroy();
    second.destroy();
    await device.dispose();
  });
});

describe("LIGHT_CULL_SHADER", () => {
  it("is generated from the grid constants and the packed-range layout", () => {
    for (const text of [
      `const CLUSTER_COUNT: u32 = ${CLUSTER_COUNT}u;`,
      `const CLUSTER_TILES_X: u32 = ${CLUSTER_TILES_X}u;`,
      `const CLUSTER_TILES_Y: u32 = ${CLUSTER_TILES_Y}u;`,
      `const MAX_CLUSTERED_LIGHTS: u32 = ${MAX_CLUSTERED_LIGHTS}u;`,
      `const MAX_LIGHTS_PER_CLUSTER: u32 = ${MAX_LIGHTS_PER_CLUSTER}u;`,
      `@workgroup_size(${LIGHT_CULL_WORKGROUP}) @compute fn csAssign(`,
      "fn covers(key: u32, tileX: u32, tileY: u32, slice: u32) -> bool {",
    ]) {
      expect(LIGHT_CULL_SHADER, text).toContain(text);
    }
    // The grid divides into whole workgroups: no lane is ever outside the grid for a reason other than
    // the guard, and the dispatch cannot be short.
    expect(CLUSTER_COUNT % LIGHT_CULL_WORKGROUP).toBe(0);
    // The layout structs are embedded, not transcribed: a hand-written copy is how the two languages
    // drift apart.
    expect(LIGHT_CULL_SHADER).toContain(ClusterRangeBlock.toWgsl("storage"));
    expect(LIGHT_CULL_SHADER).toContain(ClusterGridBlock.toWgsl("storage"));
    expect(LIGHT_CULL_SHADER).toContain(MAX_LIGHTS_PER_CLUSTER.toString());
    // The decode is generated from the CPU's own bit layout, field by field: the shader cannot be
    // edited to read a key the packer does not write without failing here first.
    for (const name of ["tileX0", "tileX1", "tileY0", "tileY1", "slice0", "slice1"] as const) {
      const { shift, mask } = RANGE_KEY_BITS[name];
      expect(LIGHT_CULL_SHADER, name).toContain(`(key >> ${shift}u) & ${mask}u`);
    }
    expect(LIGHT_CULL_SHADER).toContain(`const LIVE_BIT: u32 = ${RANGE_KEY_BITS.live.mask}u << ${RANGE_KEY_BITS.live.shift}u;`);
    // The counts are the CPU's; the shader must not invent its own.
    expect(LIGHT_CULL_SHADER).toContain("let bound = grid.counts[c];");
    expect(LIGHT_CULL_SHADER).not.toContain("grid.counts[c] =");
    // One entry point: nothing here recomputes counts or folds aggregates, so there is nothing for a
    // readback to wait on — the CPU reports the frame's grid the moment it counted it.
    expect(LIGHT_CULL_SHADER.match(/@compute/g)).toHaveLength(1);
  });

  it("validates, and decodes a key the way the packer writes one", () => {
    expect(validateWgsl(LIGHT_CULL_SHADER)).toEqual([]);
    // `coversKey` is the shader's `covers` in TypeScript, and this is the boundary walk the shader's
    // comparisons make: inside the box true, one past any face false, a dead light false. The key is
    // built with the same shifts the packer uses.
    const bits = RANGE_KEY_BITS;
    const pack = (x0: number, x1: number, y0: number, y1: number, s0: number, s1: number, live = 1) =>
      (((x0 & bits.tileX0.mask) << bits.tileX0.shift) |
        ((x1 & bits.tileX1.mask) << bits.tileX1.shift) |
        ((y0 & bits.tileY0.mask) << bits.tileY0.shift) |
        ((y1 & bits.tileY1.mask) << bits.tileY1.shift) |
        ((s0 & bits.slice0.mask) << bits.slice0.shift) |
        ((s1 & bits.slice1.mask) << bits.slice1.shift) |
        ((live & bits.live.mask) << bits.live.shift)) >>>
      0;
    const key = pack(2, 5, 1, 3, 4, 9);
    for (let x = 2; x <= 5; x++) {
      for (let y = 1; y <= 3; y++) {
        for (let s = 4; s <= 9; s++) expect(coversKey(key, x, y, s), `inside ${x},${y},${s}`).toBe(true);
      }
    }
    expect(coversKey(key, 1, 2, 6)).toBe(false);
    expect(coversKey(key, 6, 2, 6)).toBe(false);
    expect(coversKey(key, 3, 0, 6)).toBe(false);
    expect(coversKey(key, 3, 4, 6)).toBe(false);
    expect(coversKey(key, 3, 2, 3)).toBe(false);
    expect(coversKey(key, 3, 2, 10)).toBe(false);
    expect(coversKey(pack(2, 5, 1, 3, 4, 9, 0), 3, 2, 6)).toBe(false);
  });
});
