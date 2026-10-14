/**
 * Phase A (GPU-placement plan) — the CPU twin of `forge.populationCull`
 * (`rendering/shaders/populationCull.ts`, docs/RENDERING.md §4g).
 *
 * Same steps, same order, same margins as the kernel, on the 80-byte `InstanceData` records the
 * renderer uploads (20 words: 4×vec4 model columns, tint, emissive, flags, materialIndex):
 *
 *  1. write next frame's LOD bit (bit 0) and distance bit (bit 1) into the source record;
 *  2. decide this frame's verdict from the record's *previous* bits plus the shared sphere tests
 *     (`cullSphereOnCpu`: frustum, and HiZ when a pyramid is given);
 *  3. append survivors, with their previous bits, to `compacted` and count them.
 *
 * Parity with the device: the *set* of drawn instances and every counter are exact for the frustum,
 * distance and LOD tests (the same f32 inputs, the same comparisons; the twin computes in f64, so a
 * sphere within ~1e-6 m of a plane can land differently — the 1 cm `CULL_SLOP` makes that a
 * non-visible difference). The *order* of the compacted records is not: the GPU appends in
 * completion order, the twin in index order, so tests compare the compacted records as sets. The HiZ
 * test is compared statistically (tests/population/populationCull.test.ts) against a brute-force
 * per-pixel reference, because the device's pyramid is not readable back on the mock.
 */
import {
  CULL_FLAG_FRUSTUM,
  CULL_FLAG_OCCLUSION,
  CULL_SLOP,
  CullReason,
  cullPlanesFrom,
  cullSphereOnCpu,
  type HizLevel,
  type ObjectCullParams,
} from "../rendering/objectCulling.js";
import { INSTANCE_FLAG_FAR, POP_CULL_DISTANCE, POP_CULL_LOD, POP_CULL_OCCLUSION } from "../rendering/shaders/populationCull.js";

/** Words per `InstanceData` record. */
export const INSTANCE_RECORD_WORDS = 20;
/** Word of `flags` inside a record. */
const FLAGS_WORD = 18;

/** One batch's `PopulationCullUniforms`, as the twin reads them. */
export interface PopulationCullBatch {
  camera: { x: number; y: number; z: number };
  lodDistance: number;
  localCenter: { x: number; y: number; z: number };
  localRadius: number;
  count: number;
  /** `POP_CULL_*` bits. */
  flags: number;
  maxDistance: number;
}

/** Per-dispatch counters (the `PopulationCullStatsBlock` fields). */
export interface PopulationCullStats {
  tested: number;
  drawn: number;
  culledFrustum: number;
  culledDistance: number;
  culledOccluded: number;
  culledBatch: number;
}

export function emptyPopulationCullStats(): PopulationCullStats {
  return { tested: 0, drawn: 0, culledFrustum: 0, culledDistance: 0, culledOccluded: 0, culledBatch: 0 };
}

/**
 * Run one batch through the twin. `source` is the batch's record buffer (as `Float32Array` over the
 * same bytes as `sourceU32`); `compacted` receives the survivors from slot 0. `batchVisible` is the
 * object culler's verdict for the whole batch (`visibility[visibilityIndex] === 0`). Returns the
 * number of compacted records (the indirect record's instance count) and adds into `stats`.
 */
export function cullPopulationInstancesOnCpu(
  source: Float32Array,
  sourceU32: Uint32Array,
  batch: PopulationCullBatch,
  batchVisible: boolean,
  params: ObjectCullParams,
  hiz: readonly HizLevel[],
  compacted: Uint32Array | null,
  stats: PopulationCullStats = emptyPopulationCullStats(),
  planes: Float32Array = cullPlanesFrom(params.viewProj),
): number {
  let drawn = 0;
  const tests = CULL_FLAG_FRUSTUM | ((batch.flags & POP_CULL_OCCLUSION) !== 0 ? CULL_FLAG_OCCLUSION : 0);
  const { camera, localCenter: lc } = batch;
  for (let i = 0; i < batch.count; i++) {
    const b = i * INSTANCE_RECORD_WORDS;
    const previous = sourceU32[b + FLAGS_WORD]!;
    const cx = source[b]! * lc.x + source[b + 4]! * lc.y + source[b + 8]! * lc.z + source[b + 12]!;
    const cy = source[b + 1]! * lc.x + source[b + 5]! * lc.y + source[b + 9]! * lc.z + source[b + 13]!;
    const cz = source[b + 2]! * lc.x + source[b + 6]! * lc.y + source[b + 10]! * lc.z + source[b + 14]!;
    const scale = Math.max(
      Math.hypot(source[b]!, source[b + 1]!, source[b + 2]!),
      Math.hypot(source[b + 4]!, source[b + 5]!, source[b + 6]!),
      Math.hypot(source[b + 8]!, source[b + 9]!, source[b + 10]!),
    );
    const radius = batch.localRadius * scale + CULL_SLOP;

    let next = (previous & ~3) >>> 0;
    if ((batch.flags & POP_CULL_LOD) !== 0) {
      const d = Math.hypot(source[b + 12]! - camera.x, source[b + 13]! - camera.y, source[b + 14]! - camera.z);
      if (d > batch.lodDistance) next |= 1;
    }
    if ((batch.flags & POP_CULL_DISTANCE) !== 0) {
      if (Math.hypot(cx - camera.x, cy - camera.y, cz - camera.z) - radius > batch.maxDistance) next |= INSTANCE_FLAG_FAR;
    }
    sourceU32[b + FLAGS_WORD] = next >>> 0;

    stats.tested++;
    if (!batchVisible) {
      stats.culledBatch++;
      continue;
    }
    if ((previous & INSTANCE_FLAG_FAR) !== 0) {
      stats.culledDistance++;
      continue;
    }
    const reason = cullSphereOnCpu(cx, cy, cz, radius, 0, tests, params, planes, hiz);
    if (reason === CullReason.Frustum) {
      stats.culledFrustum++;
      continue;
    }
    if (reason === CullReason.Occluded) {
      stats.culledOccluded++;
      continue;
    }
    if (compacted) {
      const o = drawn * INSTANCE_RECORD_WORDS;
      compacted.set(sourceU32.subarray(b, b + INSTANCE_RECORD_WORDS), o);
      compacted[o + FLAGS_WORD] = previous;
    }
    drawn++;
    stats.drawn++;
  }
  return drawn;
}

/**
 * The per-instance culling knobs for a device tier (`core/deviceTier.ts`, PR #100): the frustum,
 * distance and LOD work is cheap and always pays (it removes vertex work), so every tier keeps it;
 * the HiZ test's texel loop per instance is the part a low-tier GPU (older iPhones, software
 * adapters) can spend more on than it saves, so `low` turns it off. Pass the result to
 * `RendererOptions` or the renderer's `populationCulling` / `populationOcclusion` setters.
 */
export function populationCullingForTier(tier: "low" | "medium" | "high"): { populationCulling: boolean; populationOcclusion: boolean } {
  return { populationCulling: true, populationOcclusion: tier !== "low" };
}
