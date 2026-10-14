/**
 * Phase A (GPU-placement plan) — the CPU twins of `forge.populationCull.views` and
 * `forge.populationCull` (`rendering/shaders/populationCull.ts`, docs/RENDERING.md §4g):
 * `cullPopulationViewsOnCpu` and `cullPopulationOcclusionOnCpu` mirror the two kernels and are what
 * the mock device runs; `cullPopulationInstancesOnCpu` below is the composed single-pass reference
 * (main view only) the tests compare the two-stage result against.
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
  /** Instance × shadow-map pairs `forge.populationCull.views` tested ("in"). */
  shadowTested: number;
  /** Of those, the pairs kept: casters the shadow passes draw. */
  shadowDrawn: number;
}

export function emptyPopulationCullStats(): PopulationCullStats {
  return { tested: 0, drawn: 0, culledFrustum: 0, culledDistance: 0, culledOccluded: 0, culledBatch: 0, shadowTested: 0, shadowDrawn: 0 };
}

/** Instance sphere (world centre + radius) the kernels test: prototype bounds through the matrix, max axis scale, plus slop. */
function instanceSphere(source: Float32Array, b: number, batch: PopulationCullBatch, out: Float64Array): void {
  const lc = batch.localCenter;
  out[0] = source[b]! * lc.x + source[b + 4]! * lc.y + source[b + 8]! * lc.z + source[b + 12]!;
  out[1] = source[b + 1]! * lc.x + source[b + 5]! * lc.y + source[b + 9]! * lc.z + source[b + 13]!;
  out[2] = source[b + 2]! * lc.x + source[b + 6]! * lc.y + source[b + 10]! * lc.z + source[b + 14]!;
  const scale = Math.max(
    Math.hypot(source[b]!, source[b + 1]!, source[b + 2]!),
    Math.hypot(source[b + 4]!, source[b + 5]!, source[b + 6]!),
    Math.hypot(source[b + 8]!, source[b + 9]!, source[b + 10]!),
  );
  out[3] = batch.localRadius * scale + CULL_SLOP;
}

/** Sphere fully outside one of the six planes of `cullPlanesFrom` (the kernels' `outsideFrustum`). */
export function sphereOutsidePlanes(planes: Float32Array, cx: number, cy: number, cz: number, radius: number): boolean {
  for (let row = 0; row < 6; row++) {
    const nx = planes[row * 4]!;
    const ny = planes[row * 4 + 1]!;
    const nz = planes[row * 4 + 2]!;
    if (nx * cx + ny * cy + nz * cz + planes[row * 4 + 3]! < -Math.hypot(nx, ny, nz) * radius) return true;
  }
  return false;
}

/** Write next frame's LOD (bit 0) and distance (bit 1) bits into record `i`; returns the previous flags. */
function writeNextBits(source: Float32Array, sourceU32: Uint32Array, i: number, batch: PopulationCullBatch): number {
  const b = i * INSTANCE_RECORD_WORDS;
  const previous = sourceU32[b + FLAGS_WORD]!;
  const { camera } = batch;
  let next = (previous & ~3) >>> 0;
  if ((batch.flags & POP_CULL_LOD) !== 0) {
    const d = Math.hypot(source[b + 12]! - camera.x, source[b + 13]! - camera.y, source[b + 14]! - camera.z);
    if (d > batch.lodDistance) next |= 1;
  }
  // Pivot past the fade end (`populationFadeScale` reaches 0 there, fe-31).
  if ((batch.flags & POP_CULL_DISTANCE) !== 0 && pivotDistance(source, b, camera) > batch.maxDistance) next |= INSTANCE_FLAG_FAR;
  sourceU32[b + FLAGS_WORD] = next >>> 0;
  return previous;
}

const SPHERE = new Float64Array(4);

/** Camera-to-pivot distance of record `b` (the model's translation, `row3`): the fade and distance metric. */
function pivotDistance(source: Float32Array, b: number, camera: { x: number; y: number; z: number }): number {
  return Math.hypot(source[b + 12]! - camera.x, source[b + 13]! - camera.y, source[b + 14]! - camera.z);
}

/**
 * CPU twin of the vertex stages' `populationFadeScale` (fe-31): the factor an instance whose pivot is
 * `distance` metres from the camera is scaled by — 1 up to `fadeStart`, smoothstep down to 0 at
 * `fadeEnd` (the batch's distance limit, where the cull drops it). `fadeEnd <= 0` means no fade.
 */
export function populationFadeScale(distance: number, fadeStart: number, fadeEnd: number): number {
  if (!(fadeEnd > 0)) return 1;
  const t = Math.min(1, Math.max(0, (distance - fadeStart) / Math.max(fadeEnd - fadeStart, 1e-3)));
  return 1 - t * t * (3 - 2 * t);
}

/**
 * Twin of `forge.populationCull.views` (before the depth passes). Main view: previous distance bit,
 * then the camera frustum; survivors are copied (previous bits intact — this pass writes no bits)
 * to `compacted` from slot 0. Shadows: for each entry of `shadowPlanes` (the batch's mask bits in
 * bit order) the sphere is tested against that light frustum and the instance *index* appended to
 * range k of `indices` (`k * indexStride`); `shadowCounts[k]` receives the range's length. Returns
 * the main-view list length. Counts `drawn` here only when the batch does not occlude this frame.
 */
export function cullPopulationViewsOnCpu(
  source: Float32Array,
  sourceU32: Uint32Array,
  batch: PopulationCullBatch,
  mainPlanes: Float32Array,
  shadowPlanes: readonly Float32Array[],
  compacted: Uint32Array | null,
  indices: Uint32Array | null,
  indexStride: number,
  shadowCounts: Uint32Array,
  stats: PopulationCullStats = emptyPopulationCullStats(),
): number {
  let listed = 0;
  shadowCounts.fill(0);
  const occludes = (batch.flags & POP_CULL_OCCLUSION) !== 0;
  for (let i = 0; i < batch.count; i++) {
    const b = i * INSTANCE_RECORD_WORDS;
    instanceSphere(source, b, batch, SPHERE);
    const cx = SPHERE[0]!, cy = SPHERE[1]!, cz = SPHERE[2]!, r = SPHERE[3]!;
    stats.tested++;
    if ((sourceU32[b + FLAGS_WORD]! & INSTANCE_FLAG_FAR) !== 0) {
      stats.culledDistance++;
    } else if (sphereOutsidePlanes(mainPlanes, cx, cy, cz, r)) {
      stats.culledFrustum++;
    } else {
      if (compacted) compacted.set(sourceU32.subarray(b, b + INSTANCE_RECORD_WORDS), listed * INSTANCE_RECORD_WORDS);
      listed++;
      if (!occludes) stats.drawn++;
    }
    // Past the fade end the instance is scale 0 in every pass: it casts nothing (fe-31).
    const shadowMaps = (sourceU32[b + FLAGS_WORD]! & INSTANCE_FLAG_FAR) !== 0 ? 0 : shadowPlanes.length;
    for (let k = 0; k < shadowMaps; k++) {
      stats.shadowTested++;
      if (sphereOutsidePlanes(shadowPlanes[k]!, cx, cy, cz, r)) continue;
      if (indices) indices[k * indexStride + shadowCounts[k]!] = i;
      shadowCounts[k]!++;
      stats.shadowDrawn++;
    }
  }
  // `tested` is accounted for by the stage that buckets the instance last; undo the double count the
  // occlusion twin will add for listed entries.
  if (occludes) stats.tested -= listed;
  return listed;
}

/**
 * Twin of `forge.populationCull` (after the object culler): writes next frame's bits into every
 * source record, then — only when the batch occludes this frame — filters the first `listed`
 * entries of `compacted` (the views pass's main-view list): batch-culled, then HiZ, survivors
 * copied to `occluded`. Returns the survivor count (0 when the batch does not occlude).
 */
export function cullPopulationOcclusionOnCpu(
  source: Float32Array,
  sourceU32: Uint32Array,
  batch: PopulationCullBatch,
  compacted: Uint32Array,
  listed: number,
  batchVisible: boolean,
  params: ObjectCullParams,
  hiz: readonly HizLevel[],
  occluded: Uint32Array | null,
  stats: PopulationCullStats = emptyPopulationCullStats(),
): number {
  for (let i = 0; i < batch.count; i++) writeNextBits(source, sourceU32, i, batch);
  if ((batch.flags & POP_CULL_OCCLUSION) === 0) return 0;
  const listF32 = new Float32Array(compacted.buffer, compacted.byteOffset, compacted.length);
  const planes = cullPlanesFrom(params.viewProj);
  let kept = 0;
  for (let s = 0; s < listed; s++) {
    const b = s * INSTANCE_RECORD_WORDS;
    stats.tested++;
    if (!batchVisible) {
      stats.culledBatch++;
      continue;
    }
    instanceSphere(listF32, b, batch, SPHERE);
    if (cullSphereOnCpu(SPHERE[0]!, SPHERE[1]!, SPHERE[2]!, SPHERE[3]!, 0, CULL_FLAG_OCCLUSION, params, planes, hiz) === CullReason.Occluded) {
      stats.culledOccluded++;
      continue;
    }
    if (occluded) occluded.set(compacted.subarray(b, b + INSTANCE_RECORD_WORDS), kept * INSTANCE_RECORD_WORDS);
    kept++;
    stats.drawn++;
  }
  return kept;
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
    if ((batch.flags & POP_CULL_DISTANCE) !== 0 && pivotDistance(source, b, camera) > batch.maxDistance) next |= INSTANCE_FLAG_FAR;
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
 * adapters) can spend more on than it saves, so `low` turns it off; `low` also limits the device
 * shadow-caster cull to the sun's cascades (one index range per cascade, not per spot/point face).
 * `populationDistanceScale` sets the draw distance per tier (`POPULATION_DISTANCE_SCALE_BY_TIER`).
 * Pass the result to `RendererOptions` or the renderer's matching setters.
 */
export function populationCullingForTier(tier: "low" | "medium" | "high"): {
  populationCulling: boolean;
  populationOcclusion: boolean;
  populationShadowCulling: PopulationShadowCulling;
  populationDistanceScale: number;
} {
  return {
    populationCulling: true,
    populationOcclusion: tier !== "low",
    populationShadowCulling: tier === "low" ? "cascades" : "all",
    populationDistanceScale: POPULATION_DISTANCE_SCALE_BY_TIER[tier],
  };
}

/**
 * fe-31: how far population draws per device tier, as a multiple of each type's `maxDistance`
 * (`RendererOptions.populationDistanceScale`). High draws half again as far (distant terrain keeps its
 * rocks); medium is the authored distance; low trims a quarter — fewer instances to cull, shade and
 * cast. Every tier fades the last `populationFadeFraction` of the (scaled) distance instead of popping.
 */
export const POPULATION_DISTANCE_SCALE_BY_TIER: Readonly<Record<"low" | "medium" | "high", number>> = { low: 0.75, medium: 1, high: 1.5 };

/**
 * Which shadow maps cull population casters per instance on the device (`RendererOptions.
 * populationShadowCulling`): `"all"` (cascades, spot maps, point faces), `"cascades"` (the sun's
 * cascades only; spot/point maps keep the CPU per-instance assignment — fewer device passes and a
 * smaller index buffer, the low-tier setting) or `"off"`.
 */
export type PopulationShadowCulling = "all" | "cascades" | "off";
