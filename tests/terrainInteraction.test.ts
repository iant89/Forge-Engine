import { describe, expect, it } from "vitest";
import {
  applyRoverImpactDamage,
  BoxShape,
  InteractiveRockProxy,
  MARS_ROCK_MATERIAL,
  PhysicsWorld,
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
});
