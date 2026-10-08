/**
 * @suite examples:roverArm
 * @group integration
 * @covers examples/src/scenes/roverArm.ts
 * @desc Perseverance robotic arm controller (examples/src/scenes/roverArm.ts): the unfold/stow
 */

export const suite = {
  name: "examples:roverArm",
  group: "integration",
  covers:   [
    "examples/src/scenes/roverArm.ts"
  ],
  desc: "Perseverance robotic arm controller (examples/src/scenes/roverArm.ts): the unfold/stow",
};
/**
 * Perseverance robotic arm controller (examples/src/scenes/roverArm.ts): the unfold/stow
 * choreography, jogging, joint limits, the wrist auto-level and the ground guard — all pure state,
 * so the whole behaviour the Mars showcase shows is pinned here without a GPU.
 */
import assert from "node:assert/strict";
import { assertCloseTo, finish, group, test } from "selrun";
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
} from "../../examples/src/scenes/roverArm.js";

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
  assert.equal(arm.unfolded, true);
  return arm;
}

const degrees = (arm: RoverArmController): number[] => Array.from(arm.pose(), (v) => v / DEG);
/** Turret axis pitch in the arm plane (0 = level): stowed it is vertical, 90°. */
const turretPitch = (q: number[]): number => 90 + q[1]! + q[2]! + q[3]!;

group("RoverArmController — unfold / stow choreography", () => {
  test("starts stowed: zero pose, no progress, sticks not live", () => {
    const arm = new RoverArmController();
    assert.equal(arm.progress, 0);
    assert.equal(arm.deployed, false);
    assert.equal(arm.unfolded, false);
    assert.deepEqual(degrees(arm), [0, 0, 0, 0, 0]);
    assert.equal(arm.update(DT, IDLE), false); // nothing to do, nothing changed
  });

  test("unfolds into the ready pose: forward, upper arm 35° up, turret level, drill down", () => {
    const arm = unfolded();
    const q = degrees(arm);
    for (let j = 0; j < ARM_JOINT_COUNT; j++) assertCloseTo(q[j], ARM_READY_DEG[j]!, 9);
    assertCloseTo(q[0], 90, 9); // swung from across the nose to straight ahead
    assertCloseTo(q[1]! + ARM_STOWED_UPPER_ARM_DEG, 35, 9);
    assertCloseTo(turretPitch(q), 0, 9);
    assertCloseTo(q[4], -90, 9);
    // The elbow opens the long way round (up and over), not the short way through the ground.
    assert.ok(q[2] < -180);
  });

  test("takes about ARM_DEPLOY_SECONDS and moves every joint smoothly (no snaps)", () => {
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
    assert.ok(seconds > ARM_DEPLOY_SECONDS);
    assert.ok(seconds < ARM_DEPLOY_SECONDS + 0.5);
    // The fastest joint (the elbow's 217° sweep) peaks near 2°/frame at 60 Hz.
    assert.ok(maxStep < 3);
  });

  test("lifts the turret off the deck before swinging, with the shoulder still", () => {
    // Pitching the shoulder while stowed cuts the upper arm into the front housing.
    const lift = [0, 1, 2, 3, 4].map((j) => choreographyAngle(j, 0.15) / DEG);
    assertCloseTo(lift[0], 0, 9); // no swing yet
    assertCloseTo(lift[1], 0, 9); // shoulder still
    assert.ok(lift[2] < -20); // elbow opened
    assertCloseTo(turretPitch(lift), 90, 9); // turret rose without tilting
    assert.ok(turretJointHeight(lift[1]! * DEG, lift[2]! * DEG, lift[3]! * DEG) > turretJointHeight(0, 0, 0) + 0.2);
  });

  test("eases through a mid-way reversal and stows back to exactly zero", () => {
    const arm = new RoverArmController();
    arm.setDeployed(true);
    step(arm, 2.5);
    const at = arm.progress;
    assert.ok(at > 0.2);
    assert.ok(at < 0.6);
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
    assert.ok(peak > at); // coasted on briefly instead of reversing instantly
    assert.ok(peak - at < 0.05);
    assert.ok(maxStep < 3);
    assert.equal(arm.progress, 0);
    assert.deepEqual(degrees(arm), [0, 0, 0, 0, 0]);
  });
});

group("RoverArmController — jogging", () => {
  test("ignores stick input until fully unfolded", () => {
    const arm = new RoverArmController();
    arm.setDeployed(true);
    step(arm, 3, { swing: 1, shoulder: 1, elbow: 1, turret: 1 });
    assert.equal(arm.unfolded, false);
    for (let j = 0; j < ARM_JOINT_COUNT; j++) assert.equal(arm.jogDegrees(j), 0);
  });

  test("drives each joint at its rate from the matching axis", () => {
    const arm = unfolded();
    step(arm, 1, { swing: 1, shoulder: 0, elbow: 0, turret: 0 });
    // 30°/s after a ~0.14 s smoothing lag.
    assert.ok(arm.jogDegrees(0) > 24);
    assert.ok(arm.jogDegrees(0) < 30);
    assert.equal(arm.jogDegrees(1), 0);
    assert.equal(arm.jogDegrees(2), 0);
    step(arm, 1, { swing: 0, shoulder: 0, elbow: 0, turret: 1 });
    assert.ok(arm.jogDegrees(4) < -45); // + stick = clockwise from behind = negative spin
  });

  test("coasts to a stop instead of halting dead when the stick is released", () => {
    const arm = unfolded();
    step(arm, 1, { swing: 1, shoulder: 0, elbow: 0, turret: 0 });
    const released = arm.jogDegrees(0);
    step(arm, 1, IDLE);
    const coast = arm.jogDegrees(0) - released;
    assert.ok(coast > 1);
    assert.ok(coast < 6);
    const settled = arm.jogDegrees(0);
    assert.equal(arm.update(DT, IDLE), false);
    assert.equal(arm.jogDegrees(0), settled);
  });

  test("keeps the turret's pitch (drill pointing down) while the shoulder and elbow move", () => {
    const arm = unfolded();
    step(arm, 1.5, { swing: 0, shoulder: 1, elbow: -0.5, turret: 0 });
    const q = degrees(arm);
    assert.ok(Math.abs(arm.jogDegrees(1)) > 10);
    assert.ok(Math.abs(arm.jogDegrees(2)) > 5);
    assertCloseTo(turretPitch(q), 0, 6);
  });

  test("stops at the joint limits", () => {
    const arm = unfolded();
    step(arm, 6, { swing: 1, shoulder: 1, elbow: 1, turret: 1 });
    let q = degrees(arm);
    assertCloseTo(q[0], 150, 6); // swung 60° right of straight ahead
    assertCloseTo(q[1]! + ARM_STOWED_UPPER_ARM_DEG, 75, 6); // upper arm limit
    assertCloseTo(q[4], -270, 6); // turret spin limit
    step(arm, 12, { swing: -1, shoulder: 0, elbow: 0, turret: -1 });
    q = degrees(arm);
    assertCloseTo(q[0], 30, 6);
    assertCloseTo(q[4], 90, 6);
  });

  test("will not jog the turret into the ground", () => {
    const arm = unfolded();
    step(arm, 12, { swing: 0, shoulder: -1, elbow: -1, turret: 0 });
    const q = arm.pose();
    const height = turretJointHeight(q[1]!, q[2]!, q[3]!);
    assert.ok(height >= ARM_MIN_TURRET_HEIGHT - 1e-9);
    assert.ok(height < ARM_MIN_TURRET_HEIGHT + 0.05); // it did go all the way down to the guard
    // …and can climb straight back out.
    step(arm, 1, { swing: 0, shoulder: 1, elbow: 0, turret: 0 });
    const up = arm.pose();
    assert.ok(turretJointHeight(up[1]!, up[2]!, up[3]!) > height + 0.05);
  });

  test("fades the jog out on the way in and unfolds to the ready pose again next time", () => {
    const arm = unfolded();
    step(arm, 2, { swing: -1, shoulder: -0.5, elbow: 1, turret: 1 });
    assert.ok(Math.abs(arm.jogDegrees(0)) > 20);
    arm.setDeployed(false);
    while (arm.progress > 0.5) arm.update(DT, null);
    // Past the fade, the pose is pure choreography: the path home is the unfold path.
    const t = arm.progress;
    const q = arm.pose();
    for (let j = 0; j < ARM_JOINT_COUNT; j++) assertCloseTo(q[j], choreographyAngle(j, t), 9);
    step(arm, ARM_DEPLOY_SECONDS);
    assert.deepEqual(degrees(arm), [0, 0, 0, 0, 0]);
    arm.setDeployed(true);
    step(arm, ARM_DEPLOY_SECONDS + 1);
    const again = degrees(arm);
    for (let j = 0; j < ARM_JOINT_COUNT; j++) assertCloseTo(again[j], ARM_READY_DEG[j]!, 9);
  });
});

group("roverArm geometry helpers", () => {
  test("jogWeight is 1 unfolded, 0 from mid-stow down, monotonic between", () => {
    assert.equal(jogWeight(1), 1);
    assert.equal(jogWeight(0.5), 0);
    assert.equal(jogWeight(0), 0);
    assertCloseTo(jogWeight(0.75), 0.5, 9);
    for (let t = 0.5; t < 1; t += 0.01) assert.ok(jogWeight(t + 0.01) >= jogWeight(t));
  });

  test("turretJointHeight reproduces the model: 1.228 m stowed, ~0.94 m in the ready pose", () => {
    assertCloseTo(turretJointHeight(0, 0, 0), 1.228, 3);
    assertCloseTo(turretJointHeight(ARM_READY_DEG[1]! * DEG, ARM_READY_DEG[2]! * DEG, ARM_READY_DEG[3]! * DEG), 0.936, 2);
  });
});

await finish();
