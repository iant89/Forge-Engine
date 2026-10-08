/**
 * @suite examples:highGainAntenna
 * @group integration
 * @covers engine/src/index.ts
 * @covers engine/src/math/vec.ts
 * @covers examples/src/scenes/highGainAntenna.ts
 * @desc High-gain antenna: the one-way deploy (armed when the model lands, unfurl
 */

export const suite = {
  name: "examples:highGainAntenna",
  group: "integration",
  covers:   [
    "engine/src/index.ts",
    "engine/src/math/vec.ts",
    "examples/src/scenes/highGainAntenna.ts"
  ],
  desc: "High-gain antenna: the one-way deploy (armed when the model lands, unfurl",
};
/**
 * High-gain antenna: the one-way deploy (armed when the model lands, unfurl
 * `HGA_DEPLOY_DELAY_SECONDS` later) and the Earth tracking (world-space target, slew-limited
 * gimbals, elevation clamps, no stow path anywhere).
 */
import assert from "node:assert/strict";
import { assertCloseTo, assertNotCloseTo, finish, group, test } from "selrun";
import { Vec3 } from "@forge/engine";
import {
  EARTH_DIRECTION,
  HGA_DEPLOY_DELAY_SECONDS,
  HGA_DEPLOY_RATE,
  HGA_DEPLOY_SECONDS,
  HGA_MAX_ELEVATION,
  HGA_MIN_ELEVATION,
  HGA_SLEW_RATE,
  HGA_STOWED_AZIMUTH,
  HGA_STOWED_ELEVATION,
  HighGainAntennaController,
  gimbalBoresight,
} from "../../examples/src/scenes/highGainAntenna.js";

const DT = 1 / 120;
const LEVEL = { yaw: 0, pitch: 0, roll: 0 };

function run(hga: HighGainAntennaController, seconds: number, pose: { yaw: number; pitch: number; roll: number } = LEVEL): number {
  let moved = 0;
  for (let t = 0; t < seconds; t += DT) if (hga.update(DT, pose)) moved++;
  return moved;
}

/** Angular distance between the current boresight and Earth (radians). */
function boresightError(hga: HighGainAntennaController, pose = LEVEL): number {
  const dir = gimbalBoresight(pose, hga.azimuth, hga.elevation, new Vec3());
  return Math.acos(Math.max(-1, Math.min(1, dir.x * EARTH_DIRECTION.x + dir.y * EARTH_DIRECTION.y + dir.z * EARTH_DIRECTION.z)));
}

group("HighGainAntennaController — one-way deployment", () => {
  test("holds stowed until armed, however long it runs", () => {
    const hga = new HighGainAntennaController();
    assert.equal(run(hga, 120), 0);
    assert.equal(hga.phase, "stowed");
    assert.equal(hga.azimuth, HGA_STOWED_AZIMUTH);
    assert.equal(hga.elevation, HGA_STOWED_ELEVATION);
  });

  test("starts unfurling only after the delay, and counts it down", () => {
    const hga = new HighGainAntennaController();
    hga.arm();
    run(hga, HGA_DEPLOY_DELAY_SECONDS - 0.05);
    assert.equal(hga.phase, "stowed");
    assertCloseTo(hga.countdown, 0.05, 3);
    run(hga, 0.1);
    assert.equal(hga.phase, "deploying");
    assert.equal(hga.countdown, 0);
  });

  test("finishes the unfurl in about HGA_DEPLOY_SECONDS and points at Earth", () => {
    const hga = new HighGainAntennaController();
    hga.arm();
    run(hga, HGA_DEPLOY_DELAY_SECONDS + HGA_DEPLOY_SECONDS * 0.5);
    assert.equal(hga.phase, "deploying");
    run(hga, HGA_DEPLOY_SECONDS * 2);
    assert.equal(hga.phase, "tracking");
    assert.equal(hga.deployed, true);
    assert.ok(boresightError(hga) < 0.5 * (Math.PI / 180));
  });

  test("deploy motion is mechanical: no gimbal ever snaps", () => {
    const hga = new HighGainAntennaController();
    hga.arm();
    run(hga, HGA_DEPLOY_DELAY_SECONDS);
    let prevAz = hga.azimuth;
    let prevEl = hga.elevation;
    let maxStep = 0;
    for (let t = 0; t < HGA_DEPLOY_SECONDS * 2; t += DT) {
      hga.update(DT, LEVEL);
      maxStep = Math.max(maxStep, Math.abs(hga.azimuth - prevAz), Math.abs(hga.elevation - prevEl));
      prevAz = hga.azimuth;
      prevEl = hga.elevation;
    }
    // 40°/s at 120 Hz ≈ 0.33°/step; allow a hair for the snap-to-target residue.
    assert.ok(maxStep < (HGA_DEPLOY_RATE * DT) + 1e-4);
  });
});

group("HighGainAntennaController — Earth tracking", () => {
  function tracking(pose = LEVEL): HighGainAntennaController {
    const hga = new HighGainAntennaController();
    hga.arm();
    run(hga, HGA_DEPLOY_DELAY_SECONDS + HGA_DEPLOY_SECONDS * 2, pose);
    assert.equal(hga.phase, "tracking");
    return hga;
  }

  test("keeps the boresight on Earth through any rover attitude", () => {
    for (const yaw of [0, Math.PI / 2, Math.PI, -2.3]) {
      for (const pitch of [-0.2, 0, 0.25]) {
        for (const roll of [-0.15, 0, 0.2]) {
          const pose = { yaw, pitch, roll };
          const hga = tracking(pose);
          assert.ok(boresightError(hga, pose) < 0.5 * (Math.PI / 180));
        }
      }
    }
  });

  test("re-aims when the rover moves — at the slew limit, never a snap", () => {
    const hga = tracking();
    const before = hga.azimuth;
    // Spin the rover 150° in one frame (a teleport, worst case) and watch the gimbals chase.
    let maxStep = 0;
    let prevAz = hga.azimuth;
    let prevEl = hga.elevation;
    let steps = 0;
    for (let t = 0; t < 10 && boresightError(hga, { yaw: (150 * Math.PI) / 180, pitch: 0, roll: 0 }) > 0.6 * (Math.PI / 180); t += DT) {
      hga.update(DT, { yaw: (150 * Math.PI) / 180, pitch: 0, roll: 0 });
      maxStep = Math.max(maxStep, Math.abs(hga.azimuth - prevAz), Math.abs(hga.elevation - prevEl));
      prevAz = hga.azimuth;
      prevEl = hga.elevation;
      steps++;
    }
    assert.ok(steps > 10); // it took real time…
    assert.ok(maxStep < HGA_SLEW_RATE * DT + 1e-4); // …at the mechanical rate
    assert.ok(boresightError(hga, { yaw: (150 * Math.PI) / 180, pitch: 0, roll: 0 }) < 0.6 * (Math.PI / 180));
    assertNotCloseTo(hga.azimuth, before, 3); // the gimbal actually moved
  });

  test("clamps elevation so the dish clears the deck and never crosses zenith", () => {
    const DEG = Math.PI / 180;
    // Left side down ~50° (negative roll lifts the right side) swings Earth's local elevation to
    // ≈ −75°: the floor holds the dish off the deck instead of tracking into the rover.
    const leftDown = tracking({ yaw: 0, pitch: 0, roll: 50 * DEG });
    assertCloseTo(leftDown.targetElevation, HGA_MIN_ELEVATION, 6);
    assert.ok(leftDown.elevation >= HGA_MIN_ELEVATION - 1e-9);
    // Attitudes can push Earth's local elevation high (≈84° at the extreme for this Earth
    // direction) but the ceiling must hold everywhere: sweep hard poses and check both bounds.
    let seed = 777;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 400; i++) {
      const hga = new HighGainAntennaController();
      hga.arm();
      const pose = { yaw: rand() * 6.2832 - 3.1416, pitch: (rand() * 130 - 65) * DEG, roll: (rand() * 130 - 65) * DEG };
      run(hga, HGA_DEPLOY_DELAY_SECONDS + HGA_DEPLOY_SECONDS * 2, pose);
      assert.ok(hga.targetElevation <= HGA_MAX_ELEVATION + 1e-9);
      assert.ok(hga.targetElevation >= HGA_MIN_ELEVATION - 1e-9);
      assert.ok(hga.elevation <= HGA_MAX_ELEVATION + 1e-6);
      assert.ok(hga.elevation >= HGA_MIN_ELEVATION - 1e-6);
    }
  });

  test("never stows: hammering it with attitudes and time cannot leave tracking", () => {
    const hga = tracking();
    let seed = 12345;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 2000; i++) {
      hga.update(DT, { yaw: rand() * 6.28 - 3.14, pitch: rand() - 0.5, roll: rand() - 0.5 });
      assert.equal(hga.phase, "tracking");
    }
    // The API surface is one-way too: no stow, no disarm.
    assert.equal(Object.getOwnPropertyNames(Object.getPrototypeOf(hga)).some((m) => /stow|disarm/i.test(m)), false);
  });
});

await finish();
