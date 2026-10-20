/**
 * Phase 23's validation contract for the Mars Showcase.
 *
 * The showcase already exercises many individual Forge systems. This module turns that collection
 * into one versioned, machine-readable reference-slice snapshot and tracks whether the rover is
 * actually traversing streamed terrain over time. It deliberately does not declare the full phase
 * complete: erosion, the wider environment/camera matrix and deterministic mission replay remain
 * separate roadmap work.
 */

import type { EngineStats, FrameBreakdown } from "@forge/engine";

export const MARS_REFERENCE_SCHEMA = "forge.mars-reference/1" as const;

export interface MarsReferenceTraversalSample {
  dt: number;
  x: number;
  z: number;
  speed: number;
  roverChunkReady: boolean;
}

export interface MarsReferenceTraversal {
  /** Update time observed by the monitor (large/pause deltas are clamped). */
  elapsedSeconds: number;
  /** Observed update time with meaningful rover motion (|speed| >= 0.05 m/s). */
  movingSeconds: number;
  /** Integrated XZ path length. Teleports larger than one terrain chunk are not counted. */
  distanceMeters: number;
  /** Furthest XZ displacement from the monitor's start point. */
  maxRadiusMeters: number;
  /** Number of distinct terrain chunk coordinates entered by the rover. */
  visitedChunks: number;
  /** Moving time spent over a requested-but-not-ready rover chunk (startup warm-up is excluded). */
  terrainGapSeconds: number;
  terrainGapFrames: number;
  /** Discontinuous position changes excluded from distance accounting. */
  discontinuities: number;
  currentChunk: string;
}

/**
 * Long-lived traversal monitor used by the Mars reference slice and future soak gates.
 *
 * It is intentionally independent of DOM/rendering and accepts plain samples, so deterministic
 * tests can prove the accounting without constructing the whole scene.
 */
export class MarsReferenceTraversalMonitor {
  private startX: number;
  private startZ: number;
  private lastX: number;
  private lastZ: number;
  private elapsedSeconds = 0;
  private movingSeconds = 0;
  private distanceMeters = 0;
  private maxRadiusMeters = 0;
  private terrainGapSeconds = 0;
  private terrainGapFrames = 0;
  private discontinuities = 0;
  private currentChunk = "0,0";
  private readonly chunks = new Set<string>();

  constructor(x: number, z: number, readonly chunkSize: number) {
    if (!Number.isFinite(chunkSize) || chunkSize <= 0) throw new RangeError("Mars reference chunkSize must be positive");
    this.startX = this.lastX = finiteOr(x, 0);
    this.startZ = this.lastZ = finiteOr(z, 0);
    this.visit(this.startX, this.startZ);
  }

  sample(sample: MarsReferenceTraversalSample): void {
    const x = finiteOr(sample.x, this.lastX);
    const z = finiteOr(sample.z, this.lastZ);
    const dt = Math.min(0.25, Math.max(0, finiteOr(sample.dt, 0)));
    const segment = Math.hypot(x - this.lastX, z - this.lastZ);

    // A rover cannot cross a whole terrain chunk in one simulation frame. Treat such a change as a
    // debug placement / future origin-rebase discontinuity, not kilometres of successful driving.
    if (segment <= this.chunkSize) this.distanceMeters += segment;
    else this.discontinuities++;

    this.lastX = x;
    this.lastZ = z;
    this.elapsedSeconds += dt;
    const moving = Math.abs(finiteOr(sample.speed, 0)) >= 0.05;
    if (moving) this.movingSeconds += dt;
    if (moving && !sample.roverChunkReady) {
      this.terrainGapSeconds += dt;
      this.terrainGapFrames++;
    }
    this.maxRadiusMeters = Math.max(this.maxRadiusMeters, Math.hypot(x - this.startX, z - this.startZ));
    this.visit(x, z);
  }

  reset(x = this.lastX, z = this.lastZ): void {
    this.startX = this.lastX = finiteOr(x, this.lastX);
    this.startZ = this.lastZ = finiteOr(z, this.lastZ);
    this.elapsedSeconds = 0;
    this.movingSeconds = 0;
    this.distanceMeters = 0;
    this.maxRadiusMeters = 0;
    this.terrainGapSeconds = 0;
    this.terrainGapFrames = 0;
    this.discontinuities = 0;
    this.chunks.clear();
    this.visit(this.lastX, this.lastZ);
  }

  snapshot(): MarsReferenceTraversal {
    return {
      elapsedSeconds: this.elapsedSeconds,
      movingSeconds: this.movingSeconds,
      distanceMeters: this.distanceMeters,
      maxRadiusMeters: this.maxRadiusMeters,
      visitedChunks: this.chunks.size,
      terrainGapSeconds: this.terrainGapSeconds,
      terrainGapFrames: this.terrainGapFrames,
      discontinuities: this.discontinuities,
      currentChunk: this.currentChunk,
    };
  }

  private visit(x: number, z: number): void {
    this.currentChunk = `${Math.floor(x / this.chunkSize)},${Math.floor(z / this.chunkSize)}`;
    this.chunks.add(this.currentChunk);
  }
}

export interface MarsReferenceSceneSample {
  modelLoaded: boolean;
  modelError: string | null;
  wheelCount: number;
  contactWheels: number;
  speed: number;
  terrain: {
    chunks: number;
    readyChunks: number;
    residentBytes: number;
    roverChunkReady: boolean;
    generation: "workers" | "inline";
    hasErosion: boolean;
    scheduledThisFrame: number;
    generatedThisFrame: number;
    uploadedThisFrame: number;
  };
  particles: {
    ambientDust: number;
    wheelDust: number;
    toolDust: number;
    debris: number;
  };
  traversal: MarsReferenceTraversal;
}

export interface MarsReferenceTelemetry {
  /** Engine stats and frame breakdown were available. False in deliberately reduced fixtures. */
  available: boolean;
  fps: number | null;
  cpuFrameMs: number | null;
  /** Null when timestamp queries are unavailable or no query has resolved yet. */
  gpuFrameMs: number | null;
  gpuTimingAvailable: boolean;
  physicsMs: number | null;
  terrainMs: number | null;
  streamingMs: number | null;
  particleCount: number;
  /** Renderer instances submitted this frame: the closest stable measure of visible objects. */
  visibleObjects: number | null;
  loadedChunks: number;
  /** Live device buffers + textures. Graph transient/pool figures overlap these and are not added. */
  gpuMemoryBytes: number | null;
  gpuTextureBytes: number | null;
  gpuBufferBytes: number | null;
}

export interface MarsReferenceState {
  schema: typeof MARS_REFERENCE_SCHEMA;
  phase: 23;
  /** `ready` means this frame's reference workload is live, not that every Phase 23 item is done. */
  status: "warming" | "ready" | "degraded";
  readiness: {
    model: boolean;
    terrain: boolean;
    sixWheelRover: boolean;
    engineTelemetry: boolean;
    gpuHealthy: boolean | null;
  };
  telemetry: MarsReferenceTelemetry;
  terrain: MarsReferenceSceneSample["terrain"];
  particles: MarsReferenceSceneSample["particles"] & { total: number };
  rover: {
    wheelCount: number;
    contactWheels: number;
    speed: number;
  };
  traversal: MarsReferenceTraversal;
  streaming: {
    assetQueued: number | null;
    assetInFlight: number | null;
    terrainScheduledThisFrame: number;
    terrainGeneratedThisFrame: number;
    terrainUploadedThisFrame: number;
  };
  /** Explicitly keeps the largest known terrain-fidelity gap visible to tools and reviewers. */
  limitations: {
    erosionCache: "missing" | "active";
  };
}

/** Build the versioned Phase 23 snapshot from public engine diagnostics and plain scene state. */
export function captureMarsReferenceState(
  sample: MarsReferenceSceneSample,
  stats: Readonly<EngineStats> | null,
  breakdown: Readonly<FrameBreakdown> | null,
): MarsReferenceState {
  const particleCount =
    nonNegative(sample.particles.ambientDust) +
    nonNegative(sample.particles.wheelDust) +
    nonNegative(sample.particles.toolDust) +
    nonNegative(sample.particles.debris);
  const categories = breakdown?.categories;
  const gpuTimingAvailable = stats?.render.gpuTimingAvailable === true;
  const queriedGpuMs = positiveOrNull(breakdown?.gpuFrameMs) ?? positiveOrNull(stats?.render.gpuFrameTimeMs);
  const gpuFrameMs = gpuTimingAvailable ? queriedGpuMs : null;
  const textureBytes = numberOrNull(stats?.gpuMemory.textureBytes);
  const bufferBytes = numberOrNull(stats?.gpuMemory.bufferBytes);
  const engineTelemetry = stats !== null && breakdown !== null;
  const gpuHealthy = stats === null ? null : !stats.deviceLost && !stats.deviceFatal && stats.gpuErrors === 0;
  const modelReady = sample.modelLoaded && sample.modelError === null;
  const terrainReady = sample.terrain.roverChunkReady && sample.terrain.readyChunks > 0;
  const sixWheelRover = sample.wheelCount === 6;
  const degraded = sample.modelError !== null || gpuHealthy === false;

  return {
    schema: MARS_REFERENCE_SCHEMA,
    phase: 23,
    status: degraded ? "degraded" : modelReady && terrainReady && sixWheelRover && engineTelemetry ? "ready" : "warming",
    readiness: {
      model: modelReady,
      terrain: terrainReady,
      sixWheelRover,
      engineTelemetry,
      gpuHealthy,
    },
    telemetry: {
      available: engineTelemetry,
      fps: numberOrNull(stats?.fps),
      cpuFrameMs: numberOrNull(breakdown?.cpuFrameMs) ?? numberOrNull(stats?.frameTimeMs),
      gpuFrameMs,
      gpuTimingAvailable,
      physicsMs: numberOrNull(categories?.physics),
      terrainMs: numberOrNull(categories?.terrain),
      streamingMs: numberOrNull(categories?.streaming),
      particleCount,
      visibleObjects: numberOrNull(stats?.instances),
      loadedChunks: nonNegative(sample.terrain.readyChunks),
      gpuMemoryBytes: textureBytes === null || bufferBytes === null ? null : textureBytes + bufferBytes,
      gpuTextureBytes: textureBytes,
      gpuBufferBytes: bufferBytes,
    },
    terrain: { ...sample.terrain },
    particles: { ...sample.particles, total: particleCount },
    rover: {
      wheelCount: sample.wheelCount,
      contactWheels: sample.contactWheels,
      speed: sample.speed,
    },
    traversal: { ...sample.traversal },
    streaming: {
      assetQueued: numberOrNull(stats?.streaming.queued),
      assetInFlight: numberOrNull(stats?.streaming.inFlight),
      terrainScheduledThisFrame: nonNegative(sample.terrain.scheduledThisFrame),
      terrainGeneratedThisFrame: nonNegative(sample.terrain.generatedThisFrame),
      terrainUploadedThisFrame: nonNegative(sample.terrain.uploadedThisFrame),
    },
    limitations: {
      erosionCache: sample.terrain.hasErosion ? "active" : "missing",
    },
  };
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function numberOrNull(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) ? value : null;
}

function positiveOrNull(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : null;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
