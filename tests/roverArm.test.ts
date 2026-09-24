/**
 * Perseverance robotic arm controller (examples/src/scenes/roverArm.ts): the unfold/stow
 * choreography, jogging, joint limits, the wrist auto-level and the ground guard — all pure state,
 * so the whole behaviour the Mars showcase shows is pinned here without a GPU.
 */
import { describe, expect, it } from "vitest";
import {
  ARM_DEPLOY_SECONDS,
  ARM_JOINT_COUNT,
  ARM_MIN_TURRET_HEIGHT,
  ARM_READY_DEG,
  ARM_STOWED_UPPER_ARM_DEG,
  RoverArmController,
  choreographyAngle,
  jogWeight,
  turretJointHeight,
  type ArmJogInput,
} from "../examples/src/scenes/roverArm.js";

const DT = 1 / 60;
const DEG = Math.PI / 180;
const IDLE: ArmJogInput = { swing: 0, shoulder: 0, elbow: 0, turret: 0 };

function step(arm: RoverArmController, seconds: number, input: ArmJogInput | null = null): void {
  for (let t = 0; t < seconds; t += DT) arm.update(DT, input);
}

function unfolded(): RoverArmController {
  const arm = new RoverArmController();
  arm.setDeployed(true);
  step(arm, ARM_DEPLOY_SECONDS + 1);
  expect(arm.unfolded).toBe(true);
  return arm;
}

const degrees = (arm: RoverArmController): number[] => Array.from(arm.pose(), (v) => v / DEG);
/** Turret axis pitch in the arm plane (0 = level): stowed it is vertical, 90°. */
const turretPitch = (q: number[]): number => 90 + q[1]! + q[2]! + q[3]!;

describe("RoverArmController — unfold / stow choreography", () => {
  it("starts stowed: zero pose, no progress, sticks not live", () => {
    const arm = new RoverArmController();
    expect(arm.progress).toBe(0);
    expect(arm.deployed).toBe(false);
    expect(arm.unfolded).toBe(false);
    expect(degrees(arm)).toEqual([0, 0, 0, 0, 0]);
    expect(arm.update(DT, IDLE)).toBe(false); // nothing to do, nothing changed
  });

  it("unfolds into the ready pose: forward, upper arm 35° up, turret level, drill down", () => {
    const arm = unfolded();
    const q = degrees(arm);
    for (let j = 0; j < ARM_JOINT_COUNT; j++) expect(q[j]).toBeCloseTo(ARM_READY_DEG[j]!, 9);
    expect(q[0]).toBeCloseTo(90, 9); // swung from across the nose to straight ahead
    expect(q[1]! + ARM_STOWED_UPPER_ARM_DEG).toBeCloseTo(35, 9);
    expect(turretPitch(q)).toBeCloseTo(0, 9);
    expect(q[4]).toBeCloseTo(-90, 9);
    // The elbow opens the long way round (up and over), not the short way through the ground.
    expect(q[2]).toBeLessThan(-180);
  });

  it("takes about ARM_DEPLOY_SECONDS and moves every joint smoothly (no snaps)", () => {
    const arm = new RoverArmController();
    arm.setDeployed(true);
    let prev = degrees(arm);
    let maxStep = 0;
    let seconds = 0;
    while (!arm.unfolded && seconds < 20) {
      arm.update(DT, null);
      seconds += DT;
      const q = degrees(arm);
      for (let j = 0; j < ARM_JOINT_COUNT; j++) maxStep = Math.max(maxStep, Math.abs(q[j]! - prev[j]!));
      prev = q;
    }
    expect(seconds).toBeGreaterThan(ARM_DEPLOY_SECONDS);
    expect(seconds).toBeLessThan(ARM_DEPLOY_SECONDS + 0.5);
    // The fastest joint (the elbow's 217° sweep) peaks near 2°/frame at 60 Hz.
    expect(maxStep).toBeLessThan(3);
  });

  it("lifts the turret off the deck before swinging, with the shoulder still", () => {
    // Pitching the shoulder while stowed cuts the upper arm into the front housing.
    const lift = [0, 1, 2, 3, 4].map((j) => choreographyAngle(j, 0.15) / DEG);
    expect(lift[0]).toBeCloseTo(0, 9); // no swing yet
    expect(lift[1]).toBeCloseTo(0, 9); // shoulder still
    expect(lift[2]).toBeLessThan(-20); // elbow opened
    expect(turretPitch(lift)).toBeCloseTo(90, 9); // turret rose without tilting
    expect(turretJointHeight(lift[1]! * DEG, lift[2]! * DEG, lift[3]! * DEG)).toBeGreaterThan(turretJointHeight(0, 0, 0) + 0.2);
  });

  it("eases through a mid-way reversal and stows back to exactly zero", () => {
    const arm = new RoverArmController();
    arm.setDeployed(true);
    step(arm, 2.5);
    const at = arm.progress;
    expect(at).toBeGreaterThan(0.2);
    expect(at).toBeLessThan(0.6);
    arm.setDeployed(false);
    let prev = degrees(arm);
    let maxStep = 0;
    let peak = at;
    for (let t = 0; t < ARM_DEPLOY_SECONDS + 1; t += DT) {
      arm.update(DT, null);
      peak = Math.max(peak, arm.progress);
      const q = degrees(arm);
      for (let j = 0; j < ARM_JOINT_COUNT; j++) maxStep = Math.max(maxStep, Math.abs(q[j]! - prev[j]!));
      prev = q;
    }
    expect(peak).toBeGreaterThan(at); // coasted on briefly instead of reversing instantly
    expect(peak - at).toBeLessThan(0.05);
    expect(maxStep).toBeLessThan(3);
    expect(arm.progress).toBe(0);
    expect(degrees(arm)).toEqual([0, 0, 0, 0, 0]);
  });
});

describe("RoverArmController — jogging", () => {
  it("ignores stick input until fully unfolded", () => {
    const arm = new RoverArmController();
    arm.setDeployed(true);
    step(arm, 3, { swing: 1, shoulder: 1, elbow: 1, turret: 1 });
    expect(arm.unfolded).toBe(false);
    for (let j = 0; j < ARM_JOINT_COUNT; j++) expect(arm.jogDegrees(j)).toBe(0);
  });

  it("drives each joint at its rate from the matching axis", () => {
    const arm = unfolded();
    step(arm, 1, { swing: 1, shoulder: 0, elbow: 0, turret: 0 });
    // 30°/s after a ~0.14 s smoothing lag.
    expect(arm.jogDegrees(0)).toBeGreaterThan(24);
    expect(arm.jogDegrees(0)).toBeLessThan(30);
    expect(arm.jogDegrees(1)).toBe(0);
    expect(arm.jogDegrees(2)).toBe(0);
    step(arm, 1, { swing: 0, shoulder: 0, elbow: 0, turret: 1 });
    expect(arm.jogDegrees(4)).toBeLessThan(-45); // + stick = clockwise from behind = negative spin
  });

  it("coasts to a stop instead of halting dead when the stick is released", () => {
    const arm = unfolded();
    step(arm, 1, { swing: 1, shoulder: 0, elbow: 0, turret: 0 });
    const released = arm.jogDegrees(0);
    step(arm, 1, IDLE);
    const coast = arm.jogDegrees(0) - released;
    expect(coast).toBeGreaterThan(1);
    expect(coast).toBeLessThan(6);
    const settled = arm.jogDegrees(0);
    expect(arm.update(DT, IDLE)).toBe(false);
    expect(arm.jogDegrees(0)).toBe(settled);
  });

  it("keeps the turret's pitch (drill pointing down) while the shoulder and elbow move", () => {
    const arm = unfolded();
    step(arm, 1.5, { swing: 0, shoulder: 1, elbow: -0.5, turret: 0 });
    const q = degrees(arm);
    expect(Math.abs(arm.jogDegrees(1))).toBeGreaterThan(10);
    expect(Math.abs(arm.jogDegrees(2))).toBeGreaterThan(5);
    expect(turretPitch(q)).toBeCloseTo(0, 6);
  });

  it("stops at the joint limits", () => {
    const arm = unfolded();
    step(arm, 6, { swing: 1, shoulder: 1, elbow: 1, turret: 1 });
    let q = degrees(arm);
    expect(q[0]).toBeCloseTo(150, 6); // swung 60° right of straight ahead
    expect(q[1]! + ARM_STOWED_UPPER_ARM_DEG).toBeCloseTo(75, 6); // upper arm limit
    expect(q[4]).toBeCloseTo(-270, 6); // turret spin limit
    step(arm, 12, { swing: -1, shoulder: 0, elbow: 0, turret: -1 });
    q = degrees(arm);
    expect(q[0]).toBeCloseTo(30, 6);
    expect(q[4]).toBeCloseTo(90, 6);
  });

  it("will not jog the turret into the ground", () => {
    const arm = unfolded();
    step(arm, 12, { swing: 0, shoulder: -1, elbow: -1, turret: 0 });
    const q = arm.pose();
    const height = turretJointHeight(q[1]!, q[2]!, q[3]!);
    expect(height).toBeGreaterThanOrEqual(ARM_MIN_TURRET_HEIGHT - 1e-9);
    expect(height).toBeLessThan(ARM_MIN_TURRET_HEIGHT + 0.05); // it did go all the way down to the guard
    // …and can climb straight back out.
    step(arm, 1, { swing: 0, shoulder: 1, elbow: 0, turret: 0 });
    const up = arm.pose();
    expect(turretJointHeight(up[1]!, up[2]!, up[3]!)).toBeGreaterThan(height + 0.05);
  });

  it("fades the jog out on the way in and unfolds to the ready pose again next time", () => {
    const arm = unfolded();
    step(arm, 2, { swing: -1, shoulder: -0.5, elbow: 1, turret: 1 });
    expect(Math.abs(arm.jogDegrees(0))).toBeGreaterThan(20);
    arm.setDeployed(false);
    while (arm.progress > 0.5) arm.update(DT, null);
    // Past the fade, the pose is pure choreography: the path home is the unfold path.
    const t = arm.progress;
    const q = arm.pose();
    for (let j = 0; j < ARM_JOINT_COUNT; j++) expect(q[j]).toBeCloseTo(choreographyAngle(j, t), 9);
    step(arm, ARM_DEPLOY_SECONDS);
    expect(degrees(arm)).toEqual([0, 0, 0, 0, 0]);
    arm.setDeployed(true);
    step(arm, ARM_DEPLOY_SECONDS + 1);
    const again = degrees(arm);
    for (let j = 0; j < ARM_JOINT_COUNT; j++) expect(again[j]).toBeCloseTo(ARM_READY_DEG[j]!, 9);
  });
});

describe("roverArm geometry helpers", () => {
  it("jogWeight is 1 unfolded, 0 from mid-stow down, monotonic between", () => {
    expect(jogWeight(1)).toBe(1);
    expect(jogWeight(0.5)).toBe(0);
    expect(jogWeight(0)).toBe(0);
    expect(jogWeight(0.75)).toBeCloseTo(0.5, 9);
    for (let t = 0.5; t < 1; t += 0.01) expect(jogWeight(t + 0.01)).toBeGreaterThanOrEqual(jogWeight(t));
  });

  it("turretJointHeight reproduces the model: 1.228 m stowed, ~0.94 m in the ready pose", () => {
    expect(turretJointHeight(0, 0, 0)).toBeCloseTo(1.228, 3);
    expect(turretJointHeight(ARM_READY_DEG[1]! * DEG, ARM_READY_DEG[2]! * DEG, ARM_READY_DEG[3]! * DEG)).toBeCloseTo(0.936, 2);
  });
});
