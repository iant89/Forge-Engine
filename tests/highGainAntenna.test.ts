/**
 * High-gain antenna: the one-way deploy (armed when the model lands, unfurl
 * `HGA_DEPLOY_DELAY_SECONDS` later) and the Earth tracking (world-space target, slew-limited
 * gimbals, elevation clamps, no stow path anywhere).
 */
import { describe, expect, it } from "vitest";
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
} from "../examples/src/scenes/highGainAntenna.js";

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

describe("HighGainAntennaController — one-way deployment", () => {
  it("holds stowed until armed, however long it runs", () => {
    const hga = new HighGainAntennaController();
    expect(run(hga, 120)).toBe(0);
    expect(hga.phase).toBe("stowed");
    expect(hga.azimuth).toBe(HGA_STOWED_AZIMUTH);
    expect(hga.elevation).toBe(HGA_STOWED_ELEVATION);
  });

  it("starts unfurling only after the delay, and counts it down", () => {
    const hga = new HighGainAntennaController();
    hga.arm();
    run(hga, HGA_DEPLOY_DELAY_SECONDS - 0.05);
    expect(hga.phase).toBe("stowed");
    expect(hga.countdown).toBeCloseTo(0.05, 3);
    run(hga, 0.1);
    expect(hga.phase).toBe("deploying");
    expect(hga.countdown).toBe(0);
  });

  it("finishes the unfurl in about HGA_DEPLOY_SECONDS and points at Earth", () => {
    const hga = new HighGainAntennaController();
    hga.arm();
    run(hga, HGA_DEPLOY_DELAY_SECONDS + HGA_DEPLOY_SECONDS * 0.5);
    expect(hga.phase).toBe("deploying");
    run(hga, HGA_DEPLOY_SECONDS * 2);
    expect(hga.phase).toBe("tracking");
    expect(hga.deployed).toBe(true);
    expect(boresightError(hga)).toBeLessThan(0.5 * (Math.PI / 180));
  });

  it("deploy motion is mechanical: no gimbal ever snaps", () => {
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
    expect(maxStep).toBeLessThan((HGA_DEPLOY_RATE * DT) + 1e-4);
  });
});

describe("HighGainAntennaController — Earth tracking", () => {
  function tracking(pose = LEVEL): HighGainAntennaController {
    const hga = new HighGainAntennaController();
    hga.arm();
    run(hga, HGA_DEPLOY_DELAY_SECONDS + HGA_DEPLOY_SECONDS * 2, pose);
    expect(hga.phase).toBe("tracking");
    return hga;
  }

  it("keeps the boresight on Earth through any rover attitude", () => {
    for (const yaw of [0, Math.PI / 2, Math.PI, -2.3]) {
      for (const pitch of [-0.2, 0, 0.25]) {
        for (const roll of [-0.15, 0, 0.2]) {
          const pose = { yaw, pitch, roll };
          const hga = tracking(pose);
          expect(boresightError(hga, pose)).toBeLessThan(0.5 * (Math.PI / 180));
        }
      }
    }
  });

  it("re-aims when the rover moves — at the slew limit, never a snap", () => {
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
    expect(steps).toBeGreaterThan(10); // it took real time…
    expect(maxStep).toBeLessThan(HGA_SLEW_RATE * DT + 1e-4); // …at the mechanical rate
    expect(boresightError(hga, { yaw: (150 * Math.PI) / 180, pitch: 0, roll: 0 })).toBeLessThan(0.6 * (Math.PI / 180));
    expect(hga.azimuth).not.toBeCloseTo(before, 3); // the gimbal actually moved
  });

  it("clamps elevation so the dish clears the deck and never crosses zenith", () => {
    const DEG = Math.PI / 180;
    // Left side down ~50° (negative roll lifts the right side) swings Earth's local elevation to
    // ≈ −75°: the floor holds the dish off the deck instead of tracking into the rover.
    const leftDown = tracking({ yaw: 0, pitch: 0, roll: 50 * DEG });
    expect(leftDown.targetElevation).toBeCloseTo(HGA_MIN_ELEVATION, 6);
    expect(leftDown.elevation).toBeGreaterThanOrEqual(HGA_MIN_ELEVATION - 1e-9);
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
      expect(hga.targetElevation).toBeLessThanOrEqual(HGA_MAX_ELEVATION + 1e-9);
      expect(hga.targetElevation).toBeGreaterThanOrEqual(HGA_MIN_ELEVATION - 1e-9);
      expect(hga.elevation).toBeLessThanOrEqual(HGA_MAX_ELEVATION + 1e-6);
      expect(hga.elevation).toBeGreaterThanOrEqual(HGA_MIN_ELEVATION - 1e-6);
    }
  });

  it("never stows: hammering it with attitudes and time cannot leave tracking", () => {
    const hga = tracking();
    let seed = 12345;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 2000; i++) {
      hga.update(DT, { yaw: rand() * 6.28 - 3.14, pitch: rand() - 0.5, roll: rand() - 0.5 });
      expect(hga.phase).toBe("tracking");
    }
    // The API surface is one-way too: no stow, no disarm.
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(hga)).some((m) => /stow|disarm/i.test(m))).toBe(false);
  });
});
