/**
 * @suite examples:marsReferenceTelemetry
 * @group unit
 * @covers examples/src/scenes/marsReferenceTelemetry.ts
 * @desc Phase 23 Mars reference snapshot and continuous traversal accounting.
 */

export const suite = {
  name: "examples:marsReferenceTelemetry",
  group: "unit",
  covers: ["examples/src/scenes/marsReferenceTelemetry.ts"],
  desc: "Phase 23 Mars reference snapshot and continuous traversal accounting.",
};

import assert from "node:assert/strict";
import { assertCloseTo, finish, group, test } from "selrun";
import type { EngineStats, FrameBreakdown } from "@forge/engine";
import {
  MARS_REFERENCE_SCHEMA,
  MarsReferenceTraversalMonitor,
  captureMarsReferenceState,
  type MarsReferenceSceneSample,
} from "../../examples/src/scenes/marsReferenceTelemetry.js";

function sceneSample(overrides: Partial<MarsReferenceSceneSample> = {}): MarsReferenceSceneSample {
  return {
    modelLoaded: true,
    modelError: null,
    wheelCount: 6,
    contactWheels: 6,
    speed: 1.25,
    terrain: {
      chunks: 12,
      readyChunks: 8,
      residentBytes: 4096,
      roverChunkReady: true,
      generation: "workers",
      hasErosion: false,
      scheduledThisFrame: 2,
      generatedThisFrame: 1,
      uploadedThisFrame: 1,
    },
    particles: { ambientDust: 10, wheelDust: 7, toolDust: 3, debris: 6 },
    traversal: {
      elapsedSeconds: 12,
      movingSeconds: 8,
      distanceMeters: 22,
      maxRadiusMeters: 20,
      visitedChunks: 3,
      terrainGapSeconds: 0,
      terrainGapFrames: 0,
      discontinuities: 0,
      currentChunk: "1,-1",
    },
    ...overrides,
  };
}

function engineStats(gpuTimingAvailable = true): EngineStats {
  return {
    fps: 58,
    frameTimeMs: 17.2,
    instances: 321,
    deviceLost: false,
    deviceFatal: false,
    gpuErrors: 0,
    streaming: { queued: 4, inFlight: 2 },
    render: { gpuTimingAvailable, gpuFrameTimeMs: 7.5 },
    gpuMemory: { textureBytes: 10_000, bufferBytes: 2_500 },
  } as unknown as EngineStats;
}

function breakdown(): FrameBreakdown {
  return {
    cpuFrameMs: 16.25,
    gpuFrameMs: 6.5,
    categories: {
      simulation: 1,
      physics: 2.25,
      terrain: 3.5,
      streaming: 0.75,
      rendering: 4,
      particles: 0.5,
      scripting: 0,
      audio: 0,
    },
    top: {
      simulation: [],
      physics: [],
      terrain: [],
      streaming: [],
      rendering: [],
      particles: [],
      scripting: [],
      audio: [],
    },
    unattributedMs: 0,
  };
}

group("Mars reference traversal monitor", () => {
  test("integrates a continuous route, records streamed chunks and rejects teleports", () => {
    const monitor = new MarsReferenceTraversalMonitor(10, 10, 100);
    monitor.sample({ dt: 0.1, x: 20, z: 10, speed: 1, roverChunkReady: true });
    monitor.sample({ dt: 0.1, x: 120, z: 10, speed: 1, roverChunkReady: false });
    monitor.sample({ dt: 0.1, x: 500, z: 10, speed: 2, roverChunkReady: true });
    monitor.sample({ dt: 1, x: 501, z: 10, speed: 0, roverChunkReady: false });

    const state = monitor.snapshot();
    assertCloseTo(state.elapsedSeconds, 0.55, 12);
    assertCloseTo(state.movingSeconds, 0.3, 12);
    assertCloseTo(state.distanceMeters, 111, 12);
    assertCloseTo(state.maxRadiusMeters, 491, 12);
    assert.equal(state.visitedChunks, 3);
    assert.equal(state.currentChunk, "5,0");
    assert.equal(state.discontinuities, 1);
    // An unavailable chunk only counts as a traversal gap while the rover is moving.
    assertCloseTo(state.terrainGapSeconds, 0.1, 12);
    assert.equal(state.terrainGapFrames, 1);

    monitor.reset();
    assert.deepEqual(monitor.snapshot(), {
      elapsedSeconds: 0,
      movingSeconds: 0,
      distanceMeters: 0,
      maxRadiusMeters: 0,
      visitedChunks: 1,
      terrainGapSeconds: 0,
      terrainGapFrames: 0,
      discontinuities: 0,
      currentChunk: "5,0",
    });
  });

  test("rejects invalid chunk sizes", () => {
    assert.throws(() => new MarsReferenceTraversalMonitor(0, 0, 0), /chunkSize must be positive/);
  });
});

group("Mars reference telemetry contract", () => {
  test("folds engine and scene diagnostics into a versioned ready snapshot", () => {
    const state = captureMarsReferenceState(sceneSample(), engineStats(), breakdown());

    assert.equal(state.schema, MARS_REFERENCE_SCHEMA);
    assert.equal(state.phase, 23);
    assert.equal(state.status, "ready");
    assert.deepEqual(state.readiness, {
      model: true,
      terrain: true,
      sixWheelRover: true,
      engineTelemetry: true,
      gpuHealthy: true,
    });
    assert.equal(state.telemetry.fps, 58);
    assert.equal(state.telemetry.cpuFrameMs, 16.25);
    assert.equal(state.telemetry.gpuFrameMs, 6.5);
    assert.equal(state.telemetry.physicsMs, 2.25);
    assert.equal(state.telemetry.terrainMs, 3.5);
    assert.equal(state.telemetry.streamingMs, 0.75);
    assert.equal(state.telemetry.particleCount, 26);
    assert.equal(state.telemetry.visibleObjects, 321);
    assert.equal(state.telemetry.loadedChunks, 8);
    assert.equal(state.telemetry.gpuMemoryBytes, 12_500);
    assert.equal(state.streaming.assetQueued, 4);
    assert.equal(state.streaming.assetInFlight, 2);
    assert.equal(state.limitations.erosionCache, "missing");
  });

  test("reports unsupported GPU timing and reduced test hosts honestly", () => {
    const noTimestamp = captureMarsReferenceState(sceneSample(), engineStats(false), breakdown());
    assert.equal(noTimestamp.telemetry.gpuTimingAvailable, false);
    assert.equal(noTimestamp.telemetry.gpuFrameMs, null);

    const reduced = captureMarsReferenceState(sceneSample({ modelError: "GLB failed" }), null, null);
    assert.equal(reduced.status, "degraded");
    assert.equal(reduced.readiness.engineTelemetry, false);
    assert.equal(reduced.readiness.gpuHealthy, null);
    assert.equal(reduced.telemetry.available, false);
    assert.equal(reduced.telemetry.fps, null);
    assert.equal(reduced.telemetry.cpuFrameMs, null);
    assert.equal(reduced.telemetry.gpuMemoryBytes, null);
    // Scene-owned counters remain useful even without an Engine fixture.
    assert.equal(reduced.telemetry.particleCount, 26);
    assert.equal(reduced.telemetry.loadedChunks, 8);
  });
});

finish();
