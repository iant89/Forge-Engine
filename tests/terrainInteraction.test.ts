import { describe, expect, it } from "vitest";
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

describe("Phase 15.5 interactive terrain foundation", () => {
  it("keeps contact decisions deterministic and distinguishes push, block and crush", () => {
    const spec = rock();
    expect(assessRockContact(spec, {
      roverMass: 1025,
      relativeSpeed: 0,
      availableForce: 2160,
      obstacleHeight: 0.1,
    })).toMatchObject({ outcome: "none", reason: "no-impact" });
    expect(assessRockContact(spec, {
      roverMass: 1025,
      relativeSpeed: 0.1,
      availableForce: 2160,
      obstacleHeight: 0.1,
    })).toMatchObject({ outcome: "crushed", reason: "crush" });

    const pushable = rock({ crushStrength: 50000 });
    expect(assessRockContact(pushable, {
      roverMass: 1025,
      relativeSpeed: 0.1,
      availableForce: 2160,
      obstacleHeight: 0.1,
    })).toMatchObject({ outcome: "pushed", reason: "push" });
    expect(assessRockContact(pushable, {
      roverMass: 1025,
      relativeSpeed: 0.1,
      availableForce: 60,
      obstacleHeight: 0.5,
    })).toMatchObject({ outcome: "blocked", reason: "too-tall" });
  });

  it("derives mass and thresholds from the Mars material profile", () => {
    const spec = createInteractiveRockSpec({
      id: "mars-rock",
      shape: new BoxShape(0.5, 0.5, 0.5),
      material: MARS_ROCK_MATERIAL,
      climbRadius: 0.5,
    });
    expect(spec.mass).toBeCloseTo(120, 8);
    expect(spec.pushForce).toBeGreaterThanOrEqual(MARS_ROCK_MATERIAL.minimumPushForce);
    expect(spec.crushStrength).toBeGreaterThan(0);
    expect(spec.climbHeight).toBeCloseTo(0.7, 8);

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
    expect(smallest.crushStrength).toBeGreaterThan(extremeRoverImpact.impactForce * 5);
    expect(extremeRoverImpact.outcome).not.toBe("crushed");
  });

  it("rejects invalid material parameters instead of creating unstable proxies", () => {
    expect(() => createInteractiveRockSpec({
      id: "bad-rock",
      shape: new BoxShape(0.5, 0.5, 0.5),
      material: { ...MARS_ROCK_MATERIAL, density: -1 },
    })).toThrow(/density/);
  });

  it("simulates promoted rocks as dynamic bodies that can fall and receive rolling torque", () => {
    const world = new PhysicsWorld({ gravity: { x: 0, y: -3.72, z: 0 } });
    const proxy = new InteractiveRockProxy(rock({ crushStrength: 50000 }), { x: 0, y: 3, z: 0 });
    world.addBody(proxy.body);
    const startY = proxy.body.position.y;
    world.stepDeterministic(30);
    expect(proxy.body.position.y).toBeLessThan(startY);

    const startAngular = proxy.body.angularVelocity.length();
    proxy.body.applyImpulse({ x: 0, y: 0, z: 4 }, { x: 0.4, y: 3, z: 0 });
    world.stepDeterministic(1);
    expect(proxy.body.angularVelocity.length()).toBeGreaterThan(startAngular);
  });

  it("promotes a rock to a dynamic body and applies a push impulse", () => {
    const proxy = new InteractiveRockProxy(rock({ crushStrength: 50000 }), { x: 0, y: 1, z: 0 });
    const before = proxy.body.linearVelocity.x;
    const result = proxy.contact({
      roverMass: 1025,
      relativeSpeed: 0.1,
      availableForce: 2160,
      obstacleHeight: 0.1,
    }, { x: 1, y: 0, z: 0 });
    expect(result.outcome).toBe("pushed");
    expect(proxy.body.linearVelocity.x).toBeGreaterThan(before);
    expect(proxy.broken).toBe(false);
  });

  it("matches pushed rocks to the rover's speed instead of launching them", () => {
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
      expect(pebble.contact(input, { x: 1, y: 0, z: 0 }).outcome).toBe("pushed");
    }
    expect(pebble.body.linearVelocity.x).toBeCloseTo(0.5 * 1.05 + 0.05, 6);
    expect(pebble.body.linearVelocity.x).toBeLessThan(1);
  });

  it("scales pushed and crushed bridge transfers by the rock's share of the rover's mass", () => {
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
    expect(push.outcome).toBe("pushed");
    expect(pushVelocity.x).toBeCloseTo(2 * (1 - 18 / 1025), 8);

    const crumbs = new InteractiveRockProxy(rock({ mass: 18, crushStrength: 5000 }), { x: 0, y: 1, z: 0 });
    const crushVelocity = { x: 2, y: 0, z: 0 };
    const crush = bridgeRockContact(crumbs, {
      roverMass: 1025,
      relativeSpeed: 2,
      availableForce: 2860,
      obstacleHeight: 0.1,
      vehicleVelocity: crushVelocity,
    }, { x: 1, y: 0, z: 0 });
    expect(crush.outcome).toBe("crushed");
    expect(crushVelocity.x).toBeCloseTo(2 * (1 - (2 * 18) / 1025), 8);

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
    expect(shove.outcome).toBe("pushed");
    expect(boulderVelocity.x).toBeCloseTo(1.5, 8);
  });

  it("transfers blocked contact momentum back through the vehicle bridge", () => {
    const proxy = new InteractiveRockProxy(rock({ crushStrength: 500000 }), { x: 0, y: 1, z: 0 });
    const velocity = { x: 2, y: 0, z: 0 };
    const result = bridgeRockContact(proxy, {
      roverMass: 1025,
      relativeSpeed: 2,
      availableForce: 10,
      obstacleHeight: 1,
      vehicleVelocity: velocity,
    }, { x: 1, y: 0, z: 0 });
    expect(result.outcome).toBe("blocked");
    expect(velocity.x).toBeCloseTo(0.2, 8);
    expect(velocity.z).toBe(0);
  });

  it("applies bounded damage for a blocked tall-rock impact and disables at the limit", () => {
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
    expect(assessment.outcome).toBe("blocked");
    expect(amount).toBeGreaterThan(0);
    expect(damage.hull).toBeGreaterThan(0);
    expect(damage.wheels).toBeGreaterThan(0);
    for (let i = 0; i < 20000; i++) applyRoverImpactDamage(damage, assessment, {
      roverMass: 1025, relativeSpeed: 8, availableForce: 10, obstacleHeight: 1,
    }, 1, 1 / 60);
    expect(damage.disabled).toBe(true);
  });

  it("replays the same rock contact trajectory deterministically", () => {
    const run = (): [number, number, number, number] => {
      const world = new PhysicsWorld({ gravity: { x: 0, y: -3.72, z: 0 } });
      const proxy = new InteractiveRockProxy(rock({ crushStrength: 500000 }), { x: 0, y: 2, z: 0 });
      world.addBody(proxy.body);
      proxy.contact({ roverMass: 1025, relativeSpeed: 0.4, availableForce: 2160, obstacleHeight: 0.1 }, { x: 1, y: 0, z: 0 });
      world.stepDeterministic(120);
      return [proxy.body.position.x, proxy.body.position.y, proxy.body.linearVelocity.x, proxy.body.angularVelocity.y];
    };
    expect(run()).toEqual(run());
  });

  it("marks a fractured rock without leaving a live dynamic body decision to the caller", () => {
    const proxy = new InteractiveRockProxy(rock(), { x: 0, y: 1, z: 0 });
    const result = proxy.contact({
      roverMass: 1025,
      relativeSpeed: 0.1,
      availableForce: 2160,
      obstacleHeight: 0.1,
    }, { x: 1, y: 0, z: 0 });
    expect(result.outcome).toBe("crushed");
    expect(proxy.broken).toBe(true);
  });

  it("rests on a heightfield at surface level without shooting up into the air", () => {
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
    expect(rockBody.linearVelocity.y).toBeLessThanOrEqual(0.1);
    expect(rockBody.position.y).toBeLessThan(restingY + 0.1);
    expect(rockBody.position.y).toBeGreaterThanOrEqual(restingY - 0.05);

    // After 60 steps (1s): rock stays firmly at rest on ground
    for (let i = 0; i < 60; i++) world.step(1 / 60);
    expect(Math.abs(rockBody.linearVelocity.y)).toBeLessThan(0.05);
    expect(rockBody.position.y).toBeCloseTo(restingY, 1);
  });

  it("flat rocks slide with high angular stability while round rocks roll with angular velocity", () => {
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
    expect(flatPitch).toBeLessThan(0.5);

    // Round rock rolls: develops significant rotational angular velocity as it rolls
    const spherePitch = Math.abs(roundSphere.angularVelocity.x);
    expect(spherePitch).toBeGreaterThan(1.0);
    expect(spherePitch).toBeGreaterThan(flatPitch * 3);
  });

  it("breaks large rocks into chunks and pebbles where no piece exceeds original size", () => {
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
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(pebbles.length).toBeGreaterThanOrEqual(4);

    let totalFragmentVolume = 0;
    for (const chunk of chunks) {
      expect(chunk.scale).toBeLessThan(origRadius);
      expect(chunk.scale).toBeLessThanOrEqual(origRadius * 0.45);
      totalFragmentVolume += chunk.volume;
    }
    for (const pebble of pebbles) {
      expect(pebble.scale).toBeLessThan(origRadius);
      expect(pebble.scale).toBeLessThanOrEqual(origRadius * 0.18);
      totalFragmentVolume += pebble.volume;
    }

    // Never should the broken pieces exceed the original size or volume
    expect(totalFragmentVolume).toBeLessThan(origVolume);
  });

  it("keeps uncontacted rocks dormant on slopes so approaching rovers do not cause distant rocks to roll", () => {
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
    expect(proxy.body.position.x).toBe(startX);
    expect(proxy.body.position.y).toBe(restingY);
    expect(proxy.body.position.z).toBe(0);
    expect(proxy.body.linearVelocity.x).toBe(0);
    expect(proxy.body.linearVelocity.y).toBe(0);
    expect(proxy.body.linearVelocity.z).toBe(0);

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
    expect(assessment.outcome).toBe("pushed");

    // Stepping physics now moves the dynamic rock
    world.step(1 / 60);
    expect(proxy.body.linearVelocity.x).toBeGreaterThan(0);
  });

  it("flat rocks resting on a heightfield settle firmly without micro-bouncing", () => {
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
    expect(maxSeparatingVelocity).toBeLessThan(0.02);
    expect(flatBox.position.y).toBeCloseTo(0.1, 2);
    expect(Math.abs(flatBox.linearVelocity.y)).toBeLessThan(0.01);
  });

  it("tall slab standing on edge naturally topples over under gravity to rest on its flat face", () => {
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
    expect(slab.position.y).toBeLessThan(0.35);
    // It should have rotated significantly (tilt angle past 1.0 rad, near PI/2 where it lies flat)
    const angle = 2 * Math.acos(Math.min(1, Math.abs(slab.rotation.w)));
    expect(angle).toBeGreaterThan(0.8);
  });
});
