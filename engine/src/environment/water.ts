/**
 * Water (Phase 8b): Gerstner waves, whitecap foam, and the underwater path.
 *
 * The surface is a sum of Gerstner waves (GPU Gems, "Effective Water Simulation from Physical
 * Models"): each wave displaces the surface vertically by `A·sin(f)` and horizontally along its
 * travel direction by `Q·A·cos(f)`, which sharpens crests and flattens troughs the way real
 * swells do. The CPU sampler here and the water vertex shader evaluate the *same* sum from the
 * *same* uniforms (`scene.settings.water.waves`), so gameplay queries (buoyancy, foam, depth
 * soundings) agree with the rendered surface to float32 precision.
 *
 * `WaterSurface` is the `SceneObject` that owns the water entity and advances `water.time` on the
 * fixed-step clock (the host assigns the mesh + material; see `waterGridSource`). Rendering
 * itself is data-driven: the renderer reads `scene.settings.water`
 * (level, colours, waves, time) and draws any `Renderable` whose material uses the `water`
 * technique with the water program. The underwater path is also in the renderer: when the camera
 * drops below the mean level the sky pass is skipped and the fog is replaced by the murk.
 */

import { SceneObject, type Scene } from "../scene/scene.js";
import type { SystemContext } from "../scene/systems.js";
import { Renderable } from "../scene/components/index.js";
import { Vec3 } from "../math/vec.js";
import { clamp } from "../math/scalar.js";
import type { SceneWaterSettings } from "../scene/scene.js";

/** One Gerstner component (mirrors `WaterWaveParams` in the scene settings). */
export interface GerstnerWave {
  /** Travel direction (will be normalised). */
  directionX: number;
  directionZ: number;
  /** Wavelength in metres. */
  wavelength: number;
  /** Vertical amplitude in metres. */
  amplitude: number;
  /** Phase speed in m/s. */
  speed: number;
  /** Crest sharpness 0..1 (0 = sine swell). */
  steepness: number;
  /** Phase offset in radians. */
  phase: number;
}

/** Maximum waves the water shader evaluates (the CPU sums any number). */
export const MAX_WATER_WAVES = 4;

export interface WaterSample {
  /** Vertical displacement (add to the mean level). */
  y: number;
  /** Horizontal displacement along the wave travel. */
  dx: number;
  dz: number;
  /** Analytic surface normal (unit). */
  nx: number;
  ny: number;
  nz: number;
  /** Crest factor 0..1 (0 in troughs, 1 on crests) — the foam driver. */
  crest: number;
}

export function createWaterSample(): WaterSample {
  return { y: 0, dx: 0, dz: 0, nx: 0, ny: 1, nz: 0, crest: 0 };
}

/**
 * Evaluate the Gerstner sum at a world XZ and time. Normals are the analytic derivatives of the
 * height field (`(−dy/dx, 1, −dy/dz)`, normalised) — the horizontal displacement's Jacobian is
 * ignored, which is the standard approximation and exact for `steepness = 0`.
 */
export function sampleGerstner(waves: readonly GerstnerWave[], x: number, z: number, t: number, out: WaterSample = createWaterSample()): WaterSample {
  let y = 0;
  let dx = 0;
  let dz = 0;
  let dydx = 0;
  let dydz = 0;
  let crestNum = 0;
  let crestDen = 0;
  const n = Math.max(1, waves.length);
  for (const w of waves) {
    if (!(w.amplitude > 0) || !(w.wavelength > 0)) continue;
    const len = Math.hypot(w.directionX, w.directionZ) || 1;
    const dirX = w.directionX / len;
    const dirZ = w.directionZ / len;
    const k = (2 * Math.PI) / w.wavelength;
    const f = k * (dirX * x + dirZ * z - w.speed * t) + w.phase;
    const sinF = Math.sin(f);
    const cosF = Math.cos(f);
    y += w.amplitude * sinF;
    // Q = steepness / (k·A·N): the classic normalisation keeps the sum of horizontal
    // displacements bounded by the steepness instead of growing with the wave count.
    const q = w.steepness / (k * w.amplitude * n);
    dx += q * w.amplitude * dirX * cosF;
    dz += q * w.amplitude * dirZ * cosF;
    const slope = k * w.amplitude * cosF;
    dydx += dirX * slope;
    dydz += dirZ * slope;
    crestNum += (0.5 + 0.5 * cosF) * w.amplitude;
    crestDen += w.amplitude;
  }
  out.y = y;
  out.dx = dx;
  out.dz = dz;
  const inv = 1 / (Math.hypot(dydx, 1, dydz) || 1);
  out.nx = -dydx * inv;
  out.ny = inv;
  out.nz = -dydz * inv;
  out.crest = crestDen > 0 ? crestNum / crestDen : 0;
  return out;
}

/** Vertical surface height (mean level + displacement) at a world XZ and time. */
export function waterHeightAt(waves: readonly GerstnerWave[], level: number, x: number, z: number, t: number): number {
  return level + sampleGerstner(waves, x, z, t, SCRATCH).y;
}

/** Sum of amplitudes — the surface never leaves `level ± totalAmplitude`. */
export function totalWaveAmplitude(waves: readonly GerstnerWave[]): number {
  let sum = 0;
  for (const w of waves) if (w.amplitude > 0 && w.wavelength > 0) sum += w.amplitude;
  return sum;
}

/**
 * Whitecap foam 0..1 from a crest factor: nothing below `threshold`, full foam at the crests,
 * with the same smoothstep the water shader applies (the shader adds a noise breakup on top).
 */
export function foamFromCrest(crest: number, threshold: number): number {
  const t = clamp((crest - threshold) / Math.max(1e-4, 1 - threshold), 0, 1);
  return t * t * (3 - 2 * t);
}

/** True when a camera height is below the water's mean level (the underwater path). */
export function isUnderwater(cameraY: number, water: Pick<SceneWaterSettings, "enabled" | "level">): boolean {
  return water.enabled && cameraY < water.level;
}

const SCRATCH = createWaterSample();

export interface WaterSurfaceOptions {
  name?: string;
  /** Edge length of the water plane in metres. Default 500. */
  size?: number;
  /** Mean water level (writes `scene.settings.water.level` on attach). Default 0. */
  level?: number;
}

/**
 * The water clock, sampler and entity owner. This module cannot import the renderer (the
 * environment/rendering boundary runs one way), so the mesh and material are assigned by the host
 * — see `waterGridSource` for the grid and the weather demo for the two-line wiring. The mesh is
 * a static XZ grid (the vertex shader displaces it), so no per-frame CPU work happens here beyond
 * advancing `water.time` by the fixed-step budget: the surface is then deterministic in the step
 * count, like the day/night clock. Sampling helpers read the same waves + time the shader does.
 */
export class WaterSurface extends SceneObject {
  readonly name: string;
  readonly size: number;
  readonly level: number;
  /** The water's renderable (assign `geometry`/`material` after attaching). */
  renderable: Renderable | null = null;
  private entityId = 0;

  constructor(options: WaterSurfaceOptions = {}) {
    super();
    this.name = options.name ?? "water";
    this.size = options.size ?? 500;
    this.level = options.level ?? 0;
  }

  override onAttach(scene: Scene): void {
    const water = scene.settings.water;
    water.enabled = true;
    water.level = this.level;
    water.size = this.size;
    const entity = scene.createTransformedEntity(this.name, new Vec3(0, this.level, 0));
    const renderable = new Renderable();
    renderable.castShadow = false;
    renderable.receiveShadow = false;
    renderable.transparent = true;
    scene.world.addComponent(entity.id, renderable);
    this.renderable = renderable;
    this.entityId = entity.id as number;
  }

  override onDetach(scene: Scene): void {
    scene.settings.water.enabled = false;
    if (this.entityId !== 0) {
      const facade = scene.world.facade(this.entityId as never);
      const renderable = facade?.get(Renderable);
      renderable?.geometry?.dispose();
      renderable?.material?.dispose();
      if (facade) scene.world.destroyEntity(facade.id);
      this.renderable = null;
      this.entityId = 0;
    }
  }

  override update(context: SystemContext): void {
    const scene = this.scene;
    if (!scene) return;
    const seconds = context.fixedSteps * context.fixedDt;
    if (seconds !== 0) scene.settings.water.time += seconds;
  }

  private get water(): SceneWaterSettings | null {
    return this.scene?.settings.water ?? null;
  }

  /** Surface height at a world XZ (mean level + Gerstner displacement at `water.time`). */
  sampleHeight(x: number, z: number, t?: number): number {
    const w = this.water;
    if (!w) return this.level;
    return waterHeightAt(w.waves, w.level, x, z, t ?? w.time);
  }

  /** Full Gerstner sample at a world XZ. */
  sample(x: number, z: number, out = createWaterSample(), t?: number): WaterSample {
    const w = this.water;
    if (!w) return out;
    return sampleGerstner(w.waves, x, z, t ?? w.time, out);
  }

  /** Foam 0..1 at a world XZ (crest whitecaps; the shader adds noise breakup). */
  sampleFoam(x: number, z: number, t?: number): number {
    const w = this.water;
    if (!w) return 0;
    const crest = sampleGerstner(w.waves, x, z, t ?? w.time, SCRATCH).crest;
    return foamFromCrest(crest, w.foamThreshold);
  }

  override stats(): Record<string, number | string | boolean> {
    const w = this.water;
    return {
      level: w ? Math.round(w.level * 100) / 100 : this.level,
      time: w ? Math.round(w.time * 100) / 100 : 0,
      amplitude: w ? Math.round(totalWaveAmplitude(w.waves) * 1000) / 1000 : 0,
    };
  }
}

/** A flat XZ grid the host turns into a `Geometry` (see `waterGridSource`). */
export interface WaterGridSource {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
}

/**
 * A flat XZ grid centred on the origin (the vertex shader does the displacing). Bounds are
 * padded by the wave amplitude so the displaced surface can never be frustum-culled while the
 * flat grid is on screen.
 */
export function waterGridSource(size: number, segments: number, amplitude: number): WaterGridSource {
  const seg = Math.max(1, Math.floor(segments));
  const vertsPerSide = seg + 1;
  const count = vertsPerSide * vertsPerSide;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  let v = 0;
  for (let iz = 0; iz < vertsPerSide; iz++) {
    for (let ix = 0; ix < vertsPerSide; ix++) {
      const x = (ix / seg - 0.5) * size;
      const z = (iz / seg - 0.5) * size;
      positions[v * 3] = x;
      positions[v * 3 + 1] = 0;
      positions[v * 3 + 2] = z;
      normals[v * 3 + 1] = 1;
      uvs[v * 2] = ix / seg;
      uvs[v * 2 + 1] = iz / seg;
      v++;
    }
  }
  const indices = new Uint32Array(seg * seg * 6);
  let o = 0;
  for (let iz = 0; iz < seg; iz++) {
    for (let ix = 0; ix < seg; ix++) {
      const a = iz * vertsPerSide + ix;
      const b = a + 1;
      const c = a + vertsPerSide;
      const d = c + 1;
      indices[o++] = a;
      indices[o++] = c;
      indices[o++] = b;
      indices[o++] = b;
      indices[o++] = c;
      indices[o++] = d;
    }
  }
  const half = size / 2;
  const pad = Math.max(0.5, amplitude);
  return { positions, normals, uvs, indices, boundsMin: [-half, -pad, -half], boundsMax: [half, pad, half] };
}
