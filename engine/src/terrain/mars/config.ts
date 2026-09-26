/**
 * Mars planet + world-generation parameters — transcribed from `mars-terrain-gen`'s
 * `src/config/marsConfig.ts` (plus the geometry constants its `build.ts` derives from them).
 *
 * These values are the generator's *default world*. They matter beyond cosmetics: Stage A caches
 * `erosionDelta = erodedElevation - analytic base`, and the port adds that correction to its own
 * analytic base. Change the seed, the dichotomy axis, the canyon or a volcano here and the port is
 * generating a different planet than the one the correction was measured on, which shows up as
 * relief that does not line up with its own craters. If you edit `marsConfig.ts` upstream, mirror it
 * here (or pass your own `MarsGenParams` to the stage) — `MARS_STAGE_A_DEFAULTS` records the other
 * half of the contract.
 */

import { marsNormalize } from "./cubeSphere.js";
import type { MarsCanyonSegment, MarsDichotomyConfig, MarsGenParamsLike, MarsVolcanoDef } from "./geology.js";

/** Mean radius of Mars, in metres — the reference sphere the generator's elevations are relative to. */
export const MARS_RADIUS_M = 3_389_500;

/** Surface gravity, in m/s^2. Lower than Earth's, which is what lets Mars keep steeper stable slopes. */
export const MARS_GRAVITY = 3.71;

export interface MarsGenParams extends MarsGenParamsLike {
  seed: number;
  radius: number;
  dichotomy: MarsDichotomyConfig;
  canyon: MarsCanyonSegment[];
  volcanoes: MarsVolcanoDef[];
}

function marsDefaultCanyon(): MarsCanyonSegment[] {
  const r = MARS_RADIUS_M;
  // A simplified Valles-Marineris-like rift as a chain of segments. Real start/end points (and more
  // segments) would trace the actual canyon path.
  return [
    {
      a: { x: r * 0.6, y: r * 0.3, z: r * 0.7 },
      b: { x: r * 0.9, y: r * 0.1, z: r * 0.4 },
      width: 100_000,
      depth: 6000,
    },
  ];
}

function marsDefaultVolcanoes(): MarsVolcanoDef[] {
  return [
    // An Olympus-Mons-like shield: ~600 km across, ~21 km tall, with a summit caldera.
    {
      center: { x: 0, y: 0, z: 0 }, // filled below; kept in one place so the normalise is visible
      baseRadius: 300_000,
      height: 21_000,
      calderaRadius: 40_000,
      calderaDepth: 3000,
      seed: 42,
    },
  ].map((v) => {
    const dir = marsNormalize({ x: -0.3, y: 0.5, z: 0.8 });
    return { ...v, center: { x: dir.x * MARS_RADIUS_M, y: dir.y * MARS_RADIUS_M, z: dir.z * MARS_RADIUS_M } };
  });
}

/** The generator's default world (`marsParams` upstream). */
export const MARS_GEN_PARAMS: MarsGenParams = {
  seed: 1337,
  radius: MARS_RADIUS_M,
  dichotomy: {
    seed: 1337,
    axis: marsNormalize({ x: 0.2, y: 0.95, z: 0.1 }),
    boundaryOffset: 0.15,
    amplitude: 4000,
    waviness: 0.3,
  },
  canyon: marsDefaultCanyon(),
  volcanoes: marsDefaultVolcanoes(),
};

/** Fields a caller may override when building their own copy of the default world. */
export interface MarsGenParamsOverrides {
  seed?: number;
  radius?: number;
  dichotomy?: Partial<MarsDichotomyConfig>;
  canyon?: MarsCanyonSegment[];
  volcanoes?: MarsVolcanoDef[];
}

/** Copy of `MARS_GEN_PARAMS` with overrides applied (never mutates the shared default). */
export function createMarsGenParams(overrides: MarsGenParamsOverrides = {}): MarsGenParams {
  return {
    seed: overrides.seed ?? MARS_GEN_PARAMS.seed,
    radius: overrides.radius ?? MARS_GEN_PARAMS.radius,
    dichotomy: { ...MARS_GEN_PARAMS.dichotomy, ...(overrides.dichotomy ?? {}) },
    canyon: (overrides.canyon ?? marsDefaultCanyon()).map((c) => ({ ...c })),
    volcanoes: (overrides.volcanoes ?? marsDefaultVolcanoes()).map((v) => ({ ...v, center: { ...v.center } })),
  };
}

/**
 * The generator's Stage A simulation settings (`stageAOptions` upstream), recorded here as data.
 *
 * The port does not simulate anything — it consumes the fields this produces. They are repeated so
 * a scene, a tool or a doc can state which cache a given `cache/global/` directory corresponds to
 * (`res` in particular: the cached `meta.json` is authoritative, this is the default).
 */
export const MARS_STAGE_A_DEFAULTS = {
  /** Simulation grid resolution per cube face (res x res). */
  res: 512,
  thermalIterations: 25,
  thermalTalusDeg: 32,
  hydraulicIncision: 0.4,
  hydraulicAccumPower: 0.5,
  wind: {
    seed: 99,
    axis: marsNormalize({ x: 1, y: 0, z: 0 }),
    duneFrequency: 0.0006,
    duneAmplitude: 15,
  },
} as const;

/**
 * Approximate metres between neighbouring cells of a Stage A face grid at the face centre: the
 * erosion correction is interpolated at this scale, so relief below it comes from the analytic base
 * and the detail band, not from the simulation.
 */
export function marsStageACellMeters(res: number = MARS_STAGE_A_DEFAULTS.res, radius: number = MARS_RADIUS_M): number {
  return ((Math.PI / 2) * radius) / res;
}
