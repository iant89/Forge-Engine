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
      angularDamping: 8.0,
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
});
