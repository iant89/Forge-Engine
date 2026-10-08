/**
 * @suite examples:roverTools
 * @group integration
 * @covers examples/src/scenes/roverArm.ts
 * @covers examples/src/scenes/roverTools.ts
 * @desc Pure kinematics, action planning and low-probability drilling fracture rules for rover tools
 */

export const suite = {
  name: "examples:roverTools",
  group: "integration",
  covers:   [
    "examples/src/scenes/roverArm.ts",
    "examples/src/scenes/roverTools.ts"
  ],
  desc: "Pure kinematics, action planning and low-probability drilling fracture rules for rover tools",
};
/** Pure kinematics, action planning and low-probability drilling fracture rules for rover tools. */
import assert from "node:assert/strict";
import { assertCloseTo, finish, group, test } from "selrun";
import { ARM_JOINT_COUNT, ARM_READY_DEG } from "../../examples/src/scenes/roverArm.js";
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
} from "../../examples/src/scenes/roverTools.js";

const DEG = Math.PI / 180;
const readyPose = Float64Array.from(ARM_READY_DEG, (angle) => angle * DEG);

group("Perseverance turret tool kinematics", () => {
  test("solves each instrument's own mount offset back to the same ready-pose contact point", () => {
    for (const action of ["drill", "abrade", "analyze"] as const) {
      const point = roverToolPointFromPose(readyPose, action);
      const solved = solveArmPoseForToolPoint(point, action, new Float64Array(ARM_JOINT_COUNT));
      assert.notEqual(solved, null, `${action} should reach its own ready-pose tip`);
      const actual = roverToolPointFromPose(solved!, action);
      assertCloseTo(actual.right, point.right, 2);
      assertCloseTo(actual.forward, point.forward, 2);
      assertCloseTo(actual.height, point.height, 2);
      assertCloseTo(solved![4], ROVER_TOOL_SPECS[action].turretDeg * DEG, 8);
    }
  });

  test("rejects targets outside the safe arm envelope", () => {
    const solved = solveArmPoseForToolPoint(
      { right: 50, forward: 50, height: 2 },
      "drill",
      new Float64Array(ARM_JOINT_COUNT),
    );
    assert.equal(solved, null);
  });

  test("never returns pitch angles that the controller would clamp away from a reachable target", () => {
    const target = { right: 0, forward: 2.3, height: 0.588 };
    const elbowMin = (ARM_READY_DEG[2]! - 40) * DEG;
    const elbowMax = (ARM_READY_DEG[2]! + 70) * DEG;
    for (const action of ["drill", "abrade", "analyze"] as const) {
      const solved = solveArmPoseForToolPoint(target, action, new Float64Array(ARM_JOINT_COUNT));
      assert.notEqual(solved, null, `${action} should reach the fixture's near-forward surface`);
      assert.ok(solved![2] >= elbowMin - 1e-8);
      assert.ok(solved![2] <= elbowMax + 1e-8);
    }
  });

  test("round-trips chassis-local tool points through world space at arbitrary yaw", () => {
    const point = roverToolPointFromPose(readyPose, "drill");
    for (const yaw of [0, Math.PI / 2, -0.73, Math.PI]) {
      const world = roverToolWorldPoint(point, -12, 4.5, 31, yaw);
      const local = worldPointToRoverLocal(world.x, world.y, world.z, -12, 4.5, 31, yaw);
      assertCloseTo(local.right, point.right, 8);
      assertCloseTo(local.forward, point.forward, 8);
      assertCloseTo(local.height, point.height, 8);
    }
  });

  test("servos joint errors in the correct direction and clamps each command to one", () => {
    const current = readyPose.slice();
    const target = readyPose.slice();
    current[0]! -= 0.5;
    current[1]! -= 0.25;
    current[2]! += 0.4;
    current[4]! = 0;
    const input = { swing: 0, shoulder: 0, elbow: 0, turret: 0 };
    roverToolServoInput(current, target, input);
    assert.ok(input.swing > 0);
    assert.ok(input.shoulder > 0);
    assert.ok(input.elbow < 0);
    assert.ok(input.turret > 0); // positive controller input decreases turret spin
    assert.equal(Math.max(Math.abs(input.swing), Math.abs(input.shoulder), Math.abs(input.elbow), Math.abs(input.turret)), 1);
  });
});

group("drilling fracture eligibility", () => {
  test("only considers genuinely small or thin rocks eligible", () => {
    assert.equal(isEligibleDrillSplit({ id: "small", radius: 0.32, isFlat: false, thickness: 0.64 }), true);
    assert.equal(isEligibleDrillSplit({ id: "thin", radius: 0.8, isFlat: true, thickness: 0.22 }), true);
    assert.equal(isEligibleDrillSplit({ id: "large", radius: 0.8, isFlat: false, thickness: 1.6 }), false);
    assert.equal(isEligibleDrillSplit({ id: "thick-slab", radius: 0.8, isFlat: true, thickness: 0.23 }), false);
  });

  test("uses a repeatable small chance per eligible drill attempt", () => {
    assert.equal(DRILLED_ROCK_SPLIT_CHANCE, 0.08);
    const small = { id: "stable-rock-id", radius: 0.28, isFlat: false, thickness: 0.56 };
    assert.equal(shouldSplitRockDuringDrilling(small, 3), shouldSplitRockDuringDrilling(small, 3));
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.equal(shouldSplitRockDuringDrilling({ id: "too-large", radius: 0.9, isFlat: false, thickness: 1.8 }, attempt), false);
    }
    let splits = 0;
    for (let i = 0; i < 1000; i++) {
      if (shouldSplitRockDuringDrilling({ ...small, id: `sample-${i}` }, 0)) splits++;
    }
    assert.ok(splits > 45);
    assert.ok(splits < 115);
  });
});

await finish();
