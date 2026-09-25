/**
 * Clustered (Forward+) light assignment — the CPU half of Phase 13.3 (docs/RENDERING.md §4b).
 *
 * The forward shader used to walk a fixed 16-entry uniform light list for *every* fragment, so the
 * light budget was a hard cap and the per-pixel cost did not depend on where the lights were. This
 * module splits the camera frustum into a fixed grid of clusters — `CLUSTER_TILES_X ×
 * CLUSTER_TILES_Y` screen tiles × `CLUSTER_SLICES` logarithmic view-depth slices, the 16×8×24 grid
 * `ARCHITECTURE.md` §5.5 asks for — and writes, per cluster, the list of *local* (point/spot) lights
 * that can reach it. The fragment stage looks up its own cluster and evaluates only those lights, so
 * the cost follows the lights near a pixel instead of the lights in the scene, and the cap rises from
 * 16 to `MAX_CLUSTERED_LIGHTS`.
 *
 * A build is two steps: `prepare` (O(lights): bounding spheres, the near/far/off-frame culls, and
 * each light's tile and slice extent) and `rasterize` (the cluster lists). The split is what lets
 * `lightCulling.ts` upload exactly the prepared ranges and run the rasterisation on the GPU, while
 * this file stays the reference implementation the unit tests pin and the renderer's fallback.
 *
 * Pure math: no GPU, no scene imports, nothing allocated per call, so `tests/clusters.test.ts` pins
 * it directly. The three properties that matter:
 *
 *  - **Conservative, never optimistic.** A light is written to every cluster whose volume can come
 *    within `range` of it. The screen extent is the light's *view-space bounding box* projected at
 *    both of its depths: `proj·x/z` is monotone in each axis, so its extremes over the box are at
 *    corners, and for a box that does not straddle the view axis the *far* edge at the far depth
 *    reaches further toward the centre than the near edge at the near depth does. The depth extent is
 *    widened by one slice on each side. Under-inclusion would be a light that
 *    silently stops lighting a surface, which is the one failure mode a viewer cannot diagnose.
 *    Over-inclusion costs a handful of evaluations whose attenuation is exactly zero (a fragment
 *    outside a light's range adds `+0.0`), which is why "clustering on vs off is pixel-identical"
 *    is a gate rather than a hope.
 *  - **Order preserving.** Every cluster's list stays in light order, so the shader accumulates in
 *    the same order as the unclustered path and the two produce the same floating-point sum.
 *  - **Graceful at the caps.** Every cluster owns exactly `MAX_LIGHTS_PER_CLUSTER` slots of the
 *    light-index list (the cap *is* the stride, so the list can never run out and shrink a cluster),
 *    and when a cluster holds more candidates than that the *least influential* lights are dropped —
 *    by a per-light measure, so the same lights lose everywhere and a light cannot pop out at one
 *    cluster boundary and back in at the next — and the build reports it.
 *
 * Directional lights are never clustered: they reach every pixel, so they stay in the small uniform
 * list (`MAX_LIGHTS_PER_FRAME`) where the cascade caster's `shadowIndex` already lives. Orthographic
 * cameras are not clustered either (the renderer refuses): the grid's depth axis is view depth, which
 * an orthographic projection does not put in `clip.w` — the same reason SSAO is perspective-only.
 *
 * All positions are render-local (relative to the coordinate-space origin), like everything else the
 * renderer uploads.
 */

import { Vec3 } from "../math/vec.js";
import type { Mat4 } from "../math/mat.js";

/** Screen tiles across the frame (tile-space u axis). */
export const CLUSTER_TILES_X = 16;
/** Screen tiles down the frame (tile-space v axis, y down). */
export const CLUSTER_TILES_Y = 8;
/** Logarithmic view-depth slices between the camera's near plane and the deepest live light. */
export const CLUSTER_SLICES = 24;
/** `CLUSTER_TILES_X × CLUSTER_TILES_Y × CLUSTER_SLICES` — the grid the shader indexes. */
export const CLUSTER_COUNT = CLUSTER_TILES_X * CLUSTER_TILES_Y * CLUSTER_SLICES;
/** Local lights the cluster light buffer carries (the uniform cap it replaces was 16). */
export const MAX_CLUSTERED_LIGHTS = 256;
/** Light indices one cluster may hold before the least influential are dropped. */
export const MAX_LIGHTS_PER_CLUSTER = 32;
/**
 * Entries in the light-index list (`ClusterGridBlock.indices`), which is laid out as one fixed
 * `MAX_LIGHTS_PER_CLUSTER`-slot block per cluster: cluster `c` owns
 * `indices[c × 32 … c × 32 + counts[c])`. The cap is therefore the *stride*, and a cluster can never
 * lose a light to a buffer running out — a light dropped for a reason nobody can see in the scene —
 * while the list needs no prefix sum or offset table to be addressed. The price of the fixed stride
 * is ≈ 384 KB of resident VRAM (the packed layout it replaces needed ≈ 408 KB).
 */
export const CLUSTER_INDEX_CAPACITY = CLUSTER_COUNT * MAX_LIGHTS_PER_CLUSTER;

/**
 * Margin, in tile-space units (0..1 across the frame), added to a light's projected extent before it
 * is quantised to tiles. The CPU computes that extent in float64 and the fragment stage quantises its
 * own position in float32, so a light whose edge falls exactly on a tile boundary has to be written
 * to both tiles or the pixels on the far side lose it. 1e-4 is a tenth of a pixel at 1080p.
 */
const TILE_EPS = 1e-4;

/** One local light, as the cluster builder sees it (filled in place by the renderer, never allocated). */
export interface ClusterLightSource {
  /** Render-local position. */
  x: number;
  y: number;
  z: number;
  /** Falloff range in metres; the radius of the sphere the light is assigned by. */
  range: number;
  /** True for a spot light: the cone is bounded by a sphere along `dir` before it is assigned. */
  spot: boolean;
  /** Normalised travel direction (the spot axis). */
  dirX: number;
  dirY: number;
  dirZ: number;
  /** Outer cone cosine (spots only). */
  outerCone: number;
  /** Radiance scale, used to rank lights when a cluster is over its cap. */
  intensity: number;
  /** Linear-RGB luma of the light's colour, the other half of that rank. */
  colorLuma: number;
}

/** What the grid needs from the camera. `view` maps render-local space into the engine's view space. */
export interface ClusterCameraParams {
  view: Mat4;
  /** Projection scale terms: `projection[0]` and `projection[5]` (perspective cameras only). */
  proj00: number;
  proj11: number;
  near: number;
  far: number;
}

/** What a build did — surfaced as `RenderStats` fields and asserted by the tests. */
export interface ClusterBuildResult {
  /** Local lights asked for (may exceed `MAX_CLUSTERED_LIGHTS`). */
  requested: number;
  /** Light records written to the cluster light buffer (`min(requested, MAX_CLUSTERED_LIGHTS)`). */
  lights: number;
  /** Lights that reached at least one cluster (the rest are behind the near plane, past the far plane or off-frame). */
  live: number;
  /** Clusters with a non-empty list. */
  clustersUsed: number;
  /** Entries written to the light-index list (the frame's total per-cluster light slots). */
  indexCount: number;
  /** Longest cluster list — what one fragment walks at worst (≤ `MAX_LIGHTS_PER_CLUSTER`). */
  maxPerCluster: number;
  /** One past the highest cluster index any live light touches (0 when nothing is live). */
  maxCluster: number;
  /** View depth the slices span: the camera's far plane, or the deepest live light when that is nearer. */
  far: number;
  /** True when any light was dropped — by a cluster cap, or by exceeding `MAX_CLUSTERED_LIGHTS`. */
  dropped: boolean;
}

/**
 * Radius of the sphere that bounds a spot cone (its centre sits that far along the axis).
 *
 * The cone's extremes are its apex and its rim circle (radius `R·tanθ` at distance `R`). A sphere of
 * radius `ρ` centred `ρ` along the axis contains the apex by construction, and contains the rim when
 * `(R−ρ)² + (R·tanθ)² ≤ ρ²`, which solves to `ρ = R / (2·cos²θ)`. Wide cones therefore get a sphere
 * larger than their range — conservative, and still far tighter than lighting the whole frustum.
 */
export function spotBoundingSphere(range: number, outerConeCos: number): number {
  const c = Math.min(0.999, Math.max(0.05, Number.isFinite(outerConeCos) ? outerConeCos : 0.5));
  return Math.max(0, range) / (2 * c * c);
}

/** NDC (−1..1) → tile-space u (0..1); the fragment stage divides its pixel x by the frame width. */
function ndcToU(ndc: number): number {
  return ndc * 0.5 + 0.5;
}

/** NDC y → tile-space v. Pixel v runs *down* the frame while NDC y runs up, so v = ½ − y/2. */
function ndcToV(ndc: number): number {
  return 0.5 - ndc * 0.5;
}

function tileOf(u: number, tiles: number): number {
  const t = Math.floor(u * tiles);
  return t < 0 ? 0 : t > tiles - 1 ? tiles - 1 : t;
}

/** Non-negative and finite: a NaN intensity must not poison the eviction ranking (every comparison
 * with NaN is false, which would make an unrankable light impossible to evict). */
function positiveOrZero(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Logarithmic slice for a view depth, quantised exactly as the fragment stage quantises it. */
function sliceOf(viewDepth: number, logNear: number, sliceScale: number): number {
  const s = Math.floor((Math.log(Math.max(viewDepth, 1e-6)) - logNear) * sliceScale);
  return s < 0 ? 0 : s > CLUSTER_SLICES - 1 ? CLUSTER_SLICES - 1 : s;
}

/**
 * What the range pass (`prepare`) produced: the per-light tile/slice ranges the rasteriser consumes,
 * plus the frame-level facts the renderer reports (and the fragment stage quantises against).
 *
 * This is the whole of a build that costs O(lights) rather than O(lights × covered clusters), which
 * is why it is a separate step: `lightCulling.ts` uploads exactly these ranges and lets the GPU do
 * the rasterisation, while the CPU rasteriser below consumes them unchanged. One range pass, two
 * rasterisers that agree by construction.
 */
export interface ClusterRanges {
  /** Local lights asked for (may exceed `MAX_CLUSTERED_LIGHTS`). */
  requested: number;
  /** Light records with a range (`min(requested, MAX_CLUSTERED_LIGHTS)`). */
  lights: number;
  /** Lights that reached at least one cluster: the rest are behind the near plane, past the far plane or off-frame. */
  live: number;
  /** View depth the slices span: the camera's far plane, or the deepest live light when that is nearer. */
  far: number;
  /** One past the highest cluster index any live light touches (0 when nothing is live). */
  maxCluster: number;
}

/**
 * The cluster grid: reusable typed arrays plus the per-frame build.
 *
 * `counts` and `indices` are uploaded verbatim as `ClusterGridBlock` (one u32 per cluster, then the
 * fixed-stride light-index blocks — `MAX_LIGHTS_PER_CLUSTER` slots each). The cluster index
 * convention shared with the shader is `(slice × CLUSTER_TILES_Y + tileY) × CLUSTER_TILES_X + tileX`.
 */
export class ClusterGrid {
  /** One u32 per cluster: how many entries of its block in `indices` are valid. */
  readonly counts = new Uint32Array(CLUSTER_COUNT);
  /** Cluster-major light-index blocks, `MAX_LIGHTS_PER_CLUSTER` slots per cluster. */
  readonly indices = new Uint32Array(CLUSTER_INDEX_CAPACITY);

  /** Per light: (tileX0, tileY0, slice0, tileX1, tileY1, slice1); `tileX1 < tileX0` means "not live". */
  private readonly ranges = new Int32Array(MAX_CLUSTERED_LIGHTS * 6);
  /** Per light: view-space bounding sphere (x, y, z, radius); a negative radius means "not live". */
  private readonly spheres = new Float32Array(MAX_CLUSTERED_LIGHTS * 4);
  /** Per light: how a cluster ranks it when it has to drop one (`intensity × colour luma`). */
  private readonly influence = new Float32Array(MAX_CLUSTERED_LIGHTS);
  private readonly candidates = new Uint32Array(CLUSTER_COUNT);
  private readonly cursor = new Uint32Array(CLUSTER_COUNT);
  private readonly unordered = new Uint8Array(CLUSTER_COUNT);
  private readonly centre = new Vec3();
  private readonly viewCentre = new Vec3();

  /** Full build: the range pass, then the CPU rasterisation. Writes `counts`/`indices`; allocates nothing. */
  build(lights: readonly ClusterLightSource[], params: ClusterCameraParams, requested = lights.length): ClusterBuildResult {
    return this.rasterize(this.prepare(lights, params, requested));
  }

  /**
   * The range pass: view-space bounding sphere per light, the near/far/off-frame culls, and the
   * tile/slice extent of every light that survives them. Writes the class's scratch arrays only —
   * this is what the GPU path uploads (via {@link packRanges}) instead of recomputing in float32.
   *
   * `requested` is how many of `lights` are valid — the renderer keeps a high-water-mark array and
   * passes the frame's count rather than copying a slice of it every frame.
   */
  prepare(lights: readonly ClusterLightSource[], params: ClusterCameraParams, requested = lights.length): ClusterRanges {
    const count = Math.min(requested, MAX_CLUSTERED_LIGHTS);
    const near = Math.max(1e-4, Number.isFinite(params.near) ? params.near : 0.1);
    const nearEdge = near * (1 + 1e-4);
    const farPlane = Math.max(nearEdge * 2, Number.isFinite(params.far) ? params.far : nearEdge * 2);

    // 1. View-space bounding sphere per light, and the deepest one — which is where the slices end,
    //    because spanning the camera's whole far plane would waste most of them on empty distance.
    let live = 0;
    let deepest = 0;
    for (let i = 0; i < count; i++) {
      const l = lights[i]!;
      const range = Math.max(0, Number.isFinite(l.range) ? l.range : 0);
      let cx = l.x;
      let cy = l.y;
      let cz = l.z;
      let radius = range;
      if (l.spot) {
        radius = spotBoundingSphere(range, l.outerCone);
        cx += l.dirX * radius;
        cy += l.dirY * radius;
        cz += l.dirZ * radius;
      }
      this.centre.set(cx, cy, cz);
      params.view.transformPoint(this.centre, this.viewCentre);
      const vz = this.viewCentre.z;
      const s = i * 4;
      // A light whose transform went non-finite (a broken hierarchy, an unnormalised quaternion) is
      // dropped rather than allowed to poison the grid: one NaN here would make the slice span NaN
      // and silently empty every cluster in the frame.
      if (!Number.isFinite(this.viewCentre.x) || !Number.isFinite(this.viewCentre.y) || !Number.isFinite(vz) || !Number.isFinite(radius)) {
        this.markDead(i);
        continue;
      }
      // A light entirely behind the near plane or past the far plane cannot reach any visible
      // surface: every point in front of the near plane is farther from it than its own range.
      if (vz + radius <= nearEdge || vz - radius > farPlane) {
        this.markDead(i);
        continue;
      }
      this.spheres[s] = this.viewCentre.x;
      this.spheres[s + 1] = this.viewCentre.y;
      this.spheres[s + 2] = vz;
      this.spheres[s + 3] = radius;
      this.influence[i] = positiveOrZero(l.intensity) * positiveOrZero(l.colorLuma);
      deepest = Math.max(deepest, Math.min(vz + radius, farPlane));
      live++;
    }

    if (live === 0) return { requested, lights: count, live: 0, far: near, maxCluster: 0 };

    const clusterFar = Math.min(farPlane, Math.max(deepest, nearEdge * 1.001));
    const logNear = Math.log(near);
    const sliceScale = CLUSTER_SLICES / Math.max(1e-6, Math.log(clusterFar / near));

    // 2. Tile and slice ranges.
    let maxCluster = 0;
    for (let i = 0; i < count; i++) {
      const s = i * 4;
      const radius = this.spheres[s + 3]!;
      if (radius < 0) continue;
      const vx = this.spheres[s]!;
      const vy = this.spheres[s + 1]!;
      const vz = this.spheres[s + 2]!;
      const zmin = vz - radius;
      const zmax = vz + radius;
      const b = i * 6;
      // Depth, widened by one slice on each side: the CPU quantises in float64 and the fragment
      // stage in float32, and a boundary disagreement must never drop a light (see the header).
      let slice0 = sliceOf(Math.max(zmin, nearEdge), logNear, sliceScale) - 1;
      let slice1 = sliceOf(Math.min(zmax, clusterFar), logNear, sliceScale) + 1;
      slice0 = slice0 < 0 ? 0 : slice0;
      slice1 = slice1 > CLUSTER_SLICES - 1 ? CLUSTER_SLICES - 1 : slice1;
      this.ranges[b + 2] = slice0;
      this.ranges[b + 5] = slice1;

      // Screen. A sphere that reaches the near plane projects without bound, so it takes every tile.
      if (zmin <= nearEdge) {
        this.ranges[b] = 0;
        this.ranges[b + 1] = 0;
        this.ranges[b + 3] = CLUSTER_TILES_X - 1;
        this.ranges[b + 4] = CLUSTER_TILES_Y - 1;
        maxCluster = Math.max(maxCluster, maxClusterOf(slice1, CLUSTER_TILES_Y - 1, CLUSTER_TILES_X - 1));
        continue;
      }
      // Both depths of the box, not only the nearest. `ndc.x = proj00·x/z` moves *toward the centre*
      // as z grows, so for a box that does not straddle the view axis the near edge at the near depth
      // is not the box's extreme: the far edge at the far depth reaches further in. Projecting at
      // zmin alone cost an off-axis lamp the tiles its own far side covered (a pool of light with a
      // bite out of its inner edge), and it made the off-frame cull below reject lights that were on
      // screen. The corner min/max over both depths is the box's conservative silhouette, and the
      // extremes of a monotone-in-each-axis function are always at corners.
      const kmin = 1 / zmin;
      const kmax = 1 / zmax;
      const ax = vx - radius;
      const bx = vx + radius;
      const ay = vy - radius;
      const by = vy + radius;
      const x0 = params.proj00 * Math.min(ax * kmin, ax * kmax, bx * kmin, bx * kmax);
      const x1 = params.proj00 * Math.max(ax * kmin, ax * kmax, bx * kmin, bx * kmax);
      const y0 = params.proj11 * Math.min(ay * kmin, ay * kmax, by * kmin, by * kmax);
      const y1 = params.proj11 * Math.max(ay * kmin, ay * kmax, by * kmin, by * kmax);
      // Off-frame lights are culled here rather than clamped into the edge tile: the cull is free
      // once the extent is known, and it keeps the index list proportional to what is visible.
      if (x1 < -1 - 2 * TILE_EPS || x0 > 1 + 2 * TILE_EPS || y1 < -1 - 2 * TILE_EPS || y0 > 1 + 2 * TILE_EPS) {
        this.markDead(i);
        live--;
        continue;
      }
      const tileX0 = tileOf(ndcToU(x0) - TILE_EPS, CLUSTER_TILES_X);
      const tileX1 = tileOf(ndcToU(x1) + TILE_EPS, CLUSTER_TILES_X);
      const tileY0 = tileOf(ndcToV(y1) - TILE_EPS, CLUSTER_TILES_Y);
      const tileY1 = tileOf(ndcToV(y0) + TILE_EPS, CLUSTER_TILES_Y);
      this.ranges[b] = tileX0;
      this.ranges[b + 3] = tileX1;
      this.ranges[b + 1] = tileY0;
      this.ranges[b + 4] = tileY1;
      maxCluster = Math.max(maxCluster, maxClusterOf(slice1, tileY1, tileX1));
    }
    return { requested, lights: count, live, far: clusterFar, maxCluster };
  }

  /**
   * The rasterisation (the CPU rasteriser): candidate counts, the per-cluster cap, and the lists
   * themselves, in light order with the least influential lights evicted once a cluster is full.
   *
   * `tests/clusters.test.ts` pins this against conservation; `lightCulling.ts` transcribes the same
   * rules into the compute shader the GPU path runs, and the browser gate A/Bs the two on pixels.
   */
  rasterize(rangePass: ClusterRanges): ClusterBuildResult {
    const count = rangePass.lights;
    const result: ClusterBuildResult = {
      requested: rangePass.requested,
      lights: count,
      live: rangePass.live,
      clustersUsed: 0,
      indexCount: 0,
      maxPerCluster: 0,
      maxCluster: rangePass.maxCluster,
      far: rangePass.far,
      dropped: rangePass.requested > count,
    };
    this.counts.fill(0);
    this.candidates.fill(0);
    this.unordered.fill(0);
    if (rangePass.live === 0) return result;

    // 3. Candidate counts. The traversal is inlined (no callback) because it runs twice per light
    //    per frame.
    for (let i = 0; i < count; i++) {
      const b = i * 6;
      const x0 = this.ranges[b]!;
      const x1 = this.ranges[b + 3]!;
      if (x1 < x0) continue;
      const y0 = this.ranges[b + 1]!;
      const y1 = this.ranges[b + 4]!;
      for (let s = this.ranges[b + 2]!; s <= this.ranges[b + 5]!; s++) {
        for (let y = y0; y <= y1; y++) {
          const row = (s * CLUSTER_TILES_Y + y) * CLUSTER_TILES_X;
          for (let x = x0; x <= x1; x++) this.candidates[row + x] = (this.candidates[row + x] ?? 0) + 1;
        }
      }
    }
    let clustersUsed = 0;
    for (let c = 0; c < CLUSTER_COUNT; c++) if ((this.candidates[c] ?? 0) > 0) clustersUsed++;

    // 4. Per-cluster counts and cursors. Each cluster owns `MAX_LIGHTS_PER_CLUSTER` slots from the
    //    start, so there is no prefix sum to run and no capacity arithmetic to shrink the cap with.
    const cap = MAX_LIGHTS_PER_CLUSTER;
    let offset = 0;
    let maxPerCluster = 0;
    for (let c = 0; c < CLUSTER_COUNT; c++) {
      const n = Math.min(this.candidates[c] ?? 0, cap);
      this.counts[c] = n;
      this.cursor[c] = c * cap;
      offset += n;
      if (n > maxPerCluster) maxPerCluster = n;
    }
    result.clustersUsed = clustersUsed;
    result.indexCount = offset;
    result.maxPerCluster = maxPerCluster;

    // 5. Fill in light order, evicting the least influential light once a cluster is full.
    for (let i = 0; i < count; i++) {
      const b = i * 6;
      const x0 = this.ranges[b]!;
      const x1 = this.ranges[b + 3]!;
      if (x1 < x0) continue;
      const weight = this.influence[i]!;
      const y0 = this.ranges[b + 1]!;
      const y1 = this.ranges[b + 4]!;
      for (let s = this.ranges[b + 2]!; s <= this.ranges[b + 5]!; s++) {
        for (let y = y0; y <= y1; y++) {
          const row = (s * CLUSTER_TILES_Y + y) * CLUSTER_TILES_X;
          for (let x = x0; x <= x1; x++) {
            const c = row + x;
            const start = c * cap;
            const end = start + this.counts[c]!;
            const at = this.cursor[c]!;
            if (at < end) {
              this.indices[at] = i;
              this.cursor[c] = at + 1;
              continue;
            }
            result.dropped = true;
            // Full: keep the brighter light. The rank is per light, not per cluster, so the same
            // lights lose everywhere and none of them flickers on one side of a cluster boundary.
            let weakest = start;
            for (let p = start + 1; p < end; p++) {
              if (this.influence[this.indices[p]!]! < this.influence[this.indices[weakest]!]!) weakest = p;
            }
            if (weight > this.influence[this.indices[weakest]!]!) {
              this.indices[weakest] = i;
              this.unordered[c] = 1;
            }
          }
        }
      }
    }

    // 6. Eviction disturbs the order; restore it, so the shader's accumulation order (and therefore
    //    its floating-point sum) never depends on which lights were dropped.
    for (let c = 0; c < CLUSTER_COUNT; c++) {
      if (!this.unordered[c]) continue;
      const start = c * cap;
      this.indices.subarray(start, start + this.counts[c]!).sort();
    }
    return result;
  }

  /**
   * The prepared ranges, packed one u32 per light for the GPU rasteriser (`lightCulling.ts`):
   *
   * ```
   * bits  0-3  tileX0   bits  4-7  tileX1   bits 8-10  tileY0   bits 11-13  tileY1
   * bits 14-18 slice0   bits 19-23 slice1   bit 24    live (0 = this light reaches no cluster)
   * ```
   *
   * `out` must hold `MAX_CLUSTERED_LIGHTS` entries; only the first `ClusterRanges.lights` are valid.
   * The rasteriser tests a cluster against one packed key with three range comparisons — the same
   * comparisons the loops above make, on the same numbers, so the two paths cannot disagree about
   * which clusters a light reaches.
   */
  packRanges(out: Uint32Array, rangePass: ClusterRanges): void {
    for (let i = 0; i < rangePass.lights; i++) {
      const b = i * 6;
      const x0 = this.ranges[b]!;
      const x1 = this.ranges[b + 3]!;
      // `tileX1 < tileX0` is the dead marker (`markDead`), and a dead light must match no cluster —
      // packing it as zeros with the live bit clear is exactly that.
      if (x1 < x0) {
        out[i] = 0;
        continue;
      }
      out[i] =
        (x0 & 0xf) |
        ((x1 & 0xf) << 4) |
        ((this.ranges[b + 1]! & 0x7) << 8) |
        ((this.ranges[b + 4]! & 0x7) << 11) |
        ((this.ranges[b + 2]! & 0x1f) << 14) |
        ((this.ranges[b + 5]! & 0x1f) << 19) |
        (1 << 24);
    }
  }

  /** Influence per light, the rank the rasteriser evicts by (indexed like `packRanges`). */
  influenceOf(i: number): number {
    return this.influence[i] ?? 0;
  }

  /** The lights in one cluster, as a view of `indices` (tests, debug overlays). */
  lightsIn(tileX: number, tileY: number, slice: number): Uint32Array {
    return this.lightsOf(ClusterGrid.clusterIndex(tileX, tileY, slice));
  }

  /** The lights in one cluster by index. */
  lightsOf(cluster: number): Uint32Array {
    const start = cluster * MAX_LIGHTS_PER_CLUSTER;
    return this.indices.subarray(start, start + (this.counts[cluster] ?? 0));
  }

  /** Cluster index for a tile/slice triple — the convention the fragment stage computes. */
  static clusterIndex(tileX: number, tileY: number, slice: number): number {
    return maxClusterOf(slice, tileY, tileX);
  }

  /** Mark a light as contributing to no cluster (empty range, negative radius). */
  private markDead(i: number): void {
    const b = i * 6;
    this.ranges[b] = 0;
    this.ranges[b + 1] = 0;
    this.ranges[b + 2] = 0;
    this.ranges[b + 3] = -1;
    this.ranges[b + 4] = 0;
    this.ranges[b + 5] = 0;
    this.spheres[i * 4 + 3] = -1;
  }
}

/** `(slice × CLUSTER_TILES_Y + tileY) × CLUSTER_TILES_X + tileX` — the shared cluster index. */
function maxClusterOf(slice: number, tileY: number, tileX: number): number {
  return (slice * CLUSTER_TILES_Y + tileY) * CLUSTER_TILES_X + tileX;
}

/** The view-depth slice a fragment at `viewDepth` belongs to (the shader's own expression, in f64). */
export function clusterSliceFor(viewDepth: number, near: number, far: number): number {
  const n = Math.max(1e-4, near);
  const f = Math.max(n * 1.001, far);
  return sliceOf(Math.max(viewDepth, n), Math.log(n), CLUSTER_SLICES / Math.max(1e-6, Math.log(f / n)));
}
