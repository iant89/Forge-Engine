/**
 * Deterministic acceptance accounting for the Mars reference slice (Phases 23.2, 23.4, 23.6 and 23.8).
 *
 * The browser scene remains responsible for producing samples. This module owns only bounded counters,
 * dry-environment invariants and threshold evaluation, so a slow browser and a headless soak use the
 * same contract instead of each inventing a different notion of "traversal worked".
 */

import {
  MARS_GEN_PARAMS,
  MARS_RADIUS_M,
  marsFaceUVToDirection,
  marsSampleAnalytic,
  marsSampleCraterDelta,
} from "@forge/engine";

export const MARS_ACCEPTANCE_SCHEMA = "forge.mars-acceptance/1" as const;
export const MARS_CRATER_ROUTE_SCHEMA = "forge.mars-crater-route/1" as const;

export type MarsAcceptanceCameraMode = "chase" | "cockpit" | "free" | "cinematic";

export interface MarsReferenceAcceptanceSample {
  dt: number;
  x: number;
  z: number;
  speed: number;
  chunkSize: number;
  roverChunkReady: boolean;
  terrainReadyChunks: number;
  terrainResidentBytes: number;
  assetQueued: number | null;
  assetInFlight: number | null;
  modelLoaded: boolean;
  modelError: string | null;
  weatherMode: "clear" | "dust" | "global-dust";
  precipitation01: number;
  wetness: number;
  puddles: number;
  snow: number;
  cameraMode: MarsAcceptanceCameraMode;
  /** Optional route sample: depth below the route rim in metres, or null outside the crater route. */
  craterDepthMeters?: number | null;
}

export interface MarsReferenceAcceptanceThresholds {
  /** Moving time needed before a soak can pass. */
  movingSeconds: number;
  /** Minimum integrated distance and distinct chunks entered. */
  distanceMeters: number;
  visitedChunks: number;
  /** Maximum moving time over a requested but not-yet-ready rover chunk. */
  maxTerrainGapSeconds: number;
  /** Bounded streaming counters; these are observed peaks, not wall-clock guesses. */
  maxResidentBytes: number;
  maxAssetQueued: number;
  maxAssetInFlight: number;
  /** At least this many samples must prove the dry environment stayed dry. */
  environmentSamples: number;
  /** All four reference camera modes must be exercised by default. */
  cameraModes: readonly MarsAcceptanceCameraMode[];
  /** Crater-route samples and relief required by the separate route gate. */
  craterSamples: number;
  craterReliefMeters: number;
}

export const MARS_REFERENCE_ACCEPTANCE_DEFAULTS: Readonly<MarsReferenceAcceptanceThresholds> = Object.freeze({
  movingSeconds: 8,
  distanceMeters: 4,
  visitedChunks: 2,
  maxTerrainGapSeconds: 0.5,
  maxResidentBytes: 512 * 1024 * 1024,
  maxAssetQueued: 128,
  maxAssetInFlight: 32,
  environmentSamples: 30,
  cameraModes: ["chase", "cockpit", "free", "cinematic"] as const,
  craterSamples: 3,
  craterReliefMeters: 100,
});

export interface MarsCraterRoutePoint {
  face: 0;
  u: number;
  v: number;
  elevationMeters: number;
  craterDeltaMeters: number;
  craterId: number;
  inCrater: boolean;
  material: number;
}

export interface MarsCraterRoute {
  schema: typeof MARS_CRATER_ROUTE_SCHEMA;
  seed: number;
  points: MarsCraterRoutePoint[];
  craterId: number;
  reliefMeters: number;
  enteredCrater: boolean;
  passed: boolean;
}

/**
 * The reference route is a short, deterministic cross-section through a real seed-1337 crater on
 * face +X. It is intentionally expressed in canonical face coordinates rather than a hand-authored
 * height list: every point is re-evaluated through the same analytic Mars stage used by terrain
 * workers, so a future geology change cannot make the browser gate pass on stale fixture numbers.
 */
export function buildMarsReferenceCraterRoute(seed = MARS_GEN_PARAMS.seed): MarsCraterRoute {
  const route = [
    { face: 0 as const, u: 0.265, v: -0.28 }, // outside/rim approach
    { face: 0 as const, u: 0.27, v: -0.28 },
    { face: 0 as const, u: 0.28, v: -0.28 },
    { face: 0 as const, u: 0.3, v: -0.28 }, // deep floor
  ];
  const params = seed === MARS_GEN_PARAMS.seed ? MARS_GEN_PARAMS : { ...MARS_GEN_PARAMS, seed };
  const points = route.map(({ face, u, v }) => {
    const dir = marsFaceUVToDirection(face, u, v);
    const crater = marsSampleCraterDelta(dir.x * MARS_RADIUS_M, dir.y * MARS_RADIUS_M, dir.z * MARS_RADIUS_M, seed);
    const analytic = marsSampleAnalytic(dir.x, dir.y, dir.z, params);
    return {
      face,
      u,
      v,
      elevationMeters: analytic.elevation,
      craterDeltaMeters: crater.delta,
      craterId: crater.craterId,
      inCrater: crater.inCrater,
      material: analytic.material as number,
    };
  });
  const elevations = points.map((point) => point.elevationMeters);
  const reliefMeters = Math.max(...elevations) - Math.min(...elevations);
  const craterIds = points.filter((point) => point.inCrater).map((point) => point.craterId);
  const craterId = craterIds[0] ?? 0;
  return {
    schema: MARS_CRATER_ROUTE_SCHEMA,
    seed,
    points,
    craterId,
    reliefMeters,
    enteredCrater: points.some((point) => point.inCrater),
    passed: points.length >= 3 && craterId !== 0 && points.some((point) => point.inCrater) && reliefMeters >= 100,
  };
}

export const MARS_REFERENCE_CRATER_ROUTE = buildMarsReferenceCraterRoute();

export interface MarsReferenceAcceptance {
  schema: typeof MARS_ACCEPTANCE_SCHEMA;
  thresholds: MarsReferenceAcceptanceThresholds;
  elapsedSeconds: number;
  movingSeconds: number;
  distanceMeters: number;
  visitedChunks: number;
  terrainGapSeconds: number;
  terrainGapFrames: number;
  discontinuities: number;
  peakResidentBytes: number;
  peakAssetQueued: number;
  peakAssetInFlight: number;
  modelReady: boolean;
  terrainReady: boolean;
  environmentSamples: number;
  weatherTransitions: number;
  dryEnvironmentViolations: number;
  cameraModes: MarsAcceptanceCameraMode[];
  craterSamples: number;
  craterReliefMeters: number;
  modelErrors: number;
  routeReady: boolean;
  passed: boolean;
  failures: string[];
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function nonNegative(value: number): number {
  return Math.max(0, finite(value, 0));
}

function sameMode(a: string, b: string): boolean {
  return a === b;
}

/**
 * Bounded, resettable acceptance monitor. A position jump larger than one chunk is treated as a
 * placement/origin-rebase discontinuity and is never counted as traversal distance.
 */
export class MarsReferenceAcceptanceMonitor {
  private readonly thresholds: MarsReferenceAcceptanceThresholds;
  private lastX: number;
  private lastZ: number;
  private lastWeather: MarsReferenceAcceptanceSample["weatherMode"] | null = null;
  private readonly chunks = new Set<string>();
  private readonly modes = new Set<MarsAcceptanceCameraMode>();
  private elapsed = 0;
  private moving = 0;
  private distance = 0;
  private gap = 0;
  private gapFrames = 0;
  private discontinuities = 0;
  private peakResident = 0;
  private peakQueued = 0;
  private peakInFlight = 0;
  private modelReadySeen = false;
  private terrainReadySeen = false;
  private environmentSamples = 0;
  private weatherTransitions = 0;
  private dryViolations = 0;
  private craterSamples = 0;
  private craterMin = Infinity;
  private craterMax = -Infinity;
  private modelErrors = 0;

  constructor(x: number, z: number, thresholds: Partial<MarsReferenceAcceptanceThresholds> = {}) {
    this.thresholds = {
      ...MARS_REFERENCE_ACCEPTANCE_DEFAULTS,
      ...thresholds,
      cameraModes: [...(thresholds.cameraModes ?? MARS_REFERENCE_ACCEPTANCE_DEFAULTS.cameraModes)],
    };
    this.lastX = finite(x, 0);
    this.lastZ = finite(z, 0);
  }

  sample(sample: MarsReferenceAcceptanceSample): void {
    const chunkSize = Math.max(1e-6, finite(sample.chunkSize, 128));
    const x = finite(sample.x, this.lastX);
    const z = finite(sample.z, this.lastZ);
    const dt = Math.min(0.25, nonNegative(sample.dt));
    const segment = Math.hypot(x - this.lastX, z - this.lastZ);
    if (segment <= chunkSize) this.distance += segment;
    else this.discontinuities++;
    this.lastX = x;
    this.lastZ = z;
    this.elapsed += dt;

    const speed = Math.abs(finite(sample.speed, 0));
    const isMoving = speed >= 0.05;
    if (isMoving) this.moving += dt;
    if (isMoving && !sample.roverChunkReady) {
      this.gap += dt;
      this.gapFrames++;
    }

    this.visit(x, z, chunkSize);
    this.peakResident = Math.max(this.peakResident, Math.floor(nonNegative(sample.terrainResidentBytes)));
    this.peakQueued = Math.max(this.peakQueued, Math.floor(nonNegative(sample.assetQueued ?? 0)));
    this.peakInFlight = Math.max(this.peakInFlight, Math.floor(nonNegative(sample.assetInFlight ?? 0)));
    this.modelReadySeen ||= sample.modelLoaded && sample.modelError === null;
    this.terrainReadySeen ||= sample.terrainReadyChunks > 0 && sample.roverChunkReady;
    if (sample.modelError !== null) this.modelErrors++;

    if (this.lastWeather !== null && !sameMode(this.lastWeather, sample.weatherMode)) this.weatherTransitions++;
    this.lastWeather = sample.weatherMode;
    this.environmentSamples++;
    if (
      Math.abs(finite(sample.precipitation01, 0)) > 1e-9 ||
      Math.abs(finite(sample.wetness, 0)) > 1e-9 ||
      Math.abs(finite(sample.puddles, 0)) > 1e-9 ||
      Math.abs(finite(sample.snow, 0)) > 1e-9
    ) this.dryViolations++;

    this.modes.add(sample.cameraMode);
    const craterDepth = sample.craterDepthMeters;
    if (craterDepth !== null && craterDepth !== undefined && Number.isFinite(craterDepth)) {
      this.craterSamples++;
      this.craterMin = Math.min(this.craterMin, craterDepth);
      this.craterMax = Math.max(this.craterMax, craterDepth);
    }
  }

  reset(x = this.lastX, z = this.lastZ): void {
    this.lastX = finite(x, this.lastX);
    this.lastZ = finite(z, this.lastZ);
    this.chunks.clear();
    this.modes.clear();
    this.lastWeather = null;
    this.elapsed = 0;
    this.moving = 0;
    this.distance = 0;
    this.gap = 0;
    this.gapFrames = 0;
    this.discontinuities = 0;
    this.peakResident = 0;
    this.peakQueued = 0;
    this.peakInFlight = 0;
    this.modelReadySeen = false;
    this.terrainReadySeen = false;
    this.environmentSamples = 0;
    this.weatherTransitions = 0;
    this.dryViolations = 0;
    this.craterSamples = 0;
    this.craterMin = Infinity;
    this.craterMax = -Infinity;
    this.modelErrors = 0;
  }

  snapshot(route?: { points: readonly unknown[]; reliefMeters: number; passed: boolean }): MarsReferenceAcceptance {
    const failures: string[] = [];
    if (this.moving < this.thresholds.movingSeconds) failures.push("moving-time");
    if (this.distance < this.thresholds.distanceMeters) failures.push("distance");
    if (this.chunks.size < this.thresholds.visitedChunks) failures.push("visited-chunks");
    if (this.gap > this.thresholds.maxTerrainGapSeconds) failures.push("terrain-gap");
    if (this.peakResident > this.thresholds.maxResidentBytes) failures.push("resident-budget");
    if (this.peakQueued > this.thresholds.maxAssetQueued) failures.push("asset-queue-budget");
    if (this.peakInFlight > this.thresholds.maxAssetInFlight) failures.push("asset-flight-budget");
    if (!this.modelReadySeen) failures.push("model-not-ready");
    if (!this.terrainReadySeen) failures.push("terrain-not-ready");
    if (this.environmentSamples < this.thresholds.environmentSamples) failures.push("environment-samples");
    if (this.dryViolations > 0) failures.push("dry-environment");
    for (const mode of this.thresholds.cameraModes) if (!this.modes.has(mode)) failures.push(`camera-${mode}`);
    const sampledCraterRelief = this.craterSamples > 0 ? Math.max(0, this.craterMax - this.craterMin) : 0;
    const craterSamples = route?.points.length ?? this.craterSamples;
    const craterRelief = route?.reliefMeters ?? sampledCraterRelief;
    const routeReady = route?.passed ?? (
      this.craterSamples >= this.thresholds.craterSamples && sampledCraterRelief >= this.thresholds.craterReliefMeters
    );
    if (craterSamples < this.thresholds.craterSamples) failures.push("crater-samples");
    if (craterRelief < this.thresholds.craterReliefMeters || !routeReady) failures.push("crater-relief");
    if (this.modelErrors > 0) failures.push("asset-error");

    return {
      schema: MARS_ACCEPTANCE_SCHEMA,
      thresholds: {
        ...this.thresholds,
        cameraModes: [...this.thresholds.cameraModes],
      },
      elapsedSeconds: this.elapsed,
      movingSeconds: this.moving,
      distanceMeters: this.distance,
      visitedChunks: this.chunks.size,
      terrainGapSeconds: this.gap,
      terrainGapFrames: this.gapFrames,
      discontinuities: this.discontinuities,
      peakResidentBytes: this.peakResident,
      peakAssetQueued: this.peakQueued,
      peakAssetInFlight: this.peakInFlight,
      modelReady: this.modelReadySeen,
      terrainReady: this.terrainReadySeen,
      environmentSamples: this.environmentSamples,
      weatherTransitions: this.weatherTransitions,
      dryEnvironmentViolations: this.dryViolations,
      cameraModes: [...this.modes].sort(),
      craterSamples,
      craterReliefMeters: craterRelief,
      modelErrors: this.modelErrors,
      routeReady,
      passed: failures.length === 0,
      failures,
    };
  }

  private visit(x: number, z: number, chunkSize: number): void {
    this.chunks.add(`${Math.floor(x / chunkSize)},${Math.floor(z / chunkSize)}`);
  }
}
