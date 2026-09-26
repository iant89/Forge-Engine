/**
 * `MarsTerrainStage` — the dev-time Mars generator's Stage B, as a Forge `TerrainStage`.
 *
 * Why a stage and not a chunk loader: the generator's chunk files are baked at one fixed quadtree
 * depth and resolution, in curved planet-space quads with no skirts, normals, UVs or indices, and
 * their size is only definable as "1/2^depth of a cube face" (a 299.7 km face-centre edge at the
 * default depth 4, 244-401 km across a face because the spherified cube shears side lengths). Forge's
 * streaming, LOD geomorphing, `Heightmap` collision and vehicle raycasts all assume square,
 * uniformly sized, planar tiles on an integer `(chunkSize, chunkCoord)` lattice.
 *
 * A stage bridges the two exactly: every vertex is evaluated from its *absolute direction on the
 * sphere*, so the terrain is identical no matter what `chunkSize`/`chunkResolution` the scene picks,
 * neighbouring chunks and LODs agree along their shared edges by construction, and Forge keeps its
 * own skirts, geomorph lattice and bicubic `Heightmap`. The simulated erosion that cannot be
 * re-derived point-wise comes from the generator's Stage A cache (`globalFields.ts`), which is ~30 MB
 * for the whole planet instead of terabytes of chunks.
 *
 * Sizing: use `adviseMarsTile(chunkSize, chunkResolution)`. The short version is that the detail band
 * wants a vertex spacing of ~4 m or finer (256 m / 65, or 128 m / 33), both of which the engine's LOD
 * ladder (`resolutionForLod`) supports. A 300 km chunk with a 65-vertex grid - the generator's
 * default output - is *not* usable as a Forge tile: it would make the detail band unreconstructible
 * noise and put tens of metres of error between adjacent LODs with an 8 m skirt.
 */

import { clamp } from "../../math/scalar.js";
import { GeneratorPipeline, type TerrainStage, type WorldCell } from "../generators.js";
import type { TerrainSurfaceLayer } from "../material.js";
import { Color } from "../../math/color.js";
import { UsageError } from "../../core/errors.js";
import {
  marsDepthForChunkEdge,
  marsLatLonOfDirection,
  marsLatLonToDirection,
  marsNormalize,
} from "./cubeSphere.js";
import { MARS_GEN_PARAMS, MARS_RADIUS_M, type MarsGenParams, type MarsGenParamsOverrides, createMarsGenParams } from "./config.js";
import {
  MARS_MATERIAL_HARDNESS,
  MarsCraterScanner,
  MarsMaterial,
  marsFineDetail,
  marsSampleAnalytic,
} from "./geology.js";
import { MarsGlobalFieldSet, type MarsGlobalSample } from "./globalFields.js";

/**
 * A local tangent frame on the Mars sphere, anchored at a latitude/longitude.
 *
 * Local `+X` is east, local `+Z` is north (before `headingDeg`), local `+Y` is `up` — the same
 * orientation as Forge's world grid, so a chunk at world `(x, z)` is the patch of Mars `x` metres
 * east and `z` metres north of the site. `MarsSite` also does the sphere bookkeeping the terrain
 * stage needs: exact arc mapping (not a small-angle approximation) and the height a point loses
 * because it sits on a curved surface rather than a plane.
 */
export class MarsSite {
  readonly latDeg: number;
  readonly lonDeg: number;
  readonly headingDeg: number;
  readonly radius: number;
  /** Unit direction of the site (planet-fixed frame). */
  readonly up: { x: number; y: number; z: number };
  /** Unit east/north axes of the (heading-rotated) local frame. */
  readonly east: { x: number; y: number; z: number };
  readonly north: { x: number; y: number; z: number };

  constructor(options: MarsSiteOptions) {
    this.latDeg = options.latDeg;
    this.lonDeg = options.lonDeg;
    this.headingDeg = options.headingDeg ?? 0;
    this.radius = options.radiusM ?? MARS_RADIUS_M;

    const up = marsNormalize(marsLatLonToDirection(this.latDeg, this.lonDeg));
    const pole = { x: 0, y: 1, z: 0 };
    // Project the pole into the tangent plane; at a pole itself the projection vanishes and any
    // reference meridian will do (the frame is then defined by the heading alone).
    const dotPole = up.x * pole.x + up.y * pole.y + up.z * pole.z;
    let north = marsNormalize({
      x: pole.x - up.x * dotPole,
      y: pole.y - up.y * dotPole,
      z: pole.z - up.z * dotPole,
    });
    if (!Number.isFinite(north.x) || Math.hypot(north.x, north.y, north.z) < 1e-6) {
      const fallback = { x: 0, y: 0, z: 1 };
      const d = up.x * fallback.x + up.y * fallback.y + up.z * fallback.z;
      north = marsNormalize({
        x: fallback.x - up.x * d,
        y: fallback.y - up.y * d,
        z: fallback.z - up.z * d,
      });
    }
    let east = marsNormalize({
      x: up.y * north.z - up.z * north.y,
      y: up.z * north.x - up.x * north.z,
      z: up.x * north.y - up.y * north.x,
    });

    const heading = (this.headingDeg * Math.PI) / 180;
    if (heading !== 0) {
      const cos = Math.cos(heading);
      const sin = Math.sin(heading);
      const rotatedEast = {
        x: east.x * cos + north.x * sin,
        y: east.y * cos + north.y * sin,
        z: east.z * cos + north.z * sin,
      };
      const rotatedNorth = {
        x: north.x * cos - east.x * sin,
        y: north.y * cos - east.y * sin,
        z: north.z * cos - east.z * sin,
      };
      east = rotatedEast;
      north = rotatedNorth;
    }

    this.up = up;
    this.east = east;
    this.north = north;
  }

  /** Arc length in metres from the site to a local (x, z) offset. */
  arcMeters(localX: number, localZ: number): number {
    return Math.hypot(localX, localZ);
  }

  /**
   * Direction on the sphere for a local (x, z) offset — exact spherical mapping: walk `d / R`
   * radians along the great circle from the site towards the tangent direction.
   */
  directionFor(localX: number, localZ: number, out?: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
    const d = Math.hypot(localX, localZ);
    const target = out ?? { x: 0, y: 0, z: 0 };
    if (d < 1e-9) {
      target.x = this.up.x;
      target.y = this.up.y;
      target.z = this.up.z;
      return target;
    }
    const arc = d / this.radius;
    const tanX = (this.east.x * localX + this.north.x * localZ) / d;
    const tanY = (this.east.y * localX + this.north.y * localZ) / d;
    const tanZ = (this.east.z * localX + this.north.z * localZ) / d;
    const cos = Math.cos(arc);
    const sin = Math.sin(arc);
    const dir = marsNormalize({
      x: this.up.x * cos + tanX * sin,
      y: this.up.y * cos + tanY * sin,
      z: this.up.z * cos + tanZ * sin,
    });
    target.x = dir.x;
    target.y = dir.y;
    target.z = dir.z;
    return target;
  }

  /**
   * Height above the local tangent plane for a point `elevation` metres above the reference sphere
   * at local offset (x, z).
   *
   * The terrain grid Forge builds is planar, so the curved surface has to be expressed as a height
   * field over it. A point on the sphere at arc `a` from the site is `R * (1 - cos a)` metres below
   * the tangent plane; at 1 km that is 0.15 m, at 20 km it is 59 m. `compensate: false` returns the
   * raw sphere elevation instead (bit-identical to the generator's `heights`), which is what a tool
   * comparing against the generator's output wants.
   */
  planeHeight(elevation: number, localX: number, localZ: number, compensate: boolean): number {
    if (!compensate) return elevation;
    const d = Math.hypot(localX, localZ);
    const arc = d / this.radius;
    return (this.radius + elevation) * Math.cos(arc) - this.radius;
  }

  /** Latitude/longitude of a local offset (for HUDs, tools and camera placement). */
  latLonFor(localX: number, localZ: number): { latDeg: number; lonDeg: number } {
    const dir = this.directionFor(localX, localZ);
    return marsLatLonOfDirection(dir);
  }
}

export interface MarsSiteOptions {
  latDeg: number;
  lonDeg: number;
  /** Rotation of the local frame about `up`, degrees. 0 puts the planet's north along local `+Z`. */
  headingDeg?: number;
  /** Planet radius to use for the tangent frame (defaults to Mars). */
  radiusM?: number;
}

/** A place on the port's Mars, used by scenes/tools to open somewhere interesting. */
export interface MarsSitePreset extends MarsSiteOptions {
  name: string;
  description: string;
}

function siteOfDirection(
  name: string,
  description: string,
  dir: { x: number; y: number; z: number },
  headingDeg = 0,
): MarsSitePreset {
  const { latDeg, lonDeg } = marsLatLonOfDirection(dir);
  return { name, description, latDeg, lonDeg, headingDeg };
}

function volcanoDirection(index: number): { x: number; y: number; z: number } {
  const volcano = MARS_GEN_PARAMS.volcanoes[index];
  if (!volcano) throw new UsageError(`createMarsGenParams: no volcano at index ${index}`);
  return marsNormalize(volcano.center);
}

function canyonMidDirection(index: number): { x: number; y: number; z: number } {
  const segment = MARS_GEN_PARAMS.canyon[index];
  if (!segment) throw new UsageError(`createMarsGenParams: no canyon segment at index ${index}`);
  return marsNormalize({
    x: (segment.a.x + segment.b.x) * 0.5,
    y: (segment.a.y + segment.b.y) * 0.5,
    z: (segment.a.z + segment.b.z) * 0.5,
  });
}

/**
 * Named sites derived from the default world (so they follow the config if it changes): the summit
 * of the config's Olympus-Mons-like shield, and the middle of its Valles-Marineris-like rift.
 */
export const MARS_SITE_PRESETS: Record<string, MarsSitePreset> = {
  olympusMons: siteOfDirection(
    "olympusMons",
    "Summit region of the config's Olympus-Mons-like shield volcano (~21 km high, 300 km base radius).",
    volcanoDirection(0),
  ),
  vallesRift: siteOfDirection(
    "vallesRift",
    "Middle of the config's Valles-Marineris-like rift canyon (6 km deep, 100 km wide).",
    canyonMidDirection(0),
  ),
};

export interface MarsTerrainStageOptions {
  /**
   * Full world parameters. Defaults to the generator's `marsConfig` values (`MARS_GEN_PARAMS`), which
   * is what the Stage A cache was simulated with — see `createMarsGenParams` for the caveat.
   */
  params?: MarsGenParams;
  /** Convenience: build params from the defaults with overrides, instead of passing `params`. */
  paramsOverrides?: MarsGenParamsOverrides;
  /** Where the planar patch sits on the planet. Default: the Olympus-Mons-like summit. */
  site?: MarsSiteOptions | MarsSitePreset;
  /** Stage A fields; without them the terrain is analytic only (no simulated erosion). */
  globalFields?: MarsGlobalFieldSet | null;
  /** Include the Stage B fine-detail bands (default true). */
  detail?: boolean;
  /**
   * Subtract the sphere's curvature so the patch is a true tangent-plane height field (default true).
   * Turn off to compare against the generator's raw `heights`.
   */
  curvatureCompensation?: boolean;
}

/**
 * Fills a `WorldCell` with Mars terrain: analytic base + sampled Stage A erosion correction + the
 * fine-detail band, then the slope/splat channels the rest of the engine expects.
 *
 * This stage writes `heights`, `slopes` and `biomes` itself, so it replaces the engine's
 * height/biome stages rather than following them. It leaves `scatters` empty (the generator has no
 * scatter pass; add `ScatterGenerator` after it if you want rocks).
 */
export class MarsTerrainStage implements TerrainStage {
  /** Stage kind used by `pipelineSpec` (kept scalar-only for the cache-key identity). */
  readonly name = "mars";

  readonly params: MarsGenParams;
  readonly site: MarsSite;
  readonly globalFields: MarsGlobalFieldSet | null;
  readonly detail: boolean;
  readonly curvatureCompensation: boolean;

  private readonly scratchSample: MarsGlobalSample = {
    erosionDelta: 0,
    hardness: 0.5,
    material: MarsMaterial.Regolith,
    flowAccum: 0,
  };

  constructor(options: MarsTerrainStageOptions = {}) {
    if (options.params && options.paramsOverrides) {
      throw new UsageError("MarsTerrainStage: pass either `params` or `paramsOverrides`, not both");
    }
    this.params = options.params ?? createMarsGenParams(options.paramsOverrides ?? {});
    const site = options.site ?? MARS_SITE_PRESETS.olympusMons!;
    this.site = new MarsSite({ radiusM: this.params.radius, ...site });
    this.globalFields = options.globalFields ?? null;
    this.detail = options.detail ?? true;
    this.curvatureCompensation = options.curvatureCompensation ?? true;
  }

  // ---- identity fields read by the pipeline spec (kept scalar so a spec stays comparable) ----

  get seed(): number {
    return this.params.seed;
  }

  get radius(): number {
    return this.params.radius;
  }

  get siteLatDeg(): number {
    return this.site.latDeg;
  }

  get siteLonDeg(): number {
    return this.site.lonDeg;
  }

  get siteHeadingDeg(): number {
    return this.site.headingDeg;
  }

  /**
   * Every input that changes what this stage produces, as a canonical string. This is the stage's
   * cache-key component (`hashPipelineSpec` hashes the spec, which carries this), so two scenes that
   * differ only in, say, the dichotomy amplitude must not collide.
   */
  get identity(): string {
    return JSON.stringify({
      seed: this.params.seed,
      radius: this.params.radius,
      dichotomy: this.params.dichotomy,
      canyon: this.params.canyon,
      volcanoes: this.params.volcanoes,
      site: { latDeg: this.site.latDeg, lonDeg: this.site.lonDeg, headingDeg: this.site.headingDeg },
      detail: this.detail,
      curvatureCompensation: this.curvatureCompensation,
      globalFields: this.globalFields ? this.globalFields.availableFaces : null,
    });
  }

  /** True when the Stage A erosion correction is available for every face the patch touches. */
  get hasErosionCorrection(): boolean {
    return !!this.globalFields && this.globalFields.availableFaces.length > 0;
  }

  process(cell: WorldCell): void {
    const res = cell.resolution;
    const size = cell.size;
    const step = size / (res - 1);
    const originX = cell.cx * size;
    const originZ = cell.cz * size;
    const fields = this.globalFields;
    const dir = { x: 0, y: 0, z: 0 };
    const materialIds = new Uint8Array(res * res);
    // One scan per chunk: its vertices share a handful of crater cells, so the cell hashes are done
    // once instead of per vertex (see `MarsCraterScanner`). A scan is not reused across chunks, so
    // the memo stays bounded by the chunk's own footprint.
    const craters = new MarsCraterScanner(this.params.seed);

    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const wx = originX + i * step;
        const wz = originZ + j * step;
        const idx = j * res + i;

        this.site.directionFor(wx, wz, dir);
        const analytic = marsSampleAnalytic(dir.x, dir.y, dir.z, this.params, craters);
        const global = fields ? fields.sample(dir.x, dir.y, dir.z, this.scratchSample) : this.scratchSample;
        const detail = this.detail
          ? marsFineDetail(dir.x, dir.y, dir.z, this.params.radius, analytic.hardness, global.flowAccum, this.params.seed)
          : 0;

        const elevation = analytic.elevation + global.erosionDelta + detail;
        cell.heights[idx] = this.site.planeHeight(elevation, wx, wz, this.curvatureCompensation);
        materialIds[idx] = analytic.material;
      }
    }

    this.writeSlopes(cell);
    this.writeSplats(cell, materialIds);
  }

  /** Central-difference slope in radians and contact-normal grid, matching the engine's own stages. */
  private writeSlopes(cell: WorldCell): void {
    const res = cell.resolution;
    const step = cell.size / (res - 1);
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const idx = j * res + i;
        const iL = Math.max(0, i - 1);
        const iR = Math.min(res - 1, i + 1);
        const jD = Math.max(0, j - 1);
        const jU = Math.min(res - 1, j + 1);
        const dx = (cell.heights[j * res + iR]! - cell.heights[j * res + iL]!) / ((iR - iL) * step);
        const dz = (cell.heights[jU * res + i]! - cell.heights[jD * res + i]!) / ((jU - jD) * step);
        cell.slopes[idx] = Math.atan(Math.hypot(dx, dz));
      }
    }
  }

  /**
   * Four splat weights per vertex, in the channel order `marsSurfaceLayers()` describes:
   * 0 = dust, 1 = rock, 2 = sand, 3 = crust.
   *
   * The generator's material id drives the base weight; slope biases it towards rock (a
   * `CraterFloor` on a 40-degree wall should read as rock, not bowl). The engine's own
   * `BiomeGenerator` writes this same 4-channel layout, so the terrain material stack, the demo's
   * layer presets and any future splat shader keep working unchanged.
   */
  private writeSplats(cell: WorldCell, materialIds: Uint8Array): void {
    const res = cell.resolution;
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const idx = j * res + i;
        const material = materialIds[idx]! as MarsMaterial;
        let dust = 0;
        let rock = 0;
        let sand = 0;
        let crust = 0;

        switch (material) {
          case MarsMaterial.Regolith:
          case MarsMaterial.BasaltLowland:
            dust = 1;
            break;
          case MarsMaterial.ExposedBedrock:
          case MarsMaterial.VolcanicFlank:
            rock = 1;
            break;
          case MarsMaterial.DuneField:
          case MarsMaterial.ChannelFloor:
            sand = 1;
            break;
          case MarsMaterial.CraterFloor:
          case MarsMaterial.CraterEjecta:
          case MarsMaterial.LayeredSediment:
          case MarsMaterial.PolarIce:
            crust = 1;
            break;
          default:
            dust = 1;
            break;
        }

        // Steep ground is rock regardless of what the material classifier decided.
        const slope = cell.slopes[idx]!;
        const rockBias = clamp((slope - 0.45) / 0.4, 0, 1);
        if (rockBias > 0) {
          rock = Math.max(rock, rockBias);
          dust *= 1 - rockBias;
          sand *= 1 - rockBias;
          crust *= 1 - rockBias;
        }

        const sum = dust + rock + sand + crust;
        const inv = sum > 0 ? 1 / sum : 1;
        const bIdx = idx * 4;
        cell.biomes[bIdx] = dust * inv;
        cell.biomes[bIdx + 1] = rock * inv;
        cell.biomes[bIdx + 2] = sand * inv;
        cell.biomes[bIdx + 3] = crust * inv;
      }
    }
  }

  /** Sample the assembled surface (analytic + correction + detail) at one world position. */
  sampleElevation(worldX: number, worldZ: number): number {
    const dir = this.site.directionFor(worldX, worldZ);
    const analytic = marsSampleAnalytic(dir.x, dir.y, dir.z, this.params);
    const global = this.globalFields
      ? this.globalFields.sample(dir.x, dir.y, dir.z)
      : { erosionDelta: 0, hardness: MARS_MATERIAL_HARDNESS[analytic.material], material: analytic.material, flowAccum: 0 };
    const detail = this.detail
      ? marsFineDetail(dir.x, dir.y, dir.z, this.params.radius, analytic.hardness, global.flowAccum, this.params.seed)
      : 0;
    return this.site.planeHeight(analytic.elevation + global.erosionDelta + detail, worldX, worldZ, this.curvatureCompensation);
  }
}

/** A pipeline containing just the Mars stage (add scatter/erosion stages after it if you want them). */
export function createMarsPipeline(options: MarsTerrainStageOptions = {}): GeneratorPipeline {
  return new GeneratorPipeline().addStage(new MarsTerrainStage(options));
}

// ------------------------------------------------------------------ sizing advice

export type MarsTileDetailLevel = "full" | "micro" | "meso" | "silhouette";

export interface MarsTileAdvice {
  chunkSize: number;
  chunkResolution: number;
  /** Metres between adjacent vertices — the number that decides which detail bands survive. */
  vertexSpacing: number;
  /** What the chosen spacing can actually reconstruct. */
  detailLevel: MarsTileDetailLevel;
  /** True when the resolution is on the engine's geomorphing LOD ladder (2^k + 1). */
  lodLadderCompatible: boolean;
  /** The generator's quadtree depth whose face-centre chunk is closest to `chunkSize` (informational). */
  nearestGeneratorDepth: number;
  /** Metres of skirt the LOD ladder needs at this chunk size (the engine default is 8 m). */
  recommendedSkirtDepth: number;
  ok: boolean;
  notes: string[];
}

/**
 * Whether a chunk size / resolution pair can carry the Mars detail band, and what to fix if not.
 *
 * Bands, in real metres (see `marsFineDetail`): meso ~6 km, micro ridged ~100 m, very fine ~1.7 m.
 *
 *  - spacing <= 2.3 m: `full` — micro resolves cleanly, the very-fine band contributes texture.
 *  - spacing <= 4.6 m: `micro` — the intended target: micro resolves, very fine dithers.
 *  - spacing <= 9.2 m: `meso` — only kilometre-scale shapes are real; the rest is aliasing.
 *  - above that: `silhouette` — the chunk is a generator-sized chunk (hundreds of metres to
 *    hundreds of kilometres) and none of the detail band is reconstructible.
 */
export function adviseMarsTile(chunkSize: number, chunkResolution: number, radius: number = MARS_RADIUS_M): MarsTileAdvice {
  if (!(chunkSize > 0)) throw new UsageError(`adviseMarsTile: chunkSize must be > 0 (got ${chunkSize})`);
  if (!(chunkResolution >= 3)) throw new UsageError(`adviseMarsTile: chunkResolution must be >= 3 (got ${chunkResolution})`);

  const vertexSpacing = chunkSize / (chunkResolution - 1);
  let detailLevel: MarsTileDetailLevel;
  if (vertexSpacing <= 2.3) detailLevel = "full";
  else if (vertexSpacing <= 4.6) detailLevel = "micro";
  else if (vertexSpacing <= 9.2) detailLevel = "meso";
  else detailLevel = "silhouette";

  // The geomorph lattice only lines up when (resolution - 1) is a power of two (33 -> 17 -> 9 -> 5 -> 3).
  const ladderSteps = chunkResolution - 1;
  const lodLadderCompatible = ladderSteps >= 2 && (ladderSteps & (ladderSteps - 1)) === 0;
  const nearestGeneratorDepth = marsDepthForChunkEdge(chunkSize, radius);
  // The coarsest resident LOD samples every (chunkResolution-1)/2 metres; a skirt has to be deeper
  // than the LOD-to-LOD height error to hide the seam, and a quarter of the chunk is a cheap proxy
  // that scales with the terrain the chunk covers. The engine's 8 m default is right for 128-256 m
  // tiles in gentle terrain and too shallow in mountainous terrain at the LOD band edges.
  const recommendedSkirtDepth = Math.round(clamp(chunkSize * 0.25, 8, 128));

  const notes: string[] = [];
  if (!lodLadderCompatible) {
    notes.push(
      `resolution ${chunkResolution} is off the geomorph LOD ladder: use 3, 5, 9, 17, 33, 65 or 129 so coarser LODs land on finer vertices (resolutionForLod).`,
    );
  }
  if (detailLevel === "full" || detailLevel === "micro") {
    notes.push(`${vertexSpacing.toFixed(2)} m spacing carries the micro relief band (~100 m features).`);
  } else if (detailLevel === "meso") {
    notes.push(
      `${vertexSpacing.toFixed(1)} m spacing loses the micro band (~100 m features): the surface reads smooth with aliased speckle. Prefer 256 m / 65 or 128 m / 33.`,
    );
  } else {
    notes.push(
      `${vertexSpacing.toFixed(1)} m spacing is a generator-scale chunk (${chunkSize} m is the generator's depth-${nearestGeneratorDepth} face-centre size): it renders the planet's large shapes only. Forge tiles want 64-512 m with 33-129 vertices.`,
    );
  }
  if (chunkSize > 4096) {
    notes.push(
      "chunks this large also break LOD/streaming assumptions (LOD bands start at 1.5x chunkSize) and float32 world precision; raise viewDistance in smaller chunks instead.",
    );
  }

  return {
    chunkSize,
    chunkResolution,
    vertexSpacing,
    detailLevel,
    lodLadderCompatible,
    nearestGeneratorDepth,
    recommendedSkirtDepth,
    ok: detailLevel === "full" || detailLevel === "micro",
    notes,
  };
}

/**
 * Mars surface layers for `LayeredTerrainMaterial`, in the splat channel order this stage writes:
 * 0 dust, 1 rock, 2 sand, 3 crust. Colours are approximate Mars regolith/albedo values; tweak per
 * scene (the point is the channel mapping, which is what the stage guarantees).
 */
export function marsSurfaceLayers(): TerrainSurfaceLayer[] {
  return [
    {
      name: "dust",
      color: new Color(0.58, 0.35, 0.22, 1),
      roughness: 0.95,
      metallic: 0.0,
      slopeRange: [0, 0.7],
      macroVariation: 0.1,
      microDetail: 0.05,
      biomeChannel: 0,
    },
    {
      name: "rock",
      color: new Color(0.36, 0.26, 0.2, 1),
      roughness: 0.88,
      metallic: 0.02,
      slopeRange: [0.4, 1.5],
      macroVariation: 0.07,
      microDetail: 0.12,
      biomeChannel: 1,
    },
    {
      name: "sand",
      color: new Color(0.72, 0.5, 0.32, 1),
      roughness: 0.9,
      metallic: 0.0,
      slopeRange: [0, 0.35],
      macroVariation: 0.09,
      microDetail: 0.04,
      biomeChannel: 2,
    },
    {
      name: "crust",
      color: new Color(0.5, 0.38, 0.3, 1),
      roughness: 0.92,
      metallic: 0.01,
      slopeRange: [0, 1.2],
      macroVariation: 0.08,
      microDetail: 0.08,
      biomeChannel: 3,
    },
  ];
}
