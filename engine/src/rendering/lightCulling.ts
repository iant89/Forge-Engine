/**
 * GPU light assignment — the compute half of Phase 13.4 (docs/RENDERING.md §4c).
 *
 * `clusters.ts` builds a frame's grid in three stages: `prepare` (O(lights): bounding spheres, the
 * near/far/off-frame culls, each light's tile and slice extent), `count` (how many lights reach each
 * cluster, from a per-slice difference plane — O(lights × slices + clusters), independent of the
 * coverage) and the fill (the lists themselves, O(coverage): every cluster a light reaches needs an
 * entry). This module is that fill, on the GPU: one invocation per cluster, one workgroup per 256
 * clusters, one dispatch per frame.
 *
 * **Why the fill and not the rest.** It is the only stage whose cost grows with how much of the grid
 * the lights cover, and the only stage a single CPU thread cannot widen: `benchmarks/src/lights.bench.ts`
 * measures the demo-shaped rig (256 lamps, ~30 clusters each) at ~0.5 ms for 7 749 list entries, and a
 * saturating rig (256 lamps, every cluster) at ~75 ms for the 98 304-entry grid — 3 072 clusters × the
 * 32-entry cap — against 0.04–0.09 ms for the same frames' counting pass. The counting pass stays on the
 * CPU because its output is needed *exactly and immediately* — the fragment stage indexes its lists with
 * `counts`, `Renderer.stats` reports them, and `lightsDropped` is a correctness signal — so it is
 * deliberately the cheap, coverage-independent half.
 *
 * **Nothing is read back.** The fill writes exactly the lists the counting pass counted, so
 * `clustersUsed`, `indexCount`, `maxPerCluster` and the dropped-light flag are functions of `counts`
 * alone: the CPU knows all four before the dispatch is even recorded, and the GPU path reports the
 * same numbers the CPU path reports, for this frame, with no staging buffer, no `mapAsync` and no lag.
 *
 * **The shader is a transcription of the CPU fill, not a variant of it.** It walks the frame's packed
 * ranges in light order, appends the lights whose range covers its cluster, evicts the least
 * influential light once the list is full (the same per-light rank — intensity × colour luma — with
 * ties keeping the earlier light) and restores light order after an eviction. Given the same ranges
 * and the same counts it writes the bytes `ClusterGrid.rasterize` would; `assignClustersOnCpu` below
 * is that algorithm in TypeScript, and `tests/lightCulling.test.ts` pins it against the CPU builder.
 * `tools/wgsl-check.mjs` validates the WGSL and asserts the struct declarations in it are the
 * generated ones, so the shader's view of the grid cannot drift from the writer's.
 *
 * The mock device validates and records this path but cannot execute WGSL, so
 * `RendererOptions.lightCulling: "auto"` (the default) keeps the CPU fill on the mock — the same
 * reason `GpuParticleSystem` checks `isMock` before trusting a dispatch. `"gpu"` forces this path
 * there (which is how the recording is tested), and `check:browser` A/Bs the two fills on a real
 * device, pixels included.
 */

import { BufferUsage, ShaderStage, gpuSource } from "../gpu/constants.js";
import { WriteBuffer } from "../gpu/bufferWriter.js";
import type { ShaderCache } from "../gpu/shaderCache.js";
import type { GraphicsDevice } from "../gpu/device.js";
import {
  CLUSTER_COUNT,
  CLUSTER_TILES_X,
  CLUSTER_TILES_Y,
  MAX_CLUSTERED_LIGHTS,
  MAX_LIGHTS_PER_CLUSTER,
  RANGE_KEY_BITS,
  type ClusterGrid,
  type ClusterRanges,
} from "./clusters.js";
import { ClusterGridBlock, ClusterRangeBlock, ClusterRangeEntry } from "./uniforms.js";
import type { RenderGraph, RenderGraphPassContext } from "./renderGraph.js";

/** Invocations per workgroup; `CLUSTER_COUNT / LIGHT_CULL_WORKGROUP` workgroups cover the grid. */
export const LIGHT_CULL_WORKGROUP = 256;

// Where the range block's entries sit, in u32 slots, taken from the generated layout so the writer
// and the shader cannot disagree about it: the upload is a strided store, not a per-light object.
const RANGE_ENTRY_SLOT = ClusterRangeBlock.field("entries", "storage").offset >> 2;
const RANGE_ENTRY_STRIDE = (ClusterRangeBlock.field("entries", "storage").stride ?? 0) >> 2;
const RANGE_INFLUENCE_SLOT = ClusterRangeEntry.field("influence", "storage").offset >> 2;

/**
 * `((key >> shift) & mask)`, as WGSL: the packed-range fields, generated from the CPU's own layout.
 *
 * The outer parentheses are not decoration. WGSL requires them when a relational operator and a
 * bitwise one meet in one expression — Tint rejects `a < (k >> 4u) & 3u` with "mixing '<' and '&'
 * requires parenthesis" — and it rejects it at `createShaderModule`, so every pipeline built from the
 * module is invalid and every frame fails to submit. `validateWgsl` now fails on the same shape
 * (shaderCache.ts, `mixedOperatorIssues`), because the browser gate was the only thing that saw it.
 */
const fieldOf = (name: keyof typeof RANGE_KEY_BITS): string =>
  `((key >> ${RANGE_KEY_BITS[name].shift}u) & ${RANGE_KEY_BITS[name].mask}u)`;

/**
 * The cluster fill: one invocation per cluster, one workgroup per `LIGHT_CULL_WORKGROUP` clusters.
 *
 * Bindings: the frame's packed ranges (read) and the grid (read for `counts`, written for `indices`).
 * The light count travels inside the range block, so this pipeline needs no uniform of its own.
 *
 * The counts are the CPU's — the shader neither writes nor recomputes them, it only uses them as the
 * bound for each cluster's list. A list is `indices[c * stride .. + counts[c])`, the layout the
 * fragment stage reads, so `stride` is the same constant on both sides (`ClusterUniforms.stride`,
 * written from `MAX_LIGHTS_PER_CLUSTER` by the renderer).
 */
export const LIGHT_CULL_SHADER = /* wgsl */ `
${ClusterRangeEntry.toWgsl("storage")}
${ClusterRangeBlock.toWgsl("storage")}
${ClusterGridBlock.toWgsl("storage")}

const CLUSTER_TILES_X: u32 = ${CLUSTER_TILES_X}u;
const CLUSTER_TILES_Y: u32 = ${CLUSTER_TILES_Y}u;
const CLUSTER_COUNT: u32 = ${CLUSTER_COUNT}u;
const MAX_CLUSTERED_LIGHTS: u32 = ${MAX_CLUSTERED_LIGHTS}u;
const MAX_LIGHTS_PER_CLUSTER: u32 = ${MAX_LIGHTS_PER_CLUSTER}u;
const LIGHT_CULL_WORKGROUP: u32 = ${LIGHT_CULL_WORKGROUP}u;

// The packed range key: rendering/clusters.ts (RANGE_KEY_BITS) writes it, this decodes it. Bit 24 is
// the live flag; a light that reaches no cluster packs to 0 and matches none.
const LIVE_BIT: u32 = ${RANGE_KEY_BITS.live.mask}u << ${RANGE_KEY_BITS.live.shift}u;

@group(0) @binding(0) var<storage, read> ranges: ClusterRangeBlock;
@group(0) @binding(1) var<storage, read_write> grid: ClusterGridBlock;

// Does a prepared light reach this cluster? Three axis range tests against the packed bounds — the
// comparisons ClusterGrid's fill loops make, on the numbers its range pass prepared.
fn covers(key: u32, tileX: u32, tileY: u32, slice: u32) -> bool {
  if ((key & LIVE_BIT) == 0u) {
    return false;
  }
  if (slice < ${fieldOf("slice0")} || slice > ${fieldOf("slice1")}) {
    return false;
  }
  if (tileX < ${fieldOf("tileX0")} || tileX > ${fieldOf("tileX1")}) {
    return false;
  }
  if (tileY < ${fieldOf("tileY0")} || tileY > ${fieldOf("tileY1")}) {
    return false;
  }
  return true;
}

@workgroup_size(${LIGHT_CULL_WORKGROUP}) @compute fn csAssign(@builtin(global_invocation_id) gid: vec3<u32>) {
  let c = gid.x;
  if (c >= CLUSTER_COUNT) {
    return;
  }
  // The grid's index convention, and this cluster's own tile and slice: cluster c is
  // (slice * CLUSTER_TILES_Y + tileY) * CLUSTER_TILES_X + tileX.
  let tileX = c % CLUSTER_TILES_X;
  let row = c / CLUSTER_TILES_X;
  let tileY = row % CLUSTER_TILES_Y;
  let slice = row / CLUSTER_TILES_Y;

  // The counting pass already knows how many lights this cluster holds, and that count is also the
  // bound the fill must not write past: a wrong count trims a list rather than spilling into the next
  // cluster's block.
  let bound = grid.counts[c];
  var kept: array<u32, MAX_LIGHTS_PER_CLUSTER>;
  var n = 0u;
  var evicted = false;

  let lights = min(ranges.count, MAX_CLUSTERED_LIGHTS);
  for (var i = 0u; i < lights; i = i + 1u) {
    if (!covers(ranges.entries[i].key, tileX, tileY, slice)) {
      continue;
    }
    if (n < bound) {
      kept[n] = i;
      n = n + 1u;
      continue;
    }
    if (n == 0u) {
      // Unreachable: a cluster with a covering light has a non-zero count. Present so that a mismatch
      // between the counts and the ranges costs a light instead of writing out of bounds.
      continue;
    }
    // Full: keep the brighter light. The rank is per light, not per cluster, so the same lights lose
    // everywhere and none of them flickers across a cluster boundary. Ties keep the earlier light —
    // the first minimum, and a strictly-greater replacement — exactly as the CPU fill's scan does.
    var weakest = 0u;
    var weakestInfluence = ranges.entries[kept[0]].influence;
    for (var k = 1u; k < n; k = k + 1u) {
      let influence = ranges.entries[kept[k]].influence;
      if (influence < weakestInfluence) {
        weakest = k;
        weakestInfluence = influence;
      }
    }
    if (ranges.entries[i].influence > weakestInfluence) {
      kept[weakest] = i;
      evicted = true;
    }
  }

  // Eviction disturbs the order; restore it, so the fragment stage accumulates in light order — the
  // order the CPU fill and the unclustered path use, and therefore the same floating-point sum.
  if (evicted) {
    for (var a = 1u; a < n; a = a + 1u) {
      let value = kept[a];
      var b = a;
      loop {
        if (b == 0u || kept[b - 1u] <= value) {
          break;
        }
        kept[b] = kept[b - 1u];
        b = b - 1u;
      }
      kept[b] = value;
    }
  }

  let base = c * MAX_LIGHTS_PER_CLUSTER;
  for (var k = 0u; k < n; k = k + 1u) {
    grid.indices[base + k] = kept[k];
  }
}
`;

// ------------------------------------------------------------------ the shader, in TypeScript

/**
 * One packed range key, decoded: does it reach this cluster?
 *
 * The twin of the shader's `covers` — same fields, same order, both reading the shifts out of
 * `RANGE_KEY_BITS`, which is also what `ClusterGrid.packRanges` packs with. Exported because the
 * packed key is a shared interface between two languages, and `tests/clusters.test.ts` proves the keys
 * carry exactly the coverage the CPU fill walks.
 */
export function coversKey(key: number, tileX: number, tileY: number, slice: number): boolean {
  if ((key & (RANGE_KEY_BITS.live.mask << RANGE_KEY_BITS.live.shift)) === 0) return false;
  const bits = (name: keyof typeof RANGE_KEY_BITS) => (key >>> RANGE_KEY_BITS[name].shift) & RANGE_KEY_BITS[name].mask;
  if (slice < bits("slice0") || slice > bits("slice1")) return false;
  if (tileX < bits("tileX0") || tileX > bits("tileX1")) return false;
  if (tileY < bits("tileY0") || tileY > bits("tileY1")) return false;
  return true;
}

/** The shader's per-cluster `kept` list, one array reused across calls (single-threaded reference). */
const keptLights = new Uint32Array(MAX_LIGHTS_PER_CLUSTER);

/**
 * `csAssign`, in TypeScript — the same walk, the same eviction rule, the same order.
 *
 * Reads the packed keys and the influences the shader reads (`counts` is the counting pass's output,
 * which is what the shader reads from the grid buffer) and writes the same lists to the same slots.
 * Exported because it is the executable statement of what the WGSL must do: it is pinned against
 * `ClusterGrid.rasterize` byte for byte in `tests/lightCulling.test.ts`, and `check:browser` compares
 * the real shader's picture against the CPU fill on a device.
 */
export function assignClustersOnCpu(
  packed: Uint32Array,
  influences: Float32Array,
  lightCount: number,
  counts: Uint32Array,
  indices: Uint32Array,
): void {
  const lights = Math.min(lightCount, MAX_CLUSTERED_LIGHTS);
  for (let c = 0; c < CLUSTER_COUNT; c++) {
    const tileX = c % CLUSTER_TILES_X;
    const row = (c / CLUSTER_TILES_X) | 0;
    const tileY = row % CLUSTER_TILES_Y;
    const slice = (row / CLUSTER_TILES_Y) | 0;
    const bound = counts[c]!;
    let n = 0;
    let evicted = false;
    for (let i = 0; i < lights; i++) {
      if (!coversKey(packed[i]!, tileX, tileY, slice)) continue;
      if (n < bound) {
        keptLights[n] = i;
        n++;
        continue;
      }
      if (n === 0) continue;
      let weakest = 0;
      let weakestInfluence = influences[keptLights[0]!]!;
      for (let k = 1; k < n; k++) {
        const influence = influences[keptLights[k]!]!;
        if (influence < weakestInfluence) {
          weakest = k;
          weakestInfluence = influence;
        }
      }
      if (influences[i]! > weakestInfluence) {
        keptLights[weakest] = i;
        evicted = true;
      }
    }
    if (evicted) {
      // Insertion sort: the lists are at most 32 long and only the evicted ones are out of order.
      for (let a = 1; a < n; a++) {
        const value = keptLights[a]!;
        let b = a;
        while (b > 0 && keptLights[b - 1]! > value) {
          keptLights[b] = keptLights[b - 1]!;
          b--;
        }
        keptLights[b] = value;
      }
    }
    const base = c * MAX_LIGHTS_PER_CLUSTER;
    for (let k = 0; k < n; k++) indices[base + k] = keptLights[k]!;
  }
}

// ------------------------------------------------------------------ the device side

/**
 * The GPU fill's device resources and its per-frame recording: one 2 KB range block, one compute
 * pipeline and one bind group. Owned by `Renderer`, created on first use, released by
 * {@link dispose}.
 *
 * The renderer owns the grid buffer and passes it in every frame; the bind group is rebuilt when that
 * buffer's identity changes (a device rebuild, then), which is the only state that can invalidate it.
 */
export class GpuLightCuller {
  private readonly rangeBytes = new WriteBuffer(ClusterRangeBlock.byteSize("storage"));
  /** Packed keys, staged for the upload (`ClusterGrid.packRanges` writes into it). */
  private readonly packed = new Uint32Array(MAX_CLUSTERED_LIGHTS);

  private rangeBuffer: GPUBuffer | null = null;
  private pipeline: GPUComputePipeline | null = null;
  private group: GPUBindGroup | null = null;
  /** The grid buffer the current bind group was built from. */
  private groupGrid: GPUBuffer | null = null;
  private disposed = false;

  constructor(
    private readonly device: GraphicsDevice,
    private readonly shaders: ShaderCache,
  ) {}

  /**
   * Upload this frame's prepared ranges and add `forge.lights.assign` to the frame.
   *
   * The renderer records this only when it is not filling the grid itself, so the pass is part of the
   * frames that fill a grid on the device and of no others — the same way `forge.ssao` belongs to the
   * frames that compute SSAO, and unlike `clearFrame`, which is a property of owning a canvas.
   *
   * The counts the shader reads are the renderer's own upload of `ClusterGrid.counts`, so this must
   * be called after that staging (queue writes are ordered ahead of the submitted command buffer, but
   * the values have to exist by then).
   */
  record(graph: RenderGraph, source: ClusterGrid, ranges: ClusterRanges, gridBuffer: GPUBuffer, label = "forge.lights"): void {
    if (this.disposed) return;
    this.upload(source, ranges);
    this.ensureResources(gridBuffer);
    graph.addPass({ name: `${label}.assign`, sideEffect: true, execute: (ctx) => this.encode(ctx) });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rangeBuffer?.destroy();
    this.rangeBuffer = null;
    this.pipeline = null;
    this.group = null;
    this.groupGrid = null;
  }

  /**
   * Stage the range block: the light count, then each light's packed key and influence. Only the live
   * entries are uploaded — a frame with three lamps does not push 2 KB every frame.
   */
  private upload(source: ClusterGrid, ranges: ClusterRanges): void {
    const lights = Math.min(ranges.lights, MAX_CLUSTERED_LIGHTS);
    this.rangeBytes.u32[0] = lights;
    this.ensureResourcesBuffer();
    if (lights > 0) {
      // Every frame: the ranges move with the lights, so a pack kept from the last frame is stale.
      source.packRanges(this.packed, ranges);
      const u32 = this.rangeBytes.u32;
      const f32 = this.rangeBytes.f32;
      for (let i = 0; i < lights; i++) {
        const slot = RANGE_ENTRY_SLOT + i * RANGE_ENTRY_STRIDE;
        u32[slot] = this.packed[i]!;
        f32[slot + RANGE_INFLUENCE_SLOT] = source.influenceOf(i);
      }
    }
    const bytes = lights > 0 ? (RANGE_ENTRY_SLOT + lights * RANGE_ENTRY_STRIDE) * 4 : 4;
    this.device.device.queue.writeBuffer(this.rangeBuffer!, 0, gpuSource(this.rangeBytes.bytes.subarray(0, bytes)));
  }

  /** The staging buffer, created on first use (before {@link upload} writes into it). */
  private ensureResourcesBuffer(): void {
    this.rangeBuffer ??= this.device.device.createBuffer({
      label: "lights.ranges",
      size: this.rangeBytes.byteLength,
      usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
    });
  }

  private ensureResources(gridBuffer: GPUBuffer): void {
    const d = this.device.device;
    this.ensureResourcesBuffer();
    if (!this.pipeline) {
      // The same static validation and compile-info reporting every other shader in the engine gets.
      const module = this.shaders.get("lights.assign", LIGHT_CULL_SHADER);
      const layout = d.createBindGroupLayout({
        label: "lights.assign",
        entries: [
          { binding: 0, visibility: ShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
          { binding: 1, visibility: ShaderStage.COMPUTE, buffer: { type: "storage" } },
        ],
      });
      this.pipeline = d.createComputePipeline({
        label: "lights.assign",
        layout: d.createPipelineLayout({ label: "lights.assign", bindGroupLayouts: [layout] }),
        compute: { module, entryPoint: "csAssign" },
      });
    }
    if (!this.group || this.groupGrid !== gridBuffer) {
      this.group = d.createBindGroup({
        label: "lights.assign",
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.rangeBuffer! } },
          { binding: 1, resource: { buffer: gridBuffer } },
        ],
      });
      this.groupGrid = gridBuffer;
    }
  }

  /** One invocation per cluster: the grid's 3 072 clusters in twelve workgroups of 256. */
  private encode(ctx: RenderGraphPassContext): void {
    const pass = ctx.encoder.beginComputePass({ label: "lights.assign" });
    pass.setPipeline(this.pipeline!);
    pass.setBindGroup(0, this.group!);
    pass.dispatchWorkgroups(CLUSTER_COUNT / LIGHT_CULL_WORKGROUP);
    pass.end();
  }
}
