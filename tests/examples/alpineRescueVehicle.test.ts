/**
 * @suite examples:alpineRescueVehicle
 * @group unit
 * @covers examples/src/scenes/alpineRescueVehicle.ts
 * @covers examples/src/scenes/meshKit.ts
 * @desc Pins the rescue truck geometry: proportions, closed well-formed parts, wheel arches that clear the tyres, lamps and the lathe-turned wheel
 */

export const suite = {
  name: "examples:alpineRescueVehicle",
  group: "unit",
  covers: ["examples/src/scenes/alpineRescueVehicle.ts", "examples/src/scenes/meshKit.ts"],
  desc: "Pins the rescue truck geometry: proportions, closed well-formed parts, wheel arches that clear the tyres, lamps and the lathe-turned wheel",
};
import assert from "node:assert/strict";
import { assertCloseTo, finish, group, test } from "selrun";
import { createVehicleConfig, Vehicle, type GeometrySource } from "@forge/engine";
import { allBodySources, buildRescueTruckSources, type RescueTruckSpec } from "../../examples/src/scenes/alpineRescueVehicle.js";
import { signedVolume } from "../../examples/src/scenes/meshKit.js";

// The very config the scene builds, so the model is checked against the real hardpoints.
const config = createVehicleConfig({ mass: 2380, wheelbase: 2.72, track: 1.67, wheelRadius: 0.42, cgHeight: 0.58, layout: "awd" });
const vehicle = new Vehicle(config);
const staticCompression = (config.mass * config.gravity) / (vehicle.wheels.length * config.springRate);
const spec: RescueTruckSpec = {
  wheelbase: config.wheelbase,
  track: config.track,
  wheelRadius: config.wheelRadius,
  hubDrop: config.suspensionRest - staticCompression,
  cgToFront: config.cgToFront,
};
const truck = buildRescueTruckSources(spec);

function bounds(source: GeometrySource): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < source.positions.length; i += 3) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k]!, source.positions[i + k]!);
    max[k] = Math.max(max[k]!, source.positions[i + k]!);
  }
  return { min, max };
}

group("Rescue truck — proportions", () => {
  test("is a Land-Cruiser-class wagon: ~5 m long, ~2.1 m wide, ~2 m tall, on the vehicle's own ground plane", () => {
    const all = allBodySources(truck);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const source of all) {
      const b = bounds(source);
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k]!, b.min[k]!); hi[k] = Math.max(hi[k]!, b.max[k]!); }
    }
    assert.ok(hi[2]! - lo[2]! > 4.6 && hi[2]! - lo[2]! < 5.6, `length ${(hi[2]! - lo[2]!).toFixed(2)}`);
    assert.ok(hi[0]! - lo[0]! > 1.95 && hi[0]! - lo[0]! < 2.3, `width ${(hi[0]! - lo[0]!).toFixed(2)}`);
    const roofHeight = truck.dims.roofY - truck.dims.groundY;
    assertCloseTo(roofHeight, 2.02, 2);
    assert.ok(hi[1]! - truck.dims.groundY < 3.3, "antenna included, it stays under a bridge");
    assertCloseTo(truck.dims.groundY, -(spec.hubDrop + spec.wheelRadius), 9);
    // The body hangs clear of the ground: nothing but the tyres reaches the snow.
    assert.ok(lo[1]! > truck.dims.groundY + 0.18, `lowest body point ${(lo[1]! - truck.dims.groundY).toFixed(2)} m above the ground`);
  });

  test("the body is symmetric left to right", () => {
    for (const [name, source] of Object.entries(truck.body)) {
      const b = bounds(source);
      if (name === "headlamps" || name === "tailLamps" || name === "amber" || name === "reverse" || name === "stripe" || name === "lightBar" || name === "underbody") {
        assertCloseTo(b.min[0]! + b.max[0]!, 0, 3, `${name} is centred`);
      }
    }
    assertCloseTo(truck.flashers.redAt[0], -truck.flashers.blueAt[0], 9);
  });
});

group("Rescue truck — parts", () => {
  test("every part is a non-empty, finite, indexed mesh with unit normals", () => {
    const tris = allBodySources(truck).reduce((sum, source) => sum + source.indices!.length / 3, 0);
    for (const [name, source] of [...Object.entries(truck.body), ...Object.entries(truck.wheel)] as Array<[string, GeometrySource]>) {
      const n = source.positions.length / 3;
      assert.ok(n > 0, `${name} has vertices`);
      assert.equal(source.normals!.length, n * 3);
      assert.equal(source.tangents!.length, n * 4);
      assert.equal(source.uvs!.length, n * 2);
      for (const v of source.positions) assert.ok(Number.isFinite(v), `${name} finite`);
      for (const index of source.indices!) assert.ok(index < n, `${name} indices`);
      for (let i = 0; i < n; i++) assertCloseTo(Math.hypot(source.normals![i * 3]!, source.normals![i * 3 + 1]!, source.normals![i * 3 + 2]!), 1, 3, `${name} normal ${i}`);
    }
    assert.ok(tris > 5_000 && tris < 40_000, `body triangles ${tris}`);
  });

  test("the large solids are outward-wound (positive volume)", () => {
    for (const name of ["paint", "glass", "roof", "underbody"] as const) assert.ok(signedVolume(truck.body[name]) > 0, `${name} volume`);
    // (The hub's boss is an open lathe surface plus bolt heads, so only the tyre and dish have a volume.)
    for (const name of ["tyre", "rimDisc"] as const) assert.ok(signedVolume(truck.wheel[name]) > 0, `${name} volume`);
  });

  test("is deterministic", () => {
    const again = buildRescueTruckSources(spec);
    assert.deepEqual(Array.from(again.body.paint.positions), Array.from(truck.body.paint.positions));
    assert.deepEqual(Array.from(again.wheel.tyre.indices!), Array.from(truck.wheel.tyre.indices!));
  });
});

group("Rescue truck — wheels and arches", () => {
  test("the tyre is a 0.84 m × 0.30 m drum turned about the axle (+X) and centred on the hub", () => {
    const b = bounds(truck.wheel.tyre);
    assertCloseTo(b.max[0]! - b.min[0]!, 0.3, 2);
    assertCloseTo(b.max[1]!, 0.42, 3);
    assertCloseTo(b.max[2]!, 0.42, 3);
    assertCloseTo(b.min[0]! + b.max[0]!, 0, 6);
    // The rim face and the hub sit outboard (+X) so a left wheel only needs a half turn about Y.
    assert.ok(bounds(truck.wheel.rimSpokes).max[0]! > 0.07 && bounds(truck.wheel.rimSpokes).min[0]! > 0);
    assert.ok(bounds(truck.wheel.hub).max[0]! > 0.1);
    // The tread texture coordinate runs 0..1 across the profile with the tread in the middle band.
    const uvs = truck.wheel.tyre.uvs!;
    let minV = 1, maxV = 0;
    for (let i = 1; i < uvs.length; i += 2) { minV = Math.min(minV, uvs[i]!); maxV = Math.max(maxV, uvs[i]!); }
    assertCloseTo(minV, 0, 9);
    assertCloseTo(maxV, 1, 9);
    assert.ok(uvs[0]! >= 0 && Math.max(...Array.from(uvs).filter((_, i) => i % 2 === 0)) > 20, "u repeats around the circumference");
  });

  test("no painted body or trim vertex intrudes into any tyre at rest (the arches clear the wheels)", () => {
    const hubY = -spec.hubDrop;
    const wheels = vehicle.wheels.map((w) => ({ x: w.x, z: w.z }));
    for (const name of ["paint", "trim", "underbody"] as const) {
      const p = truck.body[name].positions;
      for (let i = 0; i < p.length; i += 3) {
        for (const w of wheels) {
          const inside = Math.abs(p[i]! - w.x) < 0.145 && Math.hypot(p[i + 1]! - hubY, p[i + 2]! - w.z) < spec.wheelRadius - 0.01;
          assert.ok(!inside, `${name} vertex (${p[i]!.toFixed(2)}, ${p[i + 1]!.toFixed(2)}, ${p[i + 2]!.toFixed(2)}) is inside the tyre at (${w.x}, ${w.z})`);
        }
      }
    }
  });

  test("the wheel arches clear the tyre at full bump travel too", () => {
    // Full bump: the suspension is at its shortest (rest − travel), so the hub is that far below the hardpoint.
    const hubY = -(config.suspensionRest - config.suspensionTravel);
    const p = truck.body.paint.positions;
    for (let i = 0; i < p.length; i += 3) {
      for (const w of vehicle.wheels) {
        const inside = Math.abs(p[i]! - w.x) < 0.14 && Math.hypot(p[i + 1]! - hubY, p[i + 2]! - w.z) < spec.wheelRadius - 0.01;
        assert.ok(!inside, `paint intrudes at full compression near wheel (${w.x}, ${w.z})`);
      }
    }
  });
});

group("Rescue truck — lamps and rack", () => {
  test("headlamps face forward, tail lamps rearward, the light bar rides the roof rack", () => {
    for (const [x, , z] of truck.dims.headlamps) {
      assert.ok(z > 2.2, "headlamp at the nose");
      assert.ok(Math.abs(x) > 0.5 && Math.abs(x) < 0.9);
    }
    for (const [, , z] of truck.dims.tailLamps) assert.ok(z < -2.2, "tail lamp at the tailgate");
    assert.ok(truck.flashers.redAt[1] > truck.dims.roofY, "flashers above the roof");
    assert.ok(truck.dims.cargo[1] > truck.dims.roofY, "the case rides on the rack above the roof");
    assert.ok(truck.dims.exhaust[2] < -2.2, "the exhaust is at the rear");
  });

  test("the spare wheel faces aft on the tailgate", () => {
    assertCloseTo(truck.spare.yaw, Math.PI / 2, 9);
    assert.ok(truck.spare.position[2] < -2.3);
    // Turning the wheel frame by +90° about Y sends +X (the rim face) to -Z.
    const c = Math.cos(truck.spare.yaw), s = Math.sin(truck.spare.yaw);
    assertCloseTo(-s, -1, 9);
    assertCloseTo(c, 0, 9);
  });
});

await finish();
