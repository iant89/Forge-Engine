/**
 * Mars surface geology for the terrain port — transcribed from `mars-terrain-gen`
 * (`src/geology/{materials,craters3,volcanic3,dichotomy3}.ts`, `src/terrain/analyticBase.ts` and
 * the `fineDetail` function in `src/chunk/chunkGenerator.ts`).
 *
 * Everything here is a *pure point-wise function of a unit direction on the sphere*: no grid, no
 * neighbour lookups, no per-chunk RNG. That is what makes the generator resolution-independent, and
 * it is what lets the port feed Forge's square, planar, LOD-morphed chunks at whatever size the
 * scene asks for, while still producing exactly the terrain the generator's Stage A erosion pass was
 * measured against.
 *
 * The one non-point-wise ingredient — simulated erosion — arrives separately, as the bilinear
 * `erosionDelta` field sampled by `globalFields.ts`; see `docs/MARS-TERRAIN.md`.
 */

import { hash3 } from "./noise3.js";
import { marsDomainWarp3, marsFbm3, marsRidged3 } from "./noise3.js";

/** Surface material ids, in the generator's order (`GeoMaterial` upstream). */
export enum MarsMaterial {
  BasaltLowland = 0,
  LayeredSediment = 1,
  VolcanicFlank = 2,
  CraterEjecta = 3,
  CraterFloor = 4,
  Regolith = 5,
  DuneField = 6,
  PolarIce = 7,
  ExposedBedrock = 8,
  ChannelFloor = 9,
}

export const MARS_MATERIAL_COUNT = 10;

/**
 * Base rock hardness per material, 0..1 (higher = more erosion-resistant). Drives the fine detail
 * amplitude: soft rock gets taller, smoother gully-like ridges; hard rock gets shorter, sharper
 * exposed-rock texture.
 */
export const MARS_MATERIAL_HARDNESS: Record<MarsMaterial, number> = {
  [MarsMaterial.BasaltLowland]: 0.75,
  [MarsMaterial.LayeredSediment]: 0.35,
  [MarsMaterial.VolcanicFlank]: 0.6,
  [MarsMaterial.CraterEjecta]: 0.4,
  [MarsMaterial.CraterFloor]: 0.5,
  [MarsMaterial.Regolith]: 0.15,
  [MarsMaterial.DuneField]: 0.05,
  [MarsMaterial.PolarIce]: 0.2,
  [MarsMaterial.ExposedBedrock]: 0.9,
  [MarsMaterial.ChannelFloor]: 0.3,
};

// ------------------------------------------------------------------ craters

export interface MarsCraterScale {
  cellSizeMeters: number;
  minRadius: number;
  maxRadius: number;
  maxDepthRatio: number;
  rimHeightRatio: number;
}

/**
 * Three size bands loosely modelled on real Mars crater populations: huge ancient basins
 * (Hellas/Argyre-scale), medium craters, and abundant small craters for close-up detail.
 */
export const MARS_CRATER_SCALES: MarsCraterScale[] = [
  { cellSizeMeters: 500_000, minRadius: 40_000, maxRadius: 220_000, maxDepthRatio: 0.05, rimHeightRatio: 0.015 },
  { cellSizeMeters: 50_000, minRadius: 3_000, maxRadius: 20_000, maxDepthRatio: 0.12, rimHeightRatio: 0.06 },
  { cellSizeMeters: 5_000, minRadius: 150, maxRadius: 1_800, maxDepthRatio: 0.18, rimHeightRatio: 0.09 },
];

function craterProfile(
  distNorm: number,
  depthRatio: number,
  rimHeightRatio: number,
  centralPeak: boolean,
  age: number,
): number {
  const rimSharpness = 1 - age * 0.7; // older craters have softer, more degraded rims
  if (distNorm <= 1) {
    const bowl = -depthRatio * (1 - distNorm * distNorm) * (0.6 + 0.4 * rimSharpness);
    let peak = 0;
    if (centralPeak && distNorm < 0.25) peak = depthRatio * 0.5 * (1 - distNorm / 0.25) * rimSharpness;
    const rimBump =
      distNorm > 0.75
        ? rimHeightRatio * Math.sin(((distNorm - 0.75) / 0.25) * Math.PI) * rimSharpness
        : 0;
    return bowl + peak + rimBump;
  } else if (distNorm < 2.2) {
    const t = (distNorm - 1) / 1.2;
    return rimHeightRatio * (1 - t) * (1 - t) * 0.5 * rimSharpness; // ejecta blanket falloff
  }
  return 0;
}

/** One jittered crater-centre candidate per 3D grid cell; most cells hold no crater (density test). */
function cellCraterCandidate(
  cix: number,
  ciy: number,
  ciz: number,
  cellSize: number,
  seed: number,
): { cx: number; cy: number; cz: number; id: number } | null {
  const density = hash3(cix, ciy, ciz, seed * 7 + 1);
  if (density > 0.55) return null;
  const jx = (hash3(cix, ciy, ciz, seed * 7 + 2) - 0.5) * cellSize;
  const jy = (hash3(cix, ciy, ciz, seed * 7 + 3) - 0.5) * cellSize;
  const jz = (hash3(cix, ciy, ciz, seed * 7 + 4) - 0.5) * cellSize;
  return {
    cx: (cix + 0.5) * cellSize + jx,
    cy: (ciy + 0.5) * cellSize + jy,
    cz: (ciz + 0.5) * cellSize + jz,
    id: Math.floor(hash3(cix, ciy, ciz, seed * 7 + 5) * 1e9),
  };
}

/** A crater whose cell has been hashed, with the per-crater values the profile needs. */
interface ResolvedCrater {
  band: number;
  /** Cell triple, so a vertex can apply the generator's +-1 cell window itself. */
  cix: number;
  ciy: number;
  ciz: number;
  cx: number;
  cy: number;
  cz: number;
  id: number;
  radius: number;
  age: number;
  centralPeak: boolean;
  depthRatio: number;
  rimHeightRatio: number;
}

function resolveCrater(
  band: number,
  scale: MarsCraterScale,
  seed: number,
  cix: number,
  ciy: number,
  ciz: number,
): ResolvedCrater | null {
  const cand = cellCraterCandidate(cix, ciy, ciz, scale.cellSizeMeters, seed ^ (scale.cellSizeMeters | 0));
  if (!cand) return null;
  const radius = scale.minRadius + hash3(cand.id, 0, 0, seed) * (scale.maxRadius - scale.minRadius);
  return {
    band,
    cix,
    ciy,
    ciz,
    cx: cand.cx,
    cy: cand.cy,
    cz: cand.cz,
    id: cand.id,
    radius,
    age: hash3(cand.id, 1, 0, seed),
    centralPeak: radius > 8000 && hash3(cand.id, 2, 0, seed) > 0.5,
    depthRatio: scale.maxDepthRatio * (0.6 + 0.4 * hash3(cand.id, 3, 0, seed)),
    rimHeightRatio: scale.rimHeightRatio * (0.6 + 0.4 * hash3(cand.id, 4, 0, seed)),
  };
}

/**
 * Per-chunk crater lookup with the generator's own `+-1 cell` window, memoised by cell.
 *
 * Why it exists: the naive transcription hashes 27 neighbouring cells for *each* of the three bands
 * at *every* vertex — 81 cell hashes per sample, ~26 microseconds per vertex, 28 ms for a 33x33
 * tile. That is acceptable for a dev-time tool that writes files once; it is not acceptable for
 * streaming terrain, because a Forge chunk is rebuilt whenever its LOD changes.
 *
 * A chunk is tiny compared with a crater cell (128-512 m against 5-500 km), so its vertices all
 * touch the same handful of cells. Caching "cell -> craters in it" per chunk removes the repeated
 * hashing while keeping the *sampled set* identical: the +-1 window test is still applied per vertex,
 * with the vertex's own cell triple, exactly as the generator does.
 *
 * The only difference from the transcription is the order the surviving terms are summed in, which
 * moves the result in the last bits of the mantissa (and is why `tools/mars-port-check.mjs` compares
 * with a tolerance rather than for bit equality).
 */
/**
 * Unique numeric key for a crater-grid cell (used as a Map key, so it must not collide and must stay
 * an exact integer).
 *
 * The generator's cell indices are |i| < 8192 for every band (the largest is a face of the planet
 * divided by the smallest 5 km cell: ~680), so three 14-bit digits pack into ~4e12, far below 2^53.
 */
function marsCellKey(ix: number, iy: number, iz: number): number {
  const OFFSET = 8192;
  const BASE = 16384;
  return ((ix + OFFSET) * BASE + (iy + OFFSET)) * BASE + (iz + OFFSET);
}

export class MarsCraterScanner {
  private readonly seed: number;
  private readonly cells = new Map<number, ResolvedCrater[] | null>();
  /** Per band: the vertex cell triple the candidate list was built for, and that list. */
  private readonly cachedTriple: number[] = [-1, -1, -1];
  private readonly cachedList: ResolvedCrater[][] = [[], [], []];

  constructor(seed: number) {
    this.seed = seed;
  }

  /** Craters in one cell of one band (negative results are cached too: most cells are empty). */
  private cellCraters(band: number, cix: number, ciy: number, ciz: number): ResolvedCrater[] {
    const key = marsCellKey(cix, ciy, ciz);
    const cached = this.cells.get(key);
    if (cached !== undefined) return cached ?? EMPTY_CRATERS;
    const scale = MARS_CRATER_SCALES[band]!;
    const resolved = resolveCrater(band, scale, this.seed, cix, ciy, ciz);
    const list = resolved ? [resolved] : null;
    this.cells.set(key, list);
    return list ?? EMPTY_CRATERS;
  }

  /**
   * Candidate craters for a vertex cell triple — the union of the generator's 3x3x3 cell window.
   * Built once per triple and remembered, because every vertex in a chunk (and usually the whole
   * chunk) shares one triple: a 128-512 m chunk sits inside a single 5 km crater cell.
   */
  private candidatesFor(band: number, vx: number, vy: number, vz: number): ResolvedCrater[] {
    const triple = marsCellKey(vx, vy, vz);
    if (this.cachedTriple[band] === triple) return this.cachedList[band]!;

    const out: ResolvedCrater[] = [];
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        for (let oz = -1; oz <= 1; oz++) {
          const craters = this.cellCraters(band, vx + ox, vy + oy, vz + oz);
          for (let i = 0; i < craters.length; i++) out.push(craters[i]!);
        }
      }
    }
    this.cachedTriple[band] = triple;
    this.cachedList[band] = out;
    return out;
  }

  /**
   * Summed crater relief at a planet-space point, in metres (negative inside a bowl). Same sampled
   * set as `marsSampleCraterDelta`: the +-1 cell window is applied with the vertex's own cell triple.
   */
  deltaAt(px: number, py: number, pz: number): { delta: number; inCrater: boolean; craterId: number } {
    let delta = 0;
    let inCrater = false;
    let craterId = 0;
    for (let band = 0; band < MARS_CRATER_SCALES.length; band++) {
      const cs = MARS_CRATER_SCALES[band]!.cellSizeMeters;
      const candidates = this.candidatesFor(band, Math.floor(px / cs), Math.floor(py / cs), Math.floor(pz / cs));
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i]!;
        const d = Math.hypot(px - c.cx, py - c.cy, pz - c.cz);
        const distNorm = d / c.radius;
        if (distNorm < 2.2) {
          delta += craterProfile(distNorm, c.depthRatio, c.rimHeightRatio, c.centralPeak, c.age) * c.radius;
          if (distNorm < 1) {
            inCrater = true;
            craterId = c.id;
          }
        }
      }
    }
    return { delta, inCrater, craterId };
  }

  /** Cached cell count (tests / diagnostics). */
  get cellCount(): number {
    return this.cells.size;
  }
}

const EMPTY_CRATERS: ResolvedCrater[] = [];

/**
 * Summed crater relief at a planet-space point, in metres (negative inside a bowl). This is the
 * direct transcription (81 cell hashes per sample); prefer `MarsCraterScanner` when sampling a whole
 * chunk, and match the generator bit-for-bit during verification.
 */
export function marsSampleCraterDelta(
  px: number,
  py: number,
  pz: number,
  seed: number,
): { delta: number; inCrater: boolean; craterId: number } {
  let delta = 0;
  let inCrater = false;
  let craterId = 0;
  for (const scale of MARS_CRATER_SCALES) {
    const cs = scale.cellSizeMeters;
    const cix = Math.floor(px / cs);
    const ciy = Math.floor(py / cs);
    const ciz = Math.floor(pz / cs);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        for (let oz = -1; oz <= 1; oz++) {
          const cand = cellCraterCandidate(cix + ox, ciy + oy, ciz + oz, cs, seed ^ (cs | 0));
          if (!cand) continue;
          const radius = scale.minRadius + hash3(cand.id, 0, 0, seed) * (scale.maxRadius - scale.minRadius);
          const d = Math.hypot(px - cand.cx, py - cand.cy, pz - cand.cz);
          const distNorm = d / radius;
          if (distNorm < 2.2) {
            const age = hash3(cand.id, 1, 0, seed);
            const centralPeak = radius > 8000 && hash3(cand.id, 2, 0, seed) > 0.5;
            const depthRatio = scale.maxDepthRatio * (0.6 + 0.4 * hash3(cand.id, 3, 0, seed));
            const rimHeightRatio = scale.rimHeightRatio * (0.6 + 0.4 * hash3(cand.id, 4, 0, seed));
            delta += craterProfile(distNorm, depthRatio, rimHeightRatio, centralPeak, age) * radius;
            if (distNorm < 1) {
              inCrater = true;
              craterId = cand.id;
            }
          }
        }
      }
    }
  }
  return { delta, inCrater, craterId };
}

// ------------------------------------------------------------------ volcanoes

export interface MarsVolcanoDef {
  /** Planet-space centre, in metres from the planet centre. */
  center: { x: number; y: number; z: number };
  baseRadius: number;
  height: number;
  calderaRadius: number;
  calderaDepth: number;
  seed: number;
}

/**
 * Broad shield-volcano profile (Olympus-Mons-style: enormous footprint, gentle flanks, summit
 * caldera). Positions and sizes are data — the generator places named volcanoes explicitly rather
 * than scattering them from a simulated mantle-plume field.
 */
export function marsSampleVolcanoDelta(
  px: number,
  py: number,
  pz: number,
  volcanoes: readonly MarsVolcanoDef[],
): number {
  let delta = 0;
  for (const v of volcanoes) {
    const d = Math.hypot(px - v.center.x, py - v.center.y, pz - v.center.z);
    if (d > v.baseRadius * 1.3) continue;
    const t = d / v.baseRadius;
    let h = v.height * Math.pow(Math.max(0, 1 - t), 1.6);
    const calderaT = d / v.calderaRadius;
    if (calderaT < 1) h -= v.calderaDepth * (1 - calderaT * calderaT);
    const flow = marsFbm3(px * 0.00005, py * 0.00005, pz * 0.00005, {
      octaves: 4,
      lacunarity: 2.1,
      gain: 0.5,
      frequency: 1,
      seed: v.seed + 500,
    });
    h += flow * v.height * 0.02 * Math.max(0, 1 - t); // lava-flow-lobe roughness on the flanks
    delta += h;
  }
  return delta;
}

/** Sparse small cinder cones, as cheap grid-cell bumps (a decorative feature upstream, too). */
export function marsSampleCinderCones(px: number, py: number, pz: number, seed: number): number {
  const cell = 8000;
  const cix = Math.floor(px / cell);
  const ciy = Math.floor(py / cell);
  const ciz = Math.floor(pz / cell);
  let delta = 0;
  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      for (let oz = -1; oz <= 1; oz++) {
        const gx = cix + ox;
        const gy = ciy + oy;
        const gz = ciz + oz;
        const h0 = ((((gx * 928371 + gy * 68917 + gz * 127931 + seed * 7) >>> 0) % 1000) / 1000);
        if (h0 > 0.985) {
          const cx = (gx + 0.5) * cell;
          const cy = (gy + 0.5) * cell;
          const cz = (gz + 0.5) * cell;
          const r = 300 + h0 * 900;
          const height = 60 + h0 * 180;
          const d = Math.hypot(px - cx, py - cy, pz - cz);
          if (d < r) delta += height * Math.pow(1 - d / r, 2);
        }
      }
    }
  }
  return delta;
}

// ------------------------------------------------------------------ dichotomy, canyon, regional base

export interface MarsDichotomyConfig {
  seed: number;
  /** Unit vector: the "highland pole" of the north/south dichotomy boundary. */
  axis: { x: number; y: number; z: number };
  /** -1..1, shifts the boundary great-circle off the axis's equator. */
  boundaryOffset: number;
  /** Metres of relief between lowlands and highlands. */
  amplitude: number;
  waviness: number;
}

/** A rift/canyon segment (Valles-Marineris-style). */
export interface MarsCanyonSegment {
  a: { x: number; y: number; z: number };
  b: { x: number; y: number; z: number };
  width: number;
  depth: number;
}

function sampleCanyonSegment(
  px: number,
  py: number,
  pz: number,
  seg: MarsCanyonSegment,
  seed: number,
): number {
  const abx = seg.b.x - seg.a.x;
  const aby = seg.b.y - seg.a.y;
  const abz = seg.b.z - seg.a.z;
  const len2 = abx * abx + aby * aby + abz * abz || 1;
  let t = ((px - seg.a.x) * abx + (py - seg.a.y) * aby + (pz - seg.a.z) * abz) / len2;
  t = Math.max(0, Math.min(1, t));
  const closestX = seg.a.x + abx * t;
  const closestY = seg.a.y + aby * t;
  const closestZ = seg.a.z + abz * t;
  const d = Math.hypot(px - closestX, py - closestY, pz - closestZ);
  const widthNoise =
    1 +
    marsFbm3(px * 0.00004, py * 0.00004, pz * 0.00004, {
      octaves: 3,
      lacunarity: 2,
      gain: 0.5,
      frequency: 1,
      seed: seed + 9,
    }) *
      0.4;
  const w = seg.width * widthNoise;
  if (d > w) return 0;
  const dn = d / w;
  let depth = -seg.depth * (1 - Math.pow(dn, 2.2)); // steep-walled canyon cross-section
  depth += Math.sin(dn * Math.PI * 3) * seg.depth * 0.03 * (1 - dn); // subtle terrace shelves
  const endFade = Math.min(1, Math.min(t, 1 - t) * 8); // fade out at the ends of the rift axis
  return depth * endFade;
}

/**
 * Broadest-scale relief: the crustal dichotomy modelled as a warped great-circle boundary (smooth
 * young northern lowlands vs. ancient cratered southern highlands), plus very low-frequency
 * regional fbm, plus any canyon segments. `dir` must be a unit direction.
 *
 * The generator's signature also takes `radius`; it never reads it, so it is dropped here rather
 * than suppressed (`noUnusedParameters`).
 */
export function marsSampleRegionalBase(
  dirX: number,
  dirY: number,
  dirZ: number,
  cfg: MarsDichotomyConfig,
  canyon: readonly MarsCanyonSegment[],
): number {
  const len = Math.hypot(dirX, dirY, dirZ) || 1;
  const dx = dirX / len;
  const dy = dirY / len;
  const dz = dirZ / len;

  const [wx, wy, wz] = marsDomainWarp3(dx * 4, dy * 4, dz * 4, cfg.seed, 0.25, 0.5);
  const wander =
    marsFbm3(wx, wy, wz, { octaves: 4, lacunarity: 2, gain: 0.5, frequency: 0.6, seed: cfg.seed + 1 }) *
    cfg.waviness;
  const latitudeLike = dx * cfg.axis.x + dy * cfg.axis.y + dz * cfg.axis.z - cfg.boundaryOffset + wander;
  let base = Math.tanh(latitudeLike * 3) * cfg.amplitude * 0.5;

  base +=
    marsFbm3(dx * 6, dy * 6, dz * 6, {
      octaves: 5,
      lacunarity: 2.0,
      gain: 0.5,
      frequency: 1,
      seed: cfg.seed + 2,
    }) *
    cfg.amplitude *
    0.2;

  const px = dx;
  const py = dy;
  const pz = dz;
  for (const seg of canyon) base += sampleCanyonSegment(px, py, pz, seg, cfg.seed);
  return base;
}

// ------------------------------------------------------------------ analytic base

export interface MarsAnalyticSample {
  /** Metres above the planet's reference sphere, before simulated erosion and fine detail. */
  elevation: number;
  material: MarsMaterial;
  /** 0..1 rock hardness, driving the fine-detail amplitude. */
  hardness: number;
}

/**
 * Everything that can be computed directly from a point on the sphere, with no grid context:
 * dichotomy + craters + volcanoes + cinder cones + regional fbm, plus material/hardness
 * classification. This is the function the generator caches as `baseElevation` per face, so the
 * port evaluating it at chunk resolution reproduces Stage A's base exactly (see the port check).
 */
export function marsSampleAnalytic(
  dirX: number,
  dirY: number,
  dirZ: number,
  params: MarsGenParamsLike,
  craterScanner?: MarsCraterScanner,
): MarsAnalyticSample {
  const radius = params.radius;
  const px = dirX * radius;
  const py = dirY * radius;
  const pz = dirZ * radius;

  const regional = marsSampleRegionalBase(dirX, dirY, dirZ, params.dichotomy, params.canyon);
  const craters = craterScanner
    ? craterScanner.deltaAt(px, py, pz)
    : marsSampleCraterDelta(px, py, pz, params.seed);
  const volcano = marsSampleVolcanoDelta(px, py, pz, params.volcanoes);
  const cones = marsSampleCinderCones(px, py, pz, params.seed + 3);

  const elevation = regional + craters.delta + volcano + cones;

  let material: MarsMaterial;
  if (craters.inCrater) {
    material = MarsMaterial.CraterFloor;
  } else if (volcano > 200) {
    material = MarsMaterial.VolcanicFlank;
  } else if (regional < -1500) {
    material = MarsMaterial.LayeredSediment; // canyon floors / deep basins
  } else {
    const patch = marsFbm3(px * 0.00003, py * 0.00003, pz * 0.00003, {
      octaves: 3,
      lacunarity: 2,
      gain: 0.5,
      frequency: 1,
      seed: params.seed + 77,
    });
    material = patch > 0.3 ? MarsMaterial.Regolith : MarsMaterial.ExposedBedrock;
  }

  return { elevation, material, hardness: MARS_MATERIAL_HARDNESS[material] };
}

// ------------------------------------------------------------------ Stage B detail band

/**
 * Meso/micro/very-fine detail layered on top of the interpolated simulated-erosion field.
 * Amplitude and character are modulated by geology, not applied uniformly: softer rock gets taller,
 * smoother gully-like ridges, harder rock gets shorter but sharper exposed-rock texture, and high
 * flow accumulation (channelised terrain) boosts the small-scale texture further.
 *
 * Spatial bands, in real metres: meso ~1/1000 (≈6 km features), micro ridged ~1/50 (≈100 m
 * features), very fine ~0.6 (≈1.7 m features). A Forge chunk whose vertex spacing is much coarser
 * than ~10 m samples the first band and aliases the other two — that is what `adviseMarsTile`
 * reports.
 */
export function marsFineDetail(
  dirX: number,
  dirY: number,
  dirZ: number,
  radius: number,
  hardness: number,
  flowAccum: number,
  seed: number,
): number {
  const px = dirX * radius;
  const py = dirY * radius;
  const pz = dirZ * radius;
  const meso = marsFbm3(px * 0.001, py * 0.001, pz * 0.001, {
    octaves: 5,
    lacunarity: 2.0,
    gain: 0.5,
    frequency: 1,
    seed: seed + 201,
  });
  const micro = marsRidged3(px * 0.02, py * 0.02, pz * 0.02, {
    octaves: 4,
    lacunarity: 2.2,
    gain: 0.5,
    frequency: 1,
    seed: seed + 301,
  });
  const veryFine = marsFbm3(px * 0.6, py * 0.6, pz * 0.6, {
    octaves: 3,
    lacunarity: 2.3,
    gain: 0.5,
    frequency: 1,
    seed: seed + 401,
  });

  const softAmp = 4 + (1 - hardness) * 10;
  const microAmp = 0.6 + hardness * 2.2;
  const channelBoost = 1 + Math.min(2, flowAccum * 0.001);

  return meso * softAmp + (micro - 0.5) * 2 * microAmp * channelBoost + veryFine * 0.35;
}

/**
 * Structural subset of the generator's `WorldGenParams` this module needs. Structural rather than
 * imported from `config.ts` so the geology stays usable without the Mars defaults.
 */
export interface MarsGenParamsLike {
  seed: number;
  radius: number;
  dichotomy: MarsDichotomyConfig;
  canyon: readonly MarsCanyonSegment[];
  volcanoes: readonly MarsVolcanoDef[];
}
