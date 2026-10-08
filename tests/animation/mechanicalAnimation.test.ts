/**
 * @suite animation:mechanicalAnimation
 * @group unit
 * @covers engine/src/animation/mechanical.ts
 * @covers engine/src/animation/mechanicalSystem.ts
 * @covers engine/src/core/log.ts
 * @covers engine/src/core/time.ts
 * @covers engine/src/debug/profiler.ts
 * @covers engine/src/index.ts
 * @covers engine/src/math/mat.ts
 * @covers engine/src/math/vec.ts
 * @covers engine/src/scene/components/index.ts
 * @covers engine/src/scene/entityId.ts
 * @covers engine/src/scene/systems.ts
 * @covers engine/src/scene/world.ts
 * @covers engine/src/vehicles/components.ts
 * @covers engine/src/vehicles/ground.ts
 * @covers engine/src/vehicles/system.ts
 * @covers engine/src/vehicles/vehicle.ts
 * @covers engine/src/vehicles/wheelRig.ts
 * @desc Mechanical animation (Phase 16.6): the joint rig, its channel contract, and the vehicle wheel
 */

export const suite = {
  name: "animation:mechanicalAnimation",
  group: "unit",
  covers:   [
    "engine/src/animation/mechanical.ts",
    "engine/src/animation/mechanicalSystem.ts",
    "engine/src/core/log.ts",
    "engine/src/core/time.ts",
    "engine/src/debug/profiler.ts",
    "engine/src/index.ts",
    "engine/src/math/mat.ts",
    "engine/src/math/vec.ts",
    "engine/src/scene/components/index.ts",
    "engine/src/scene/entityId.ts",
    "engine/src/scene/systems.ts",
    "engine/src/scene/world.ts",
    "engine/src/vehicles/components.ts",
    "engine/src/vehicles/ground.ts",
    "engine/src/vehicles/system.ts",
    "engine/src/vehicles/vehicle.ts",
    "engine/src/vehicles/wheelRig.ts"
  ],
  desc: "Mechanical animation (Phase 16.6): the joint rig, its channel contract, and the vehicle wheel",
};
/**
 * Mechanical animation (Phase 16.6): the joint rig, its channel contract, and the vehicle wheel
 * binding.
 *
 * What this suite protects:
 *  - joint composition (`base ∘ motion`), so a re-pose is idempotent and cannot drift;
 *  - the channel semantics a source relies on — ratio/bias, clamps, slew, and odometer wrap;
 *  - the aim solve: the link's posed direction actually points at the entity the physics moves,
 *    including the ordering rule that a joint sees joints declared before it in the same pass;
 *  - the vehicle binding: steer follows each wheel's own Ackermann angle, spin is sign-flipped on
 *    the left, travel follows compression, and the hub carrier lands where
 *    `Vehicle.wheelCenterPosition` puts the hub.
 *
 * The pixels are the browser gate's job (`npm run check:browser:mechanical`); this owns the wiring
 * and the arithmetic.
 */

import assert from "node:assert/strict";
import { assertCloseTo, assertThrows, finish, group, test } from "selrun";
import {
  Clock,
  EntityWorld,
  Logger,
  MechanicalRig,
  MechanicalRigComponent,
  MechanicalSystem,
  Profiler,
  Quat,
  SystemScratch,
  Transform,
  Vehicle,
  VehicleComponent,
  VehicleSystem,
  VehicleWheelSource,
  Vec3,
  createVehicleConfig,
  createVehicleWheelRig,
  flatGround,
  wheelChannelName,
  wheelHubRestPosition,
  type EntityId,
  type MechanicalChannelSource,
  type SystemContext,
} from "@forge/engine";

// ──────────────────────────── helpers ────────────────────────────

function ctx(world: EntityWorld, dt = 1 / 60, fixedSteps = 1): SystemContext {
  return {
    world,
    clock: new Clock(),
    dt,
    fixedDt: dt,
    fixedSteps,
    alpha: 0,
    elapsed: 0,
    frame: 1,
    logger: new Logger(),
    profiler: new Profiler(),
    services: { get: () => undefined, engineConfig: {} },
    scratch: new SystemScratch(),
  };
}

/** A world with one entity parented under the root. */
function makeEntity(world: EntityWorld, name: string, position = new Vec3()): EntityId {
  const entity = world.createEntity(name);
  world.setTRS(entity.id, position, new Quat(), new Vec3(1, 1, 1));
  return entity.id;
}

function rotationOf(world: EntityWorld, id: EntityId): Quat {
  return world.getTRS(id).rotation;
}

function positionOf(world: EntityWorld, id: EntityId): Vec3 {
  return world.getTRS(id).position;
}

/** Rotate a local +Z direction by a quaternion — the direction a link authored along +Z points. */
function pointedDirection(q: Quat, out = new Vec3()): Vec3 {
  q.rotateVector(new Vec3(0, 0, 1), out);
  return out;
}

// ──────────────────────────── joint composition ────────────────────────────

group("MechanicalRig — joint composition", () => {
  test("poses a revolute joint as base ∘ Rot(axis, value)", () => {
    const world = new EntityWorld();
    const id = makeEntity(world, "hinge");
    const rig = new MechanicalRig(world);
    rig.addJoint({ entity: id, kind: "revolute", axis: { x: 1, y: 0, z: 0 }, channel: "a" });
    rig.setChannel("a", 0.7);
    rig.step(1 / 60);

    const expected = new Quat().setAxisAngle(new Vec3(1, 0, 0), 0.7);
    const actual = rotationOf(world, id);
    assertCloseTo(actual.x, expected.x, 6);
    assertCloseTo(actual.y, expected.y, 6);
    assertCloseTo(actual.z, expected.z, 6);
    assertCloseTo(actual.w, expected.w, 6);
  });

  test("composes motion on top of the entity's authored (base) rotation", () => {
    const world = new EntityWorld();
    const id = makeEntity(world, "hinge");
    world.transforms.setRotation(
      world.transformSlot(id, true),
      new Quat().setAxisAngle(new Vec3(0, 1, 0), 0.5),
    );
    const rig = new MechanicalRig(world);
    rig.addJoint({ entity: id, kind: "revolute", axis: { x: 1, y: 0, z: 0 }, channel: "a" });
    rig.setChannel("a", 0.3);
    rig.step(1 / 60);

    const expected = new Quat()
      .setAxisAngle(new Vec3(0, 1, 0), 0.5)
      .multiply(new Quat().setAxisAngle(new Vec3(1, 0, 0), 0.3));
    const actual = rotationOf(world, id);
    assertCloseTo(actual.x, expected.x, 6);
    assertCloseTo(actual.y, expected.y, 6);
    assertCloseTo(actual.z, expected.z, 6);
    assertCloseTo(actual.w, expected.w, 6);
  });

  test("offsets a prismatic joint along its axis from the base position", () => {
    const world = new EntityWorld();
    const id = makeEntity(world, "slider", new Vec3(1, -0.28, 2));
    const rig = new MechanicalRig(world);
    rig.addJoint({ entity: id, kind: "prismatic", axis: { x: 0, y: 1, z: 0 }, channel: "travel" });
    rig.setChannel("travel", 0.12);
    rig.step(1 / 60);

    const p = positionOf(world, id);
    assertCloseTo(p.x, 1, 6);
    assertCloseTo(p.y, -0.16, 6);
    assertCloseTo(p.z, 2, 6);
  });

  test("applies ratio and bias before clamping", () => {
    const world = new EntityWorld();
    const id = makeEntity(world, "axle");
    const rig = new MechanicalRig(world);
    rig.addJoint({
      entity: id,
      axis: { x: 1, y: 0, z: 0 },
      channel: "spin",
      ratio: -1,
      bias: 0.1,
      wrap: false,
    });
    rig.setChannel("spin", 0.5);
    rig.step(1 / 60);
    assertCloseTo(rig.valueAt(0), -0.4, 9);
  });

  test("clamps the driven value to min/max", () => {
    const world = new EntityWorld();
    const id = makeEntity(world, "knuckle");
    const rig = new MechanicalRig(world);
    rig.addJoint({ entity: id, axis: { x: 0, y: 1, z: 0 }, channel: "steer", min: -0.4, max: 0.4 });
    rig.setChannel("steer", 3);
    rig.step(1 / 60);
    assertCloseTo(rig.valueAt(0), 0.4, 9);
    rig.setChannel("steer", -3);
    rig.step(1 / 60);
    assertCloseTo(rig.valueAt(0), -0.4, 9);
  });

  test("treats a missing channel as zero", () => {
    const world = new EntityWorld();
    const id = makeEntity(world, "axle");
    const rig = new MechanicalRig(world);
    rig.addJoint({ entity: id, axis: { x: 1, y: 0, z: 0 }, channel: "never-written" });
    rig.step(1 / 60);
    assert.equal(rig.valueAt(0), 0);
    assert.equal(rig.getChannel("never-written"), 0);
  });

  test("is idempotent: re-posing does not accumulate", () => {
    const world = new EntityWorld();
    const id = makeEntity(world, "axle");
    const rig = new MechanicalRig(world);
    rig.addJoint({ entity: id, axis: { x: 1, y: 0, z: 0 }, channel: "spin" });
    rig.setChannel("spin", 2.5);
    rig.step(1 / 60);
    const once = rotationOf(world, id).clone();
    for (let i = 0; i < 200; i++) rig.step(1 / 60);
    const many = rotationOf(world, id);
    assertCloseTo(many.x, once.x, 9);
    assertCloseTo(many.y, once.y, 9);
    assertCloseTo(many.z, once.z, 9);
    assertCloseTo(many.w, once.w, 9);
  });

  test("returns every joint to its base pose on reset", () => {
    const world = new EntityWorld();
    const id = makeEntity(world, "slider", new Vec3(0, -0.28, 0));
    const rig = new MechanicalRig(world);
    rig.addJoint({ entity: id, kind: "prismatic", axis: { x: 0, y: 1, z: 0 }, channel: "travel" });
    rig.setChannel("travel", 0.1);
    rig.step(1 / 60);
    rig.reset();
    assert.equal(rig.valueAt(0), 0);
    assertCloseTo(positionOf(world, id).y, -0.28, 5);
  });

  test("skips an entity that was destroyed after binding", () => {
    const world = new EntityWorld();
    const id = makeEntity(world, "axle");
    const rig = new MechanicalRig(world);
    rig.addJoint({ entity: id, axis: { x: 1, y: 0, z: 0 }, channel: "spin" });
    world.destroyEntity(id);
    rig.setChannel("spin", 1);
    assert.doesNotThrow(() => rig.step(1 / 60));
    assert.equal(rig.jointCount, 1);
  });

  test("rejects a joint without a transform, without a channel, or without a target", () => {
    const world = new EntityWorld();
    const rig = new MechanicalRig(world);
    const id = makeEntity(world, "axle");
    // An entity with no transform slot yet.
    const bare = world.createEntity("bare").id;
    assertThrows(() => rig.addJoint({ entity: bare, channel: "a" }), /no transform/);
    assertThrows(() => rig.addJoint({ entity: id }), /channel/);
    assertThrows(() => rig.addJoint({ entity: id, kind: "aim" }), /target/);
    assertThrows(() => rig.addJoint({ entity: id, channel: "a", axis: { x: 0, y: 0, z: 0 } }), /axis/);
  });
});

// ──────────────────────────── channels: slew and wrap ────────────────────────────

group("MechanicalRig — slew and odometer wrap", () => {
  test("rate-limits how fast a joint can follow its channel", () => {
    const world = new EntityWorld();
    const id = makeEntity(world, "knuckle");
    const rig = new MechanicalRig(world);
    rig.addJoint({ entity: id, axis: { x: 0, y: 1, z: 0 }, channel: "steer", slew: 2 });
    rig.setChannel("steer", 1);
    // 2 rad/s over 0.1 s = at most 0.2 rad this step.
    rig.step(0.1);
    assertCloseTo(rig.valueAt(0), 0.2, 9);
    assert.equal(rig.saturatedAt(0), true);
    rig.step(0.1);
    assertCloseTo(rig.valueAt(0), 0.4, 9);
    // Five more steps reach the destination exactly, then stop saturating.
    for (let i = 0; i < 5; i++) rig.step(0.1);
    assertCloseTo(rig.valueAt(0), 1, 9);
    assert.equal(rig.saturatedAt(0), false);
  });

  test("slews a spin odometer through the ±π seam instead of unwinding", () => {
    const world = new EntityWorld();
    const id = makeEntity(world, "axle");
    const rig = new MechanicalRig(world);
    rig.addJoint({ entity: id, axis: { x: 1, y: 0, z: 0 }, channel: "spin", slew: 2 });
    // Settle just under +π (a long step, so the slew limit is not the thing under test).
    rig.setChannel("spin", Math.PI - 0.03);
    rig.step(2);
    const before = rig.valueAt(0);
    assert.ok(before > 3.1);
    // Cross the seam: the destination wraps to −π+0.01, which is 0.04 rad forward, not 6.24 back.
    rig.setChannel("spin", Math.PI + 0.01);
    rig.step(0.02);
    assert.equal(rig.saturatedAt(0), false);
    assert.ok(Math.abs(rig.valueAt(0)) > 3.12);
  });

  test("wraps an unbounded odometer channel into (−π, π]", () => {
    const world = new EntityWorld();
    const id = makeEntity(world, "axle");
    const rig = new MechanicalRig(world);
    rig.addJoint({ entity: id, axis: { x: 1, y: 0, z: 0 }, channel: "spin" });
    rig.setChannel("spin", 5 * Math.PI); // ≡ π
    rig.step(1 / 60);
    assertCloseTo(rig.valueAt(0), Math.PI, 9);
    rig.setChannel("spin", (3 * Math.PI) / 2); // ≡ −π/2
    rig.step(1 / 60);
    assertCloseTo(rig.valueAt(0), -Math.PI / 2, 9);
    rig.setChannel("spin", -((3 * Math.PI) / 2)); // ≡ +π/2
    rig.step(1 / 60);
    assertCloseTo(rig.valueAt(0), Math.PI / 2, 9);
  });

  test("wraps a fast spin to the same orientation a big angle would give", () => {
    const world = new EntityWorld();
    const id = makeEntity(world, "axle");
    const rig = new MechanicalRig(world);
    rig.addJoint({ entity: id, axis: { x: 1, y: 0, z: 0 }, channel: "spin" });
    rig.setChannel("spin", 40.5); // ~6.45 turns
    rig.step(1 / 60);
    const wrapped = rotationOf(world, id);
    const direct = new Quat().setAxisAngle(new Vec3(1, 0, 0), 40.5);
    const dot = Math.abs(wrapped.x * direct.x + wrapped.y * direct.y + wrapped.z * direct.z + wrapped.w * direct.w);
    assertCloseTo(dot, 1, 6);
  });

  test("is deterministic: the same channel history gives the same values", () => {
    const build = (): { rig: MechanicalRig; id: EntityId } => {
      const world = new EntityWorld();
      const id = makeEntity(world, "knuckle");
      const rig = new MechanicalRig(world);
      rig.addJoint({ entity: id, axis: { x: 0, y: 1, z: 0 }, channel: "steer", slew: 3 });
      return { rig, id };
    };
    const a = build();
    const b = build();
    for (let i = 0; i < 60; i++) {
      const value = Math.sin(i * 0.3) * 0.6;
      a.rig.setChannel("steer", value);
      b.rig.setChannel("steer", value);
      a.rig.step(1 / 60);
      b.rig.step(1 / 60);
    }
    assert.equal(a.rig.valueAt(0), b.rig.valueAt(0));
  });
});

// ──────────────────────────── aim joints ────────────────────────────

group("MechanicalRig — aim joints", () => {
  test("points a link authored along +Z at its target", () => {
    const world = new EntityWorld();
    const arm = world.createEntity("arm");
    world.setTRS(arm.id, new Vec3(0, 0, 0), new Quat(), new Vec3(1, 1, 1));
    const hub = makeEntity(world, "hub", new Vec3(0, -1, 0));
    const rig = new MechanicalRig(world);
    rig.addJoint({ entity: arm.id, kind: "aim", axis: { x: 1, y: 0, z: 0 }, target: hub });
    rig.step(1 / 60);

    // Straight below +Z: a +90° rotation about +X.
    assertCloseTo(rig.valueAt(0), Math.PI / 2, 6);
    const direction = pointedDirection(rotationOf(world, arm.id));
    assertCloseTo(direction.x, 0, 6);
    assertCloseTo(direction.y, -1, 6);
    assertCloseTo(direction.z, 0, 6);
  });

  test("solves zero when the target already lies along the link", () => {
    const world = new EntityWorld();
    const arm = world.createEntity("arm");
    world.setTRS(arm.id, new Vec3(0, 0, 0), new Quat(), new Vec3(1, 1, 1));
    const hub = makeEntity(world, "hub", new Vec3(0, 0, 2));
    const rig = new MechanicalRig(world);
    rig.addJoint({ entity: arm.id, kind: "aim", axis: { x: 1, y: 0, z: 0 }, target: hub });
    rig.step(1 / 60);
    assertCloseTo(rig.valueAt(0), 0, 6);
  });

  test("follows a target that moved, pointing at where it is now", () => {
    const world = new EntityWorld();
    const arm = world.createEntity("arm");
    world.setTRS(arm.id, new Vec3(0, 0, 0), new Quat(), new Vec3(1, 1, 1));
    const hub = makeEntity(world, "hub", new Vec3(0, -1, 0));
    const rig = new MechanicalRig(world);
    rig.addJoint({ entity: arm.id, kind: "aim", axis: { x: 1, y: 0, z: 0 }, target: hub });
    rig.step(1 / 60);

    // Move the hub: 45° down-forward from the pivot.
    world.setTRS(hub, new Vec3(0, -0.5, 0.5), new Quat(), new Vec3(1, 1, 1));
    rig.step(1 / 60);
    assertCloseTo(rig.valueAt(0), Math.PI / 4, 5);
    const direction = pointedDirection(rotationOf(world, arm.id));
    assertCloseTo(direction.y, -Math.SQRT1_2, 5);
    assertCloseTo(direction.z, Math.SQRT1_2, 5);
  });

  test("accounts for the joint's parent transform when aiming", () => {
    const world = new EntityWorld();
    const chassis = world.createEntity("chassis");
    // Chassis yawed 90°: local +Z now points along world +X.
    world.setTRS(chassis.id, new Vec3(0, 0, 0), new Quat().setAxisAngle(new Vec3(0, 1, 0), Math.PI / 2), new Vec3(1, 1, 1));
    const arm = world.createEntity("arm");
    arm.addChild(world.facade(chassis.id)!);
    world.setTRS(arm.id, new Vec3(0, 0, 0), new Quat(), new Vec3(1, 1, 1));
    // The hub hangs one metre below the chassis in world terms.
    const hub = world.createEntity("hub");
    world.setTRS(hub.id, new Vec3(0, -1, 0), new Quat(), new Vec3(1, 1, 1));
    const rig = new MechanicalRig(world);
    rig.addJoint({ entity: arm.id, kind: "aim", axis: { x: 1, y: 0, z: 0 }, target: hub.id });
    rig.step(1 / 60);
    // In the arm's parent frame the hub is still straight down, so the same +90° solve.
    assertCloseTo(rig.valueAt(0), Math.PI / 2, 5);
  });

  test("stretches a telescoping link to the distance it has to cover", () => {
    const world = new EntityWorld();
    const arm = world.createEntity("shock");
    world.setTRS(arm.id, new Vec3(0, 0, 0), new Quat(), new Vec3(1, 1, 1));
    const hub = makeEntity(world, "hub", new Vec3(0, -0.5, 0));
    const rig = new MechanicalRig(world);
    rig.addJoint({ entity: arm.id, kind: "aim", axis: { x: 1, y: 0, z: 0 }, target: hub, stretch: true });
    rig.step(1 / 60);
    assertCloseTo(positionOf(world, arm.id).z, 0, 9);
    assertCloseTo(world.getTRS(arm.id).scale.z, 1, 6); // 0.5 / rest 0.5

    world.setTRS(hub, new Vec3(0, -0.6, 0), new Quat(), new Vec3(1, 1, 1));
    rig.step(1 / 60);
    assertCloseTo(world.getTRS(arm.id).scale.z, 1.2, 6); // 0.6 / rest 0.5
    assertCloseTo(world.getTRS(arm.id).scale.x, 1, 6);
    assertCloseTo(world.getTRS(arm.id).scale.y, 1, 6);
  });

  test("sees joints declared before it in the same pass (the ordering contract)", () => {
    const build = (aimFirst: boolean): { world: EntityWorld; rig: MechanicalRig; arm: EntityId } => {
      const world = new EntityWorld();
      const chassis = world.createEntity("chassis");
      world.setTRS(chassis.id, new Vec3(0, 0, 0), new Quat(), new Vec3(1, 1, 1));
      // Hub carrier authored at full droop: one metre below and half a metre ahead of the pivot.
      const carrier = world.createEntity("carrier");
      chassis.addChild(carrier);
      world.setTRS(carrier.id, new Vec3(0, -1, 0.5), new Quat(), new Vec3(1, 1, 1));
      const arm = world.createEntity("arm");
      chassis.addChild(arm);
      world.setTRS(arm.id, new Vec3(0, 0, 0), new Quat(), new Vec3(1, 1, 1));

      const rig = new MechanicalRig(world);
      const travel = { entity: carrier.id, kind: "prismatic" as const, axis: { x: 0, y: 1, z: 0 }, channel: "travel" };
      const aim = { entity: arm.id, kind: "aim" as const, axis: { x: 1, y: 0, z: 0 }, target: carrier.id };
      rig.addJoint(aimFirst ? aim : travel);
      rig.addJoint(aimFirst ? travel : aim);
      return { world, rig, arm: arm.id };
    };

    const ordered = build(false);
    ordered.rig.setChannel("travel", 0);
    ordered.rig.step(1 / 60);
    // At rest: 1 m down, 0.5 m ahead of the pivot → +atan2(1, 0.5) about the hinge.
    assertCloseTo(ordered.rig.valueAt(1), Math.atan2(1, 0.5), 6);

    // Compressing 0.5 m moves the hub to 0.5 m down in the same frame; the arm sees it immediately.
    ordered.rig.setChannel("travel", 0.5);
    ordered.rig.step(1 / 60);
    assertCloseTo(positionOf(ordered.world, ordered.rig.entityAt(0)!).y, -0.5, 5);
    assertCloseTo(ordered.rig.valueAt(1), Math.atan2(0.5, 0.5), 6);
    const direction = pointedDirection(rotationOf(ordered.world, ordered.arm));
    assertCloseTo(direction.z, Math.SQRT1_2, 5);
    assertCloseTo(direction.y, -Math.SQRT1_2, 5);

    // Declared the other way round, the aim solve reads the carrier's previous pose: it lags a frame
    // (the inverted rig's aim joint is index 0 and its travel joint index 1).
    const inverted = build(true);
    inverted.rig.setChannel("travel", 0.5);
    inverted.rig.step(1 / 60);
    assertCloseTo(inverted.rig.valueAt(1), 0.5, 6); // travel itself still lands
    assertCloseTo(inverted.rig.valueAt(0), Math.atan2(1, 0.5), 6); // arm still aimed at the old pose
    inverted.rig.step(1 / 60);
    assertCloseTo(inverted.rig.valueAt(0), Math.atan2(0.5, 0.5), 6); // catches up next frame
  });

  test("holds the previous pose when the target is on the hinge axis", () => {
    const world = new EntityWorld();
    const arm = world.createEntity("arm");
    world.setTRS(arm.id, new Vec3(0, 0, 0), new Quat(), new Vec3(1, 1, 1));
    const hub = makeEntity(world, "hub", new Vec3(0, -1, 0));
    const rig = new MechanicalRig(world);
    rig.addJoint({ entity: arm.id, kind: "aim", axis: { x: 1, y: 0, z: 0 }, target: hub });
    rig.step(1 / 60);
    assertCloseTo(rig.valueAt(0), Math.PI / 2, 6);
    world.setTRS(hub, new Vec3(3, 0, 0), new Quat(), new Vec3(1, 1, 1));
    rig.step(1 / 60);
    assertCloseTo(rig.valueAt(0), Math.PI / 2, 6);
  });

  test("lags its target when a slew limit is set (and reports it)", () => {
    const world = new EntityWorld();
    const arm = world.createEntity("arm");
    world.setTRS(arm.id, new Vec3(0, 0, 0), new Quat(), new Vec3(1, 1, 1));
    const hub = makeEntity(world, "hub", new Vec3(0, -1, 0));
    const rig = new MechanicalRig(world);
    rig.addJoint({ entity: arm.id, kind: "aim", axis: { x: 1, y: 0, z: 0 }, target: hub, slew: 1 });
    rig.step(0.1);
    assertCloseTo(rig.valueAt(0), 0.1, 6); // 1 rad/s over 0.1 s
    assert.equal(rig.saturatedAt(0), true);
    for (let i = 0; i < 40; i++) rig.step(0.1);
    assertCloseTo(rig.valueAt(0), Math.PI / 2, 6);
  });
});

// ──────────────────────────── the system ────────────────────────────

group("MechanicalSystem", () => {
  test("drives a rig from its channel source at order 310", () => {
    const world = new EntityWorld();
    const id = makeEntity(world, "axle");
    const rig = new MechanicalRig(world);
    rig.addJoint({ entity: id, axis: { x: 1, y: 0, z: 0 }, channel: "spin" });
    let written = 0;
    const source: MechanicalChannelSource = {
      writeChannels(target) {
        written++;
        target.setChannel("spin", 1.25);
      },
    };
    const component = new MechanicalRigComponent(rig, source);
    world.facade(id)!.add(component);
    const system = new MechanicalSystem();
    world.registerSystem(system);
    assert.equal(system.order, 310);

    world.runSystems(ctx(world));
    assert.equal(written, 1);
    assertCloseTo(rig.valueAt(0), 1.25, 9);

    const stats = system.stats();
    assert.equal(stats.mechanicalRigs, 1);
    assert.equal(stats.mechanicalJoints, 1);
    assert.equal(stats.mechanicalJointsPosed, 1);
  });

  test("poses the entity before the transform pass, so world matrices follow", () => {
    const world = new EntityWorld();
    const id = makeEntity(world, "arm");
    const rig = new MechanicalRig(world);
    rig.addJoint({ entity: id, kind: "prismatic", axis: { x: 0, y: 1, z: 0 }, channel: "travel" });
    rig.setChannel("travel", 0.25);
    world.facade(id)!.add(new MechanicalRigComponent(rig));
    world.registerSystem(new MechanicalSystem());

    world.runSystems(ctx(world));
    assertCloseTo(world.worldPosition(id).y, 0.25, 6);
  });

  test("returns a detached rig to its authored pose", () => {
    const world = new EntityWorld();
    const id = makeEntity(world, "axle");
    const rig = new MechanicalRig(world);
    rig.addJoint({ entity: id, axis: { x: 1, y: 0, z: 0 }, channel: "spin" });
    rig.setChannel("spin", 1);
    rig.step(1 / 60);
    assertCloseTo(rig.valueAt(0), 1, 9);
    world.facade(id)!.add(new MechanicalRigComponent(rig));
    world.removeComponent(id, MechanicalRigComponent);
    assert.equal(rig.valueAt(0), 0);
    const q = rotationOf(world, id);
    assertCloseTo(q.x, 0, 9);
    assertCloseTo(q.w, 1, 9);
  });
});

// ──────────────────────────── the vehicle binding ────────────────────────────

interface WheelFixture {
  world: EntityWorld;
  vehicle: Vehicle;
  source: VehicleWheelSource;
  hubs: EntityId[];
  knuckles: EntityId[];
  axles: EntityId[];
  rig: MechanicalRig;
}

/** A chassis with four wheel assemblies, authored in the layout `wheelRig.ts` documents. */
function wheelFixture(): WheelFixture {
  const world = new EntityWorld();
  world.registerSystem(new VehicleSystem());
  world.registerSystem(new MechanicalSystem());

  const vehicle = new Vehicle(createVehicleConfig());
  vehicle.position.set(0, 0, 0);
  vehicle.placeOnGround(flatGround());

  const chassis = world.createEntity("chassis");
  world.setTRS(chassis.id, new Vec3(vehicle.position.x, vehicle.position.y, vehicle.position.z), new Quat(), new Vec3(1, 1, 1));

  const hubs: EntityId[] = [];
  const knuckles: EntityId[] = [];
  const axles: EntityId[] = [];
  const mounts: { travel: EntityId; steer: EntityId; spin: EntityId }[] = [];
  const rest = new Vec3();
  for (let i = 0; i < vehicle.wheels.length; i++) {
    wheelHubRestPosition(vehicle, i, rest);
    const hub = world.createEntity(`hub-${i}`);
    hub.addChild(world.facade(chassis.id)!);
    world.setTRS(hub.id, rest.clone(), new Quat(), new Vec3(1, 1, 1));
    const knuckle = world.createEntity(`knuckle-${i}`);
    knuckle.addChild(hub);
    world.setTRS(knuckle.id, new Vec3(0, 0, 0), new Quat(), new Vec3(1, 1, 1));
    const axle = world.createEntity(`axle-${i}`);
    axle.addChild(knuckle);
    world.setTRS(axle.id, new Vec3(0, 0, 0), new Quat(), new Vec3(1, 1, 1));
    hubs.push(hub.id);
    knuckles.push(knuckle.id);
    axles.push(axle.id);
    mounts.push({ travel: hub.id, steer: knuckle.id, spin: axle.id });
  }

  const rig = new MechanicalRig(world);
  createVehicleWheelRig(rig, vehicle, mounts);
  const source = new VehicleWheelSource(vehicle);
  const component = new VehicleComponent(vehicle, flatGround());
  component.wheelEntities = [];
  chassis.add(component);
  chassis.add(new MechanicalRigComponent(rig, source));
  return { world, vehicle, source, hubs, knuckles, axles, rig };
}

group("createVehicleWheelRig — the vehicle binding", () => {
  test("authored the hub carrier at the full-droop hub position", () => {
    const { vehicle } = wheelFixture();
    const out = wheelHubRestPosition(vehicle, 0, new Vec3());
    assertCloseTo(out.x, vehicle.wheels[0]!.x, 9);
    assertCloseTo(out.y, -vehicle.config.suspensionRest, 9);
    assertCloseTo(out.z, vehicle.wheels[0]!.z, 9);
  });

  test("names channels per wheel, and only adds the joints a mount provides", () => {
    const { vehicle } = wheelFixture();
    assert.equal(wheelChannelName("wheel", 2, "spin"), "wheel2.spin");
    const world = new EntityWorld();
    const rig = new MechanicalRig(world);
    const chassis = makeEntity(world, "bare");
    void chassis;
    createVehicleWheelRig(rig, vehicle, [{ travel: makeEntity(world, "hub") }]);
    assert.equal(rig.jointCount, 1);
    assert.equal(rig.kindAt(0), "prismatic");
    assert.equal(rig.entityAt(0), world.findByName("hub")[0]);
  });

  test("steers each wheel by its own Ackermann angle, not a shared one", () => {
    const { world, vehicle, knuckles } = wheelFixture();
    vehicle.input.steer = 1;
    for (let i = 0; i < 30; i++) world.runSystems(ctx(world, 1 / 60, 1));

    const frontLeft = vehicle.wheels[0]!;
    const frontRight = vehicle.wheels[1]!;
    // A right turn: both front wheels steer right, the inner (right) wheel steers further.
    assert.ok(frontLeft.steerAngle > 0.01);
    assert.ok(frontRight.steerAngle > frontLeft.steerAngle);
    // Distinct per-wheel angles, not one shared lock.
    assert.ok(frontRight.steerAngle - frontLeft.steerAngle > 1e-3);
    // The rear axle is unsteered: its knuckles must not move at all.
    for (const index of [2, 3]) {
      const rotation = rotationOf(world, knuckles[index]!);
      assert.ok(Math.abs(rotation.y) < 1e-9);
      assertCloseTo(Math.abs(rotation.w), 1, 9);
    }
  });

  test("spins left and right wheels the same way visually (the axle sign flip)", () => {
    const { world, vehicle, axles } = wheelFixture();
    vehicle.input.throttle = 1;
    for (let i = 0; i < 60; i++) world.runSystems(ctx(world, 1 / 60, 1));
    const leftSpin = vehicle.wheels[0]!.spin;
    const rightSpin = vehicle.wheels[1]!.spin;
    assert.ok(Math.abs(leftSpin) > 0.01);
    assert.equal(Math.sign(rightSpin), Math.sign(leftSpin));
    // Same odometer channel, opposite axle axes: the posed rotations mirror in x.
    const left = rotationOf(world, axles[0]!);
    const right = rotationOf(world, axles[1]!);
    assert.equal(Math.sign(left.x), -Math.sign(right.x));
    assert.ok(Math.abs(Math.abs(left.x) - Math.abs(right.x)) < 1e-3);
  });

  test("carries the hub at the suspension position the vehicle model reports", () => {
    const { world, vehicle, hubs } = wheelFixture();
    vehicle.input.throttle = 0.6;
    for (let i = 0; i < 90; i++) world.runSystems(ctx(world, 1 / 60, 1));
    for (let i = 0; i < vehicle.wheels.length; i++) {
      const p = positionOf(world, hubs[i]!);
      assertCloseTo(p.y, -vehicle.config.suspensionRest + vehicle.wheels[i]!.compression, 6);
    }
    // Travelling compresses at least one corner away from full droop.
    const compressed = vehicle.wheels.some((w) => w.compression > 1e-4);
    assert.equal(compressed, true);
  });

  test("reproduces the world-space wheel pose's spin and steer from telemetry", () => {
    const { world, vehicle, axles, knuckles } = wheelFixture();
    vehicle.input.throttle = 0.4;
    vehicle.input.steer = 0.5;
    for (let i = 0; i < 45; i++) world.runSystems(ctx(world, 1 / 60, 1));
    for (const index of [0, 1, 2, 3]) {
      const wheel = vehicle.wheels[index]!;
      const side = wheel.x < 0 ? -1 : 1;
      const spin = rotationOf(world, axles[index]!);
      const expectedSpin = new Quat().setAxisAngle(new Vec3(1, 0, 0), side * wheel.spin);
      // Compare quaternions up to sign (a rotation and its negation are the same orientation).
      const dot = Math.abs(spin.x * expectedSpin.x + spin.y * expectedSpin.y + spin.z * expectedSpin.z + spin.w * expectedSpin.w);
      assertCloseTo(dot, 1, 4);
      const steer = rotationOf(world, knuckles[index]!);
      const expectedSteer = new Quat().setAxisAngle(new Vec3(0, 1, 0), wheel.steerAngle);
      const steerDot =
        Math.abs(steer.x * expectedSteer.x + steer.y * expectedSteer.y + steer.z * expectedSteer.z + steer.w * expectedSteer.w);
      // The knuckle slews toward the telemetry (6 rad/s), so it is within a frame's travel of it.
      assert.ok(steerDot > 0.9999);
    }
  });

  test("writes only the travel axis, leaving the hardpoint's x/z alone", () => {
    const { world, vehicle, hubs } = wheelFixture();
    for (let i = 0; i < 30; i++) world.runSystems(ctx(world, 1 / 60, 1));
    const p = positionOf(world, hubs[0]!);
    assertCloseTo(p.x, vehicle.wheels[0]!.x, 6);
    assertCloseTo(p.z, vehicle.wheels[0]!.z, 6);
    // The rig needs no Transform component of its own — the entity's transform slot is enough.
    assert.equal(world.getComponent(hubs[0]!, Transform), undefined);
  });
});

await finish();
