import { describe, expect, it } from "vitest";
import {
  BoxShape,
  InteractiveRockProxy,
  MARS_ROCK_MATERIAL,
  assessRockContact,
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
