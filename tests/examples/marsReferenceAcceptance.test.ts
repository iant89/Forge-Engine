/**
 * @suite examples:marsReferenceAcceptance
 * @group unit
 * @covers examples/src/scenes/marsReferenceAcceptance.ts
 * @desc Phase 23 acceptance accounting and crater route.
 */

export const suite = {
  name: "examples:marsReferenceAcceptance",
  group: "unit",
  covers: ["examples/src/scenes/marsReferenceAcceptance.ts"],
  desc: "Phase 23 acceptance accounting and crater route.",
};

import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import {
  buildMarsReferenceCraterRoute,
  MARS_REFERENCE_CRATER_ROUTE,
  MarsReferenceAcceptanceMonitor,
} from "../../examples/src/scenes/marsReferenceAcceptance.js";

group("Mars crater route", () => {
  test("re-evaluates a real seed-1337 crater cross-section through the analytic stage", () => {
    const route = buildMarsReferenceCraterRoute();
    assert.deepEqual(route, MARS_REFERENCE_CRATER_ROUTE);
    assert.equal(route.schema, "forge.mars-crater-route/1");
    assert.equal(route.seed, 1337);
    assert.equal(route.enteredCrater, true);
    assert.equal(route.passed, true);
    assert.ok(route.craterId !== 0);
    assert.ok(route.reliefMeters > 100);
    assert.equal(route.points[0]?.inCrater, false);
    assert.equal(route.points.at(-1)?.inCrater, true);
    assert.ok((route.points.at(-1)?.elevationMeters ?? 0) < (route.points[0]?.elevationMeters ?? 0));
  });
});

group("Mars reference acceptance monitor", () => {
  test("passes a sustained dry multi-camera traversal with bounded streaming counters", () => {
    const monitor = new MarsReferenceAcceptanceMonitor(0, 0, {
      movingSeconds: 2,
      distanceMeters: 8,
      visitedChunks: 3,
      maxTerrainGapSeconds: 0.2,
      environmentSamples: 30,
      cameraModes: ["chase", "cockpit", "free", "cinematic"],
      craterSamples: 3,
      craterReliefMeters: 100,
    });
    for (let i = 0; i < 40; i++) {
      monitor.sample({
        dt: 0.1,
        x: i,
        z: 0,
        speed: 1,
        chunkSize: 2,
        roverChunkReady: true,
        terrainReadyChunks: 8,
        terrainResidentBytes: 4096 + i,
        assetQueued: i % 3,
        assetInFlight: i % 2,
        modelLoaded: true,
        modelError: null,
        weatherMode: i === 10 ? "dust" : i === 20 ? "global-dust" : "clear",
        precipitation01: 0,
        wetness: 0,
        puddles: 0,
        snow: 0,
        cameraMode: (["chase", "cockpit", "free", "cinematic"] as const)[i % 4]!,
        craterDepthMeters: i < 3 ? [0, 80, 180][i] : null,
      });
    }
    const state = monitor.snapshot({ points: [0, 1, 2], reliefMeters: 180, passed: true });
    assert.equal(state.passed, true);
    assert.deepEqual(state.failures, []);
    assert.equal(state.environmentSamples, 40);
    assert.equal(state.weatherTransitions, 4);
    assert.equal(state.dryEnvironmentViolations, 0);
    assert.equal(state.cameraModes.length, 4);
    assert.equal(state.terrainGapSeconds, 0);
    assert.ok(state.distanceMeters >= 8);
    assert.ok(state.visitedChunks >= 3);
    assert.ok(state.peakResidentBytes >= 4096);
    assert.equal(state.routeReady, true);
  });

  test("fails instead of laundering rain, gaps, jumps or model errors into a pass", () => {
    const monitor = new MarsReferenceAcceptanceMonitor(0, 0, {
      movingSeconds: 0,
      distanceMeters: 0,
      visitedChunks: 1,
      maxTerrainGapSeconds: 0,
      environmentSamples: 1,
      cameraModes: ["chase"],
      craterSamples: 0,
      craterReliefMeters: 0,
    });
    monitor.sample({
      dt: 0.1,
      x: 1000,
      z: 0,
      speed: 1,
      chunkSize: 10,
      roverChunkReady: false,
      terrainReadyChunks: 0,
      terrainResidentBytes: 0,
      assetQueued: 0,
      assetInFlight: 0,
      modelLoaded: false,
      modelError: "load failed",
      weatherMode: "clear",
      precipitation01: 0.4,
      wetness: 0.2,
      puddles: 0.1,
      snow: 0.3,
      cameraMode: "chase",
    });
    const state = monitor.snapshot();
    assert.equal(state.passed, false);
    assert.ok(state.failures.includes("dry-environment"));
    assert.ok(state.failures.includes("terrain-gap"));
    assert.ok(state.failures.includes("asset-error"));
    assert.equal(state.discontinuities, 1);
  });
});

finish();
