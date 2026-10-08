/** Pure kinematics, action planning and low-probability drilling fracture rules for rover tools. */
import { describe, expect, it } from "vitest";
import { ARM_JOINT_COUNT, ARM_READY_DEG } from "../examples/src/scenes/roverArm.js";
import {
  DRILLED_ROCK_SPLIT_CHANCE,
  ROVER_TOOL_SPECS,
  isEligibleDrillSplit,
  roverToolPointFromPose,
  roverToolServoInput,
  roverToolWorldPoint,
  shouldSplitRockDuringDrilling,
  solveArmPoseForToolPoint,
  worldPointToRoverLocal,
} from "../examples/src/scenes/roverTools.js";

const DEG = Math.PI / 180;
const readyPose = Float64Array.from(ARM_READY_DEG, (angle) => angle * DEG);

describe("Perseverance turret tool kinematics", () => {
  it("solves each instrument's own mount offset back to the same ready-pose contact point", () => {
    for (const action of ["drill", "abrade", "analyze"] as const) {
      const point = roverToolPointFromPose(readyPose, action);
      const solved = solveArmPoseForToolPoint(point, action, new Float64Array(ARM_JOINT_COUNT));
      expect(solved, `${action} should reach its own ready-pose tip`).not.toBeNull();
      const actual = roverToolPointFromPose(solved!, action);
      expect(actual.right).toBeCloseTo(point.right, 2);
      expect(actual.forward).toBeCloseTo(point.forward, 2);
      expect(actual.height).toBeCloseTo(point.height, 2);
      expect(solved![4]).toBeCloseTo(ROVER_TOOL_SPECS[action].turretDeg * DEG, 8);
    }
  });

  it("rejects targets outside the safe arm envelope", () => {
    const solved = solveArmPoseForToolPoint(
      { right: 50, forward: 50, height: 2 },
      "drill",
      new Float64Array(ARM_JOINT_COUNT),
    );
    expect(solved).toBeNull();
  });

  it("never returns pitch angles that the controller would clamp away from a reachable target", () => {
    const target = { right: 0, forward: 2.3, height: 0.588 };
    const elbowMin = (ARM_READY_DEG[2]! - 40) * DEG;
    const elbowMax = (ARM_READY_DEG[2]! + 70) * DEG;
    for (const action of ["drill", "abrade", "analyze"] as const) {
      const solved = solveArmPoseForToolPoint(target, action, new Float64Array(ARM_JOINT_COUNT));
      expect(solved, `${action} should reach the fixture's near-forward surface`).not.toBeNull();
      expect(solved![2]).toBeGreaterThanOrEqual(elbowMin - 1e-8);
      expect(solved![2]).toBeLessThanOrEqual(elbowMax + 1e-8);
    }
  });

  it("round-trips chassis-local tool points through world space at arbitrary yaw", () => {
    const point = roverToolPointFromPose(readyPose, "drill");
    for (const yaw of [0, Math.PI / 2, -0.73, Math.PI]) {
      const world = roverToolWorldPoint(point, -12, 4.5, 31, yaw);
      const local = worldPointToRoverLocal(world.x, world.y, world.z, -12, 4.5, 31, yaw);
      expect(local.right).toBeCloseTo(point.right, 8);
      expect(local.forward).toBeCloseTo(point.forward, 8);
      expect(local.height).toBeCloseTo(point.height, 8);
    }
  });

  it("servos joint errors in the correct direction and clamps each command to one", () => {
    const current = readyPose.slice();
    const target = readyPose.slice();
    current[0]! -= 0.5;
    current[1]! -= 0.25;
    current[2]! += 0.4;
    current[4]! = 0;
    const input = { swing: 0, shoulder: 0, elbow: 0, turret: 0 };
    roverToolServoInput(current, target, input);
    expect(input.swing).toBeGreaterThan(0);
    expect(input.shoulder).toBeGreaterThan(0);
    expect(input.elbow).toBeLessThan(0);
    expect(input.turret).toBeGreaterThan(0); // positive controller input decreases turret spin
    expect(Math.max(Math.abs(input.swing), Math.abs(input.shoulder), Math.abs(input.elbow), Math.abs(input.turret))).toBe(1);
  });
});

describe("drilling fracture eligibility", () => {
  it("only considers genuinely small or thin rocks eligible", () => {
    expect(isEligibleDrillSplit({ id: "small", radius: 0.32, isFlat: false, thickness: 0.64 })).toBe(true);
    expect(isEligibleDrillSplit({ id: "thin", radius: 0.8, isFlat: true, thickness: 0.22 })).toBe(true);
    expect(isEligibleDrillSplit({ id: "large", radius: 0.8, isFlat: false, thickness: 1.6 })).toBe(false);
    expect(isEligibleDrillSplit({ id: "thick-slab", radius: 0.8, isFlat: true, thickness: 0.23 })).toBe(false);
  });

  it("uses a repeatable small chance per eligible drill attempt", () => {
    expect(DRILLED_ROCK_SPLIT_CHANCE).toBe(0.08);
    const small = { id: "stable-rock-id", radius: 0.28, isFlat: false, thickness: 0.56 };
    expect(shouldSplitRockDuringDrilling(small, 3)).toBe(shouldSplitRockDuringDrilling(small, 3));
    for (let attempt = 0; attempt < 100; attempt++) {
      expect(shouldSplitRockDuringDrilling({ id: "too-large", radius: 0.9, isFlat: false, thickness: 1.8 }, attempt)).toBe(false);
    }
    let splits = 0;
    for (let i = 0; i < 1000; i++) {
      if (shouldSplitRockDuringDrilling({ ...small, id: `sample-${i}` }, 0)) splits++;
    }
    expect(splits).toBeGreaterThan(45);
    expect(splits).toBeLessThan(115);
  });
});
