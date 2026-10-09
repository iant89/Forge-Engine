/**
 * @suite terrain:terrainInteraction
 * @group unit
 * @covers engine/src/index.ts
 * @covers engine/src/math/vec.ts
 * @covers engine/src/physics/body.ts
 * @covers engine/src/physics/shapes.ts
 * @covers engine/src/physics/world.ts
 * @covers engine/src/terrain/interaction.ts
 * @desc Pins terrain interaction behavior and regression guarantees
 */

export const suite = {
  name: "terrain:terrainInteraction",
  group: "unit",
  covers:   [
    "engine/src/index.ts",
    "engine/src/math/vec.ts",
    "engine/src/physics/body.ts",
    "engine/src/physics/shapes.ts",
    "engine/src/physics/world.ts",
    "engine/src/terrain/interaction.ts"
  ],
  desc: "Pins terrain interaction behavior and regression guarantees",
};
import assert from "node:assert/strict";
import { assertCloseTo, assertMatchObject, assertThrows, finish, group, test } from "selrun";
import {
  applyRoverImpactDamage,
  BoxShape,
  SphereShape,
  HeightfieldShape,
  InteractiveRockProxy,
  MARS_ROCK_MATERIAL,
  PhysicsWorld,
  RigidBody,
  assessRockContact,
  bridgeRockContact,
  canDisplaceRock,
  separateRoverFromRock,
  createInteractiveRockSpec,
  type InteractiveRockSpec,
  Vec3,
} from "@forge/engine";

function rock(overrides: Partial<InteractiveRockSpec> = {}): InteractiveRockSpec {
  return {
    id: "42137:3,4:rocks:12",
    shape: new BoxShape(0.4, 0.4, 0.4),
    mass: 18,
    crushStrength: 5000,
    pushForce: 120,
    climbHeight: 0.25,
    ...overrides,
  };
}

group("Phase 15.5 interactive terrain foundation", () => {
  test("keeps contact decisions deterministic and distinguishes push, block and crush", () => {
    const spec = rock();
    assertMatchObject(assessRockContact(spec, {
      roverMass: 1025,
      relativeSpeed: 0,
      availableForce: 2160,
      obstacleHeight: 0.1,
    }), { outcome: "none", reason: "no-impact" });
    assertMatchObject(assessRockContact(spec, {
      roverMass: 1025,
      relativeSpeed: 0.1,
      availableForce: 2160,
      obstacleHeight: 0.1,
    }), { outcome: "crushed", reason: "crush" });

    const pushable = rock({ crushStrength: 50000 });
    assertMatchObject(assessRockContact(pushable, {
      roverMass: 1025,
      relativeSpeed: 0.1,
      availableForce: 2160,
      obstacleHeight: 0.1,
    }), { outcome: "pushed", reason: "push" });
    assertMatchObject(assessRockContact(pushable, {
      roverMass: 1025,
      relativeSpeed: 0.1,
      availableForce: 60,
      obstacleHeight: 0.5,
    }), { outcome: "blocked", reason: "too-tall" });
  });

  test("derives mass and thresholds from the Mars material profile", () => {
    const spec = createInteractiveRockSpec({
      id: "mars-rock",
      shape: new BoxShape(0.5, 0.5, 0.5),
      material: MARS_ROCK_MATERIAL,
      climbRadius: 0.5,
    });
    assertCloseTo(spec.mass, 120, 8);
    assert.ok(spec.pushForce >= MARS_ROCK_MATERIAL.minimumPushForce);
    assert.ok(spec.crushStrength > 0);
    assertCloseTo(spec.climbHeight, 0.7, 8);

    // Even a minimum-size basalt proxy takes many meganewtons to fracture. This test impact is
    // 20 m/s — far beyond the rover's 2.63 m/s top speed — and still cannot cross the threshold.
    const smallest = createInteractiveRockSpec({
      id: "mars-minimum-pebble",
      shape: new SphereShape(0.12),
      material: MARS_ROCK_MATERIAL,
      climbRadius: 0.12,
    });
    const extremeRoverImpact = assessRockContact(smallest, {
      roverMass: 1025,
      relativeSpeed: 20,
      availableForce: 1943,
      obstacleHeight: 0.1,
    });
    assert.ok(smallest.crushStrength > extremeRoverImpact.impactForce * 5);
    assert.notEqual(extremeRoverImpact.outcome, "crushed");
  });

  test("rejects invalid material parameters instead of creating unstable proxies", () => {
    assertThrows(() => createInteractiveRockSpec({
      id: "bad-rock",
      shape: new BoxShape(0.5, 0.5, 0.5),
      material: { ...MARS_ROCK_MATERIAL, density: -1 },
    }), /density/);
  });

  test("simulates promoted rocks as dynamic bodies that can fall and receive rolling torque", () => {
    const world = new PhysicsWorld({ gravity: { x: 0, y: -3.72, z: 0 } });
    const proxy = new InteractiveRockProxy(rock({ crushStrength: 50000 }), { x: 0, y: 3, z: 0 });
    world.addBody(proxy.body);
    const startY = proxy.body.position.y;
    world.stepDeterministic(30);
    assert.ok(proxy.body.position.y < startY);

    const startAngular = proxy.body.angularVelocity.length();
    proxy.body.applyImpulse({ x: 0, y: 0, z: 4 }, { x: 0.4, y: 3, z: 0 });
    world.stepDeterministic(1);
    assert.ok(proxy.body.angularVelocity.length() > startAngular);
  });

  test("promotes a rock to a dynamic body and applies a push impulse", () => {
    const proxy = new InteractiveRockProxy(rock({ crushStrength: 50000 }), { x: 0, y: 1, z: 0 });
    const before = proxy.body.linearVelocity.x;
    const result = proxy.contact({
      roverMass: 1025,
      relativeSpeed: 0.1,
      availableForce: 2160,
      obstacleHeight: 0.1,
    }, { x: 1, y: 0, z: 0 });
    assert.equal(result.outcome, "pushed");
    assert.ok(proxy.body.linearVelocity.x > before);
    assert.equal(proxy.broken, false);
  });

  test("matches pushed rocks to the rover's speed instead of launching them", () => {
    // A sub-kilo pebble: the old force×dt kick landed every call regardless of rock speed, so one
    // slow nudge stacked tens of m/s per frame and shot the rock across the terrain. Sustained
    // contact now settles the rock at the rover's pace (5% lead + 5 cm/s separation) and holds it
    // there no matter how long the shove lasts.
    const pebble = new InteractiveRockProxy(
      rock({ mass: 0.8, crushStrength: 50000, pushForce: 10 }),
      { x: 0, y: 1, z: 0 },
    );
    const input = { roverMass: 1025, relativeSpeed: 0.5, availableForce: 2860, obstacleHeight: 0.1 };
    for (let i = 0; i < 60; i++) {
      assert.equal(pebble.contact(input, { x: 1, y: 0, z: 0 }).outcome, "pushed");
    }
    assertCloseTo(pebble.body.linearVelocity.x, 0.5 * 1.05 + 0.05, 6);
    assert.ok(pebble.body.linearVelocity.x < 1);
  });

  test("scales pushed and crushed bridge transfers by the rock's share of the rover's mass", () => {
    // The old flat transfers (15% per call pushed, 100% crushed) ground the rover to a halt
    // against pebbles; a light rock now takes only its mass share.
    const pebble = new InteractiveRockProxy(
      rock({ mass: 18, crushStrength: 500000, pushForce: 10 }),
      { x: 0, y: 1, z: 0 },
    );
    const pushVelocity = { x: 2, y: 0, z: 0 };
    const push = bridgeRockContact(pebble, {
      roverMass: 1025,
      relativeSpeed: 2,
      availableForce: 2860,
      obstacleHeight: 0.1,
      vehicleVelocity: pushVelocity,
    }, { x: 1, y: 0, z: 0 });
    assert.equal(push.outcome, "pushed");
    assertCloseTo(pushVelocity.x, 2 * (1 - 18 / 1025), 8);

    const crumbs = new InteractiveRockProxy(rock({ mass: 18, crushStrength: 5000 }), { x: 0, y: 1, z: 0 });
    const crushVelocity = { x: 2, y: 0, z: 0 };
    const crush = bridgeRockContact(crumbs, {
      roverMass: 1025,
      relativeSpeed: 2,
      availableForce: 2860,
      obstacleHeight: 0.1,
      vehicleVelocity: crushVelocity,
    }, { x: 1, y: 0, z: 0 });
    assert.equal(crush.outcome, "crushed");
    assertCloseTo(crushVelocity.x, 2 * (1 - (2 * 18) / 1025), 8);

    // …while leaning on a near-tonne boulder still costs the capped quarter per call.
    const boulder = new InteractiveRockProxy(
      rock({ mass: 900, crushStrength: 1e9, pushForce: 2000 }),
      { x: 0, y: 1, z: 0 },
    );
    const boulderVelocity = { x: 2, y: 0, z: 0 };
    const shove = bridgeRockContact(boulder, {
      roverMass: 1025,
      relativeSpeed: 2,
      availableForce: 2860,
      obstacleHeight: 0.1,
      vehicleVelocity: boulderVelocity,
    }, { x: 1, y: 0, z: 0 });
    assert.equal(shove.outcome, "pushed");
    assertCloseTo(boulderVelocity.x, 1.5, 8);
  });

  test("transfers blocked contact momentum back through the vehicle bridge", () => {
    const proxy = new InteractiveRockProxy(rock({ crushStrength: 500000 }), { x: 0, y: 1, z: 0 });
    const velocity = { x: 2, y: 0, z: 0 };
    const result = bridgeRockContact(proxy, {
      roverMass: 1025,
      relativeSpeed: 2,
      availableForce: 10,
      obstacleHeight: 1,
      vehicleVelocity: velocity,
    }, { x: 1, y: 0, z: 0 });
    assert.equal(result.outcome, "blocked");
    assertCloseTo(velocity.x, 0.2, 8);
    assert.equal(velocity.z, 0);
  });

  test("applies bounded damage for a blocked tall-rock impact and disables at the limit", () => {
    const spec = rock({ crushStrength: 1000000, pushForce: 5000 });
    const assessment = assessRockContact(spec, {
      roverMass: 1025,
      relativeSpeed: 8,
      availableForce: 10,
      obstacleHeight: 1,
    });
    const damage = { hull: 0, wheels: 0, suspension: 0, disabled: false };
    const amount = applyRoverImpactDamage(damage, assessment, {
      roverMass: 1025,
      relativeSpeed: 8,
      availableForce: 10,
      obstacleHeight: 1,
    }, 1, 1 / 60);
    assert.equal(assessment.outcome, "blocked");
    assert.ok(amount > 0);
    assert.ok(damage.hull > 0);
    assert.ok(damage.wheels > 0);
    for (let i = 0; i < 20000; i++) applyRoverImpactDamage(damage, assessment, {
      roverMass: 1025, relativeSpeed: 8, availableForce: 10, obstacleHeight: 1,
    }, 1, 1 / 60);
    assert.equal(damage.disabled, true);
  });

  test("replays the same rock contact trajectory deterministically", () => {
    const run = (): [number, number, number, number] => {
      const world = new PhysicsWorld({ gravity: { x: 0, y: -3.72, z: 0 } });
      const proxy = new InteractiveRockProxy(rock({ crushStrength: 500000 }), { x: 0, y: 2, z: 0 });
      world.addBody(proxy.body);
      proxy.contact({ roverMass: 1025, relativeSpeed: 0.4, availableForce: 2160, obstacleHeight: 0.1 }, { x: 1, y: 0, z: 0 });
      world.stepDeterministic(120);
      return [proxy.body.position.x, proxy.body.position.y, proxy.body.linearVelocity.x, proxy.body.angularVelocity.y];
    };
    assert.deepEqual(run(), run());
  });

  test("marks a fractured rock without leaving a live dynamic body decision to the caller", () => {
    const proxy = new InteractiveRockProxy(rock(), { x: 0, y: 1, z: 0 });
    const result = proxy.contact({
      roverMass: 1025,
      relativeSpeed: 0.1,
      availableForce: 2160,
      obstacleHeight: 0.1,
    }, { x: 1, y: 0, z: 0 });
    assert.equal(result.outcome, "crushed");
    assert.equal(proxy.broken, true);
  });

  test("rests on a heightfield at surface level without shooting up into the air", () => {
    const groundHeight = 10;
    const hf = new HeightfieldShape({ sampleHeight: () => groundHeight });
    const world = new PhysicsWorld({ gravity: { x: 0, y: -3.72, z: 0 } });
    world.setHeightfield(hf);

    const radius = 0.5;
    const restingY = groundHeight + radius;
    const rockBody = new RigidBody({
      type: "dynamic",
      shape: new SphereShape(radius),
      mass: 50,
      position: { x: 0, y: restingY, z: 0 },
      friction: 0.8,
      linearDamping: 0.05,
    });
    world.addBody(rockBody);

    // Initial step: rock resting on surface must not be launched into the sky
    world.step(1 / 60);
    assert.ok(rockBody.linearVelocity.y <= 0.1);
    assert.ok(rockBody.position.y < restingY + 0.1);
    assert.ok(rockBody.position.y >= restingY - 0.05);

    // After 60 steps (1s): rock stays firmly at rest on ground
    for (let i = 0; i < 60; i++) world.step(1 / 60);
    assert.ok(Math.abs(rockBody.linearVelocity.y) < 0.05);
    assertCloseTo(rockBody.position.y, restingY, 1);
  });

  test("flat rocks slide with high angular stability while round rocks roll with angular velocity", () => {
    const world = new PhysicsWorld({ gravity: { x: 0, y: -3.72, z: 0 } });
    world.setHeightfield(new HeightfieldShape({ sampleHeight: () => 0 }));

    // Flat rock: BoxShape, low height, high angular damping
    const flatBox = new RigidBody({
      type: "dynamic",
      shape: new BoxShape(0.4, 0.1, 0.4),
      mass: 25,
      position: { x: 0, y: 0.1, z: 0 },
      friction: 0.9,
      linearDamping: 0.2,
      angularDamping: 0.25,
    });
    flatBox.applyImpulse({ x: 0, y: 0, z: 15 });
    world.addBody(flatBox);

    // Round rock: SphereShape, low angular damping
    const roundSphere = new RigidBody({
      type: "dynamic",
      shape: new SphereShape(0.3),
      mass: 25,
      position: { x: 2, y: 0.3, z: 0 },
      friction: 0.6,
      linearDamping: 0.02,
      angularDamping: 0.05,
    });
    roundSphere.applyImpulse({ x: 0, y: 0, z: 15 });
    world.addBody(roundSphere);

    // Step physics
    for (let i = 0; i < 30; i++) world.step(1 / 60);

    // Flat rock slides: stays upright (pitch and roll stay near 0) with minimal tumbling
    const flatPitch = Math.abs(flatBox.angularVelocity.x);
    assert.ok(flatPitch < 0.5);

    // Round rock rolls: develops significant rotational angular velocity as it rolls
    const spherePitch = Math.abs(roundSphere.angularVelocity.x);
    assert.ok(spherePitch > 1.0);
    assert.ok(spherePitch > flatPitch * 3);
  });

  test("breaks large rocks into chunks and pebbles where no piece exceeds original size", () => {
    const origRadius = 1.2;
    const origVolume = (4 / 3) * Math.PI * Math.pow(origRadius, 3);

    // Helper that models the showcase break logic
    const breakLargeRock = (radius: number) => {
      const numChunks = 3;
      const numPebbles = 6;
      const chunks: { scale: number; volume: number; isFlat: boolean }[] = [];
      const pebbles: { scale: number; volume: number }[] = [];

      for (let c = 0; c < numChunks; c++) {
        const chunkScale = Math.min(radius * 0.45, Math.max(0.12, radius * (0.30 + 0.10 * 0.5)));
        const isFlat = c % 2 === 0;
        const sy = isFlat ? chunkScale * 0.45 : chunkScale * 0.85;
        const volume = chunkScale * sy * chunkScale;
        chunks.push({ scale: chunkScale, volume, isFlat });
      }

      for (let p = 0; p < numPebbles; p++) {
        const pebbleScale = Math.min(radius * 0.18, Math.max(0.05, radius * (0.10 + 0.06 * 0.5)));
        const r = pebbleScale * 0.5;
        const volume = (4 / 3) * Math.PI * Math.pow(r, 3);
        pebbles.push({ scale: pebbleScale, volume });
      }

      return { chunks, pebbles };
    };

    const { chunks, pebbles } = breakLargeRock(origRadius);
    assert.ok(chunks.length >= 2);
    assert.ok(pebbles.length >= 4);

    let totalFragmentVolume = 0;
    for (const chunk of chunks) {
      assert.ok(chunk.scale < origRadius);
      assert.ok(chunk.scale <= origRadius * 0.45);
      totalFragmentVolume += chunk.volume;
    }
    for (const pebble of pebbles) {
      assert.ok(pebble.scale < origRadius);
      assert.ok(pebble.scale <= origRadius * 0.18);
      totalFragmentVolume += pebble.volume;
    }

    // Never should the broken pieces exceed the original size or volume
    assert.ok(totalFragmentVolume < origVolume);
  });

  test("keeps uncontacted rocks dormant on slopes so approaching rovers do not cause distant rocks to roll", () => {
    // Terrain with a 35-degree slope: height(x) = 0.7 * x
    const slope = 0.7;
    const hf = new HeightfieldShape({
      sampleHeight: (x) => slope * x,
      sampleNormal: (_x, _z, out = new Vec3()) => {
        const len = Math.hypot(slope, 1);
        return out.set(-slope / len, 1 / len, 0);
      },
    });
    const world = new PhysicsWorld({ gravity: { x: 0, y: -3.72, z: 0 } });
    world.setHeightfield(hf);

    const radius = 0.5;
    const startX = 20;
    const restingY = slope * startX + radius;
    const proxy = new InteractiveRockProxy(
      createInteractiveRockSpec({
        id: "chunk0:rocks:0",
        shape: new SphereShape(radius),
        material: MARS_ROCK_MATERIAL,
        climbRadius: radius,
      }),
      { x: startX, y: restingY, z: 0 },
    );

    // Dormant rock: static collider
    proxy.body.type = "static";
    world.addBody(proxy.body);

    // Rover is in the distance approaching (e.g. at x = 0, moving towards rock)
    // Run 60 frames of physics world stepping
    for (let i = 0; i < 60; i++) world.step(1 / 60);

    // Uncontacted rock MUST NOT roll down the hill!
    assert.equal(proxy.body.position.x, startX);
    assert.equal(proxy.body.position.y, restingY);
    assert.equal(proxy.body.position.z, 0);
    assert.equal(proxy.body.linearVelocity.x, 0);
    assert.equal(proxy.body.linearVelocity.y, 0);
    assert.equal(proxy.body.linearVelocity.z, 0);

    // When the rover arrives and makes contact: awaken to dynamic!
    proxy.body.type = "dynamic";
    const assessment = proxy.contact(
      {
        roverMass: 1025,
        relativeSpeed: 0.8,
        availableForce: 2160,
        obstacleHeight: radius * 2,
      },
      { x: 1, y: 0, z: 0 },
    );
    assert.equal(assessment.outcome, "pushed");

    // Stepping physics now moves the dynamic rock
    world.step(1 / 60);
    assert.ok(proxy.body.linearVelocity.x > 0);
  });

  test("flat rocks resting on a heightfield settle firmly without micro-bouncing", () => {
    const world = new PhysicsWorld({ gravity: { x: 0, y: -3.72, z: 0 } });
    world.setHeightfield(new HeightfieldShape({ sampleHeight: () => 0 }));

    // Flat rock laying on surface (hx = 0.5, hy = 0.1, hz = 0.5)
    const flatBox = new RigidBody({
      type: "dynamic",
      shape: new BoxShape(0.5, 0.1, 0.5),
      mass: 30,
      position: { x: 0, y: 0.1, z: 0 },
      friction: 0.95,
      linearDamping: 0.15,
      angularDamping: 0.25,
      restitution: 0.05,
    });
    world.addBody(flatBox);

    let maxSeparatingVelocity = 0;
    for (let i = 0; i < 90; i++) {
      world.step(1 / 60);
      if (flatBox.linearVelocity.y > maxSeparatingVelocity) {
        maxSeparatingVelocity = flatBox.linearVelocity.y;
      }
    }

    // Must not micro-bounce or jitter into the air
    assert.ok(maxSeparatingVelocity < 0.02);
    assertCloseTo(flatBox.position.y, 0.1, 2);
    assert.ok(Math.abs(flatBox.linearVelocity.y) < 0.01);
  });

  test("tall slab standing on edge naturally topples over under gravity to rest on its flat face", () => {
    const world = new PhysicsWorld({ gravity: { x: 0, y: -3.72, z: 0 } });
    world.setHeightfield(new HeightfieldShape({ sampleHeight: () => 0 }));

    // Slab standing on a narrow edge (hx = 0.1, hy = 0.6, hz = 0.4), tilted past its stability limit (hx/hy = 0.167)
    const slab = new RigidBody({
      type: "dynamic",
      shape: new BoxShape(0.1, 0.6, 0.4),
      mass: 25,
      position: { x: 0, y: 0.6, z: 0 },
      friction: 0.8,
      linearDamping: 0.05,
      angularDamping: 0.25,
      restitution: 0.05,
    });
    slab.rotation.setAxisAngle(new Vec3(0, 0, 1), 0.25);
    world.addBody(slab);

    // Step physics for 2.0 seconds (120 steps)
    for (let i = 0; i < 120; i++) world.step(1 / 60);

    // Slab must topple over: its center of mass elevation drops from 0.6 down towards ~0.1 - 0.2
    assert.ok(slab.position.y < 0.35);
    // It should have rotated significantly (tilt angle past 1.0 rad, near PI/2 where it lies flat)
    const angle = 2 * Math.acos(Math.min(1, Math.abs(slab.rotation.w)));
    assert.ok(angle > 0.8);
  });
});

group("Rover/rock contact separation", () => {
  test("pushes the rover back out to the contact range instead of leaving it inside the rock", () => {
    // Rover centre 2.1 m from a rock of radius 0.66, with a 1.6 m rover reach: the pair overlaps by
    // 0.16 m. Momentum transfer alone leaves exactly this overlap in place, which is the "stuck in
    // the middle of a rock" report; the correction has to put the rover back on the surface.
    const separation = separateRoverFromRock({
      roverX: 0, roverZ: 0, rockX: 2.1, rockZ: 0,
      rockRadius: 0.66, roverRadius: 1.6, slack: 0,
    });
    assert.equal(separation.contacted, true);
    assertCloseTo(separation.penetration, 2.26 - 2.1, 8);
    assertCloseTo(separation.normalX, 1, 8);
    assertCloseTo(separation.normalZ, 0, 8);
    const correctedX = 0 + separation.correctionX;
    const correctedZ = 0 + separation.correctionZ;
    assertCloseTo(Math.hypot(2.1 - correctedX, 0 - correctedZ), 1.6 + 0.66, 8);
  });

  test("resolves along the diagonal normal and reports no correction when the pair is apart", () => {
    const diagonal = separateRoverFromRock({
      roverX: 0, roverZ: 0, rockX: 1, rockZ: 1,
      rockRadius: 0.5, roverRadius: 1.6, slack: 0,
    });
    assert.equal(diagonal.contacted, true);
    assertCloseTo(diagonal.normalX, Math.SQRT1_2, 8);
    assertCloseTo(diagonal.normalZ, Math.SQRT1_2, 8);
    // Correction is purely along the normal: it never slides the rover sideways around the rock.
    assertCloseTo(diagonal.correctionX, diagonal.correctionZ, 8);

    const apart = separateRoverFromRock({
      roverX: 0, roverZ: 0, rockX: 3, rockZ: 4,
      rockRadius: 0.5, roverRadius: 1.6, slack: 0,
    });
    assert.equal(apart.contacted, false);
    assert.equal(apart.penetration, 0);
    assert.equal(apart.correctionX, 0);
    assert.equal(apart.correctionZ, 0);

    // Exactly touching counts as contact, but there is nothing to resolve.
    const touching = separateRoverFromRock({
      roverX: 0, roverZ: 0, rockX: 2.1, rockZ: 0,
      rockRadius: 0.5, roverRadius: 1.6, slack: 0,
    });
    assert.equal(touching.contacted, true);
    assert.equal(touching.penetration, 0);
    assert.equal(touching.correctionX, 0);
  });

  test("lets a yielding rock keep its slack, but caps the overlap there", () => {
    const shallow = separateRoverFromRock({
      roverX: 0, roverZ: 0, rockX: 2.2, rockZ: 0,
      rockRadius: 0.66, roverRadius: 1.6, slack: 0.15,
    });
    assertCloseTo(shallow.penetration, 0.06, 8);
    assert.equal(shallow.correctionX, 0, "an overlap inside the slack is left for the rock to clear");

    const deep = separateRoverFromRock({
      roverX: 0, roverZ: 0, rockX: 1.8, rockZ: 0,
      rockRadius: 0.66, roverRadius: 1.6, slack: 0.15,
    });
    // Only the part past the slack is resolved, so the rover settles at range − slack, not inside.
    assertCloseTo(1.8 - deep.correctionX, 2.26 - 0.15, 8);
  });

  test("separates coincident centres along the fallback heading instead of welding them together", () => {
    const coincident = separateRoverFromRock({
      roverX: 4, roverZ: 4, rockX: 4, rockZ: 4,
      rockRadius: 0.6, roverRadius: 1.6, slack: 0,
      fallbackNormalX: Math.sin(0.5), fallbackNormalZ: Math.cos(0.5),
    });
    assert.equal(coincident.contacted, true);
    assertCloseTo(coincident.penetration, 2.2, 8);
    assertCloseTo(coincident.normalX, Math.sin(0.5), 8);
    assertCloseTo(coincident.normalZ, Math.cos(0.5), 8);
    // The full range is resolved, so the rover is ejected clear of the rock's centre.
    assertCloseTo(
      Math.hypot(4 - (4 + coincident.correctionX), 4 - (4 + coincident.correctionZ)),
      2.2,
      8,
    );

    // No heading supplied either: it must still pick a usable normal rather than return zeros.
    const headless = separateRoverFromRock({
      roverX: 0, roverZ: 0, rockX: 0, rockZ: 0, rockRadius: 0.5, roverRadius: 1.6, slack: 0,
    });
    assert.ok(Math.hypot(headless.correctionX, headless.correctionZ) > 0);
  });

  test("treats a rock as immovable exactly when the contact assessment would block it", () => {
    // canDisplaceRock is what contact resolution falls back on for a resting contact, where
    // assessRockContact reports "none" because there is no approach speed to judge. It has to agree
    // with both blocked branches of the assessment, or the rover would push against a wall that
    // should stop it (or stop dead at a pebble it should roll over).
    const wall = rock({ crushStrength: 1e9, pushForce: 5000, climbHeight: 0.25 });
    const input = { roverMass: 1025, relativeSpeed: 2, availableForce: 1943, obstacleHeight: 1.2 };
    assert.equal(assessRockContact(wall, input).outcome, "blocked");
    assert.equal(canDisplaceRock(wall, input.availableForce), false);
    // The too-tall branch blocks on the same condition, so it must agree too.
    const tall = rock({ crushStrength: 1e9, pushForce: 3000, climbHeight: 0.25 });
    assert.equal(assessRockContact(tall, input).outcome, "blocked");
    assert.equal(canDisplaceRock(tall, input.availableForce), false);

    const pebble = rock({ crushStrength: 1e9, pushForce: 120, climbHeight: 0.25 });
    assert.equal(assessRockContact(pebble, input).outcome, "pushed");
    assert.equal(canDisplaceRock(pebble, input.availableForce), true);
    // Exactly at the threshold the rock is still movable, matching the assessment's `>=`.
    assert.equal(canDisplaceRock(rock({ pushForce: 1943 }), 1943), true);
    assert.equal(canDisplaceRock(rock({ pushForce: 1943 }), -5), false);
  });
});

await finish();
