/**
 * @suite vehicles:roverWallClip
 * @group unit
 * @covers engine/src/vehicles/vehicle.ts
 * @covers engine/src/vehicles/ground.ts
 * @covers examples/src/scenes/marsShared.ts
 * @desc fe-20: rover driven into a steep wall must not tunnel, teleport to the rim, or spin on one wheel
 */

export const suite = {
  name: "vehicles:roverWallClip",
  group: "unit",
  covers: [
    "engine/src/vehicles/vehicle.ts",
    "engine/src/vehicles/ground.ts",
    "examples/src/scenes/marsShared.ts",
  ],
  desc: "fe-20: rover driven into a steep wall must not tunnel, teleport to the rim, or spin on one wheel",
};

/**
 * Before fe-20, wheel contact and `correctPenetration` sampled the heightfield straight down under
 * each hardpoint, so a canyon face read as "ground 6 m higher" and the chassis was lifted ~0.3 m
 * per frame up the wall (0.53 m → 6.46 m in 18 frames at 4 m/s), then balanced on the wheels that
 * reached the rim. These pin the wall response for the shipped Mars rover build.
 */
import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import { Vec3, WALL_NORMAL_Y, heightFunctionGround, slopeGround, type GroundQuery } from "@forge/engine";
import { createMarsRoverVehicle } from "../../examples/src/scenes/marsShared.js";

const WALL_Z = 10;
const hub = new Vec3();
const WALL_H = 6;
/** Steep ramp wall: `face` metres of run up to WALL_H (0.5 m ≈ 85°, 2 m ≈ 72°). */
const rampWall = (face: number) => (_x: number, z: number) => Math.min(1, Math.max(0, (z - WALL_Z) / face)) * WALL_H;
/** Discontinuous cliff (a heightfield cell edge). */
const cliff = (_x: number, z: number) => (z >= WALL_Z ? WALL_H : 0);

interface Run { maxY: number; maxSpin: number; maxTilt: number; endSpin: number; maxFrontZ: number; endZ: number; endY: number; }

function drive(ground: GroundQuery, speed: number, yaw: number, seconds = 8): Run {
  const v = createMarsRoverVehicle(ground, 0, 0);
  v.yaw = yaw;
  v.setVelocity(Math.sin(yaw) * speed, 0, Math.cos(yaw) * speed);
  v.input.throttle = 1;
  const r: Run = { maxY: -Infinity, maxSpin: 0, maxTilt: 0, endSpin: 0, maxFrontZ: -Infinity, endZ: 0, endY: 0 };
  for (let i = 0; i < seconds * 60; i++) {
    v.step(1 / 60, ground);
    assert.ok(Number.isFinite(v.position.y), "finite state");
    r.maxY = Math.max(r.maxY, v.position.y);
    r.maxSpin = Math.max(r.maxSpin, Math.hypot(v.yawRate, v.pitchRate, v.rollRate));
    r.maxTilt = Math.max(r.maxTilt, Math.hypot(v.pitchRate, v.rollRate));
    for (const w of v.wheels) {
      r.maxFrontZ = Math.max(r.maxFrontZ, v.wheelCenterPosition(w, hub).z);
    }
  }
  r.endSpin = Math.hypot(v.yawRate, v.pitchRate, v.rollRate);
  r.endZ = v.position.z;
  r.endY = v.position.y;
  return r;
}

const startY = (() => { const g = heightFunctionGround(() => 0); return createMarsRoverVehicle(g, 0, 0).position.y; })();
const EPS = 0.15;
/** A corner strike may yaw the rover (a real glancing impact does), but it must not tip/spin on a wheel and must settle. */
function assertSpin(r: Run): void {
  assert.ok(r.maxTilt < 1.5, `bounded pitch/roll rate (${r.maxTilt.toFixed(2)} rad/s)`);
  assert.ok(r.maxSpin < 4, `bounded angular velocity (${r.maxSpin.toFixed(2)} rad/s)`);
  assert.ok(r.endSpin < 0.5, `settles (${r.endSpin.toFixed(2)} rad/s at the end)`);
}

group("fe-20 — steep wall impact", () => {
  for (const face of [0.5, 1, 2]) {
    for (const speed of [2, 5, 10]) {
      for (const yaw of [0, 0.5, -0.9]) {
        test(`ramp wall face=${face} m, ${speed} m/s, yaw ${yaw}: no climb, no tunnel, bounded spin`, () => {
          const r = drive(heightFunctionGround(rampWall(face)), speed, yaw);
          assert.ok(r.maxY < startY + EPS, `no upward teleport (maxY ${r.maxY.toFixed(3)} vs ${startY.toFixed(3)})`);
          assert.ok(r.maxFrontZ < WALL_Z + face * 0.5, `stays outside the wall (hardpoint z ${r.maxFrontZ.toFixed(2)})`);
          assert.ok(r.endY < startY + EPS, "ends on the floor, not the rim");
          assertSpin(r);
        });
      }
    }
  }
  for (const speed of [3, 12]) {
    test(`discontinuous cliff at ${speed} m/s: blocked, not lifted`, () => {
      const r = drive(heightFunctionGround(cliff, 0.25), speed, 0.3);
      assert.ok(r.maxY < startY + EPS, `maxY ${r.maxY.toFixed(3)}`);
      assert.ok(r.maxFrontZ < WALL_Z + 0.2, `hardpoint z ${r.maxFrontZ.toFixed(2)}`);
      assertSpin(r);
    });
  }
  test("nose-in against the wall, the rover can still reverse away and turn out", () => {
    const g = heightFunctionGround(rampWall(1));
    const v = createMarsRoverVehicle(g, 0, 7);
    v.input.throttle = 1;
    for (let i = 0; i < 240; i++) v.step(1 / 60, g); // pinned against the face
    v.input.throttle = 0;
    v.selectDriveDirection(true, 10);
    v.input.throttle = 1;
    const z0 = v.position.z;
    for (let i = 0; i < 240; i++) v.step(1 / 60, g);
    assert.ok(v.position.z < z0 - 0.3, `reversed away (Δz ${(v.position.z - z0).toFixed(2)})`);
    v.selectDriveDirection(false, 10);
    v.input.steer = 1;
    const yaw0 = v.yaw;
    for (let i = 0; i < 240; i++) v.step(1 / 60, g);
    assert.ok(Math.abs(v.yaw - yaw0) > 0.2, `turned out (Δyaw ${(v.yaw - yaw0).toFixed(3)})`);
  });
  test("glancing hit slides along the wall instead of sticking", () => {
    const g = heightFunctionGround(rampWall(1));
    const v = createMarsRoverVehicle(g, 0, 0);
    v.yaw = 1.2; // ~69° from the wall normal
    v.setVelocity(Math.sin(1.2) * 5, 0, Math.cos(1.2) * 5);
    v.input.throttle = 1;
    for (let i = 0; i < 300; i++) v.step(1 / 60, g);
    assert.ok(v.position.x > 10, `kept moving along the wall (x ${v.position.x.toFixed(2)})`);
  });
});

group("fe-20 — climbable ground is unchanged", () => {
  test("WALL_NORMAL_Y sits between drivable slopes and walls", () => {
    assert.ok(WALL_NORMAL_Y < Math.cos((40 * Math.PI) / 180) && WALL_NORMAL_Y > Math.cos((70 * Math.PI) / 180));
  });
  test("rover still climbs a 15° incline", () => {
    const g = slopeGround((15 * Math.PI) / 180);
    const v = createMarsRoverVehicle(g, 0, 0);
    v.input.throttle = 1;
    for (let i = 0; i < 600; i++) v.step(1 / 60, g);
    assert.ok(v.position.z > 3, `made progress uphill (z ${v.position.z.toFixed(2)})`);
  });
  test("rover still rolls over a 10 cm lip", () => {
    const g = heightFunctionGround((_x, z) => (z > 4 ? 0.1 : 0), 0.05);
    const v = createMarsRoverVehicle(g, 0, 0);
    v.setVelocity(0, 0, 2);
    v.input.throttle = 1;
    for (let i = 0; i < 480; i++) v.step(1 / 60, g);
    assert.ok(v.position.z > 7, `crossed the lip (z ${v.position.z.toFixed(2)})`);
  });
});

finish();
