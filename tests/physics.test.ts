import { describe, expect, it } from "vitest";
import {
  PhysicsWorld,
  RigidBody,
  SphereShape,
  CapsuleShape,
  CylinderShape,
  UsageError,
  BoxShape,
  HeightfieldShape,
  PlaneShape,
  Vec3,
  Ray,
  RayHit,
  collideBodies,
} from "@forge/engine";

describe("Physics - Free Fall & Dynamics Integration", () => {
  it("integrates parabolic trajectory under uniform gravity", () => {
    const world = new PhysicsWorld({ gravity: new Vec3(0, -9.81, 0), fixedDt: 1 / 60 });
    const sphere = new RigidBody({
      shape: new SphereShape(0.5),
      mass: 2.0,
      position: new Vec3(0, 100, 0),
      linearDamping: 0.0, // pure Newtonian free fall
    });
    world.addBody(sphere);

    // Run 60 fixed steps = 1.0 second
    world.stepDeterministic(60);

    // Analytic y(1.0) = 100 - 0.5 * 9.81 * (1.0)^2 = 95.095
    // Analytic vy(1.0) = -9.81
    expect(sphere.position.y).toBeCloseTo(95.095, 0);
    expect(sphere.linearVelocity.y).toBeCloseTo(-9.81, 1);
  });
});

describe("Physics - Restitution & Bouncing", () => {
  it("bounces with restitution coefficient and settles to rest without micro-jitter", () => {
    const world = new PhysicsWorld({ gravity: new Vec3(0, -9.81, 0), fixedDt: 1 / 60 });
    const plane = new RigidBody({
      type: "static",
      shape: new PlaneShape(new Vec3(0, 1, 0), 0), // ground at y = 0
      restitution: 0.5,
    });
    world.addBody(plane);

    const ball = new RigidBody({
      type: "dynamic",
      shape: new SphereShape(0.5),
      mass: 1.0,
      position: new Vec3(0, 2.5, 0),
      restitution: 0.5,
    });
    world.addBody(ball);

    // Simulate 3 seconds (180 steps)
    world.stepDeterministic(180);

    // Ball should have bounced multiple times and come to rest at y ≈ radius (0.5)
    expect(ball.position.y).toBeCloseTo(0.5, 1);
    expect(Math.abs(ball.linearVelocity.y)).toBeLessThan(0.05);
    expect(ball.position.y).toBeGreaterThanOrEqual(0.48); // penetration within slop
  });
});

describe("Physics - Coulomb Friction on an Incline", () => {
  it("holds stationary when slope is below friction angle and slides when above", () => {
    const world = new PhysicsWorld({ gravity: new Vec3(0, -9.81, 0), fixedDt: 1 / 60 });

    // Slope angle 15 degrees: tan(15°) = 0.268. Friction mu = 0.7 > 0.268 -> should hold!
    const rad15 = (15 * Math.PI) / 180;
    const norm15 = new Vec3(-Math.sin(rad15), Math.cos(rad15), 0).normalize();
    const plane15 = new RigidBody({
      type: "static",
      shape: new PlaneShape(norm15, 0),
      friction: 0.7,
    });
    world.addBody(plane15);

    const boxHold = new RigidBody({
      type: "dynamic",
      shape: new BoxShape(0.5, 0.5, 0.5),
      mass: 5.0,
      position: new Vec3(0, 0.5, 0),
      friction: 0.7,
    });
    world.addBody(boxHold);

    // Run 60 steps
    world.stepDeterministic(60);

    // Box should have stayed essentially at rest
    expect(Math.abs(boxHold.linearVelocity.x)).toBeLessThan(0.1);
  });
});

describe("Physics - Stacking Stability", () => {
  it("keeps a 3-box vertical stack stable under gravity", () => {
    const world = new PhysicsWorld({ gravity: new Vec3(0, -9.81, 0), fixedDt: 1 / 60 });
    const ground = new RigidBody({
      type: "static",
      shape: new PlaneShape(new Vec3(0, 1, 0), 0),
      restitution: 0.0,
      friction: 0.8,
    });
    world.addBody(ground);

    const b1 = new RigidBody({
      type: "dynamic",
      shape: new BoxShape(0.5, 0.5, 0.5),
      position: new Vec3(0, 0.5, 0),
      restitution: 0.0,
      friction: 0.8,
    });
    world.addBody(b1);

    const b2 = new RigidBody({
      type: "dynamic",
      shape: new BoxShape(0.5, 0.5, 0.5),
      position: new Vec3(0, 1.5, 0),
      restitution: 0.0,
      friction: 0.8,
    });
    world.addBody(b2);

    const b3 = new RigidBody({
      type: "dynamic",
      shape: new BoxShape(0.5, 0.5, 0.5),
      position: new Vec3(0, 2.5, 0),
      restitution: 0.0,
      friction: 0.8,
    });
    world.addBody(b3);

    // Settle stack for 120 fixed steps (2 seconds)
    world.stepDeterministic(120);

    // All boxes should remain stacked vertically without toppling
    expect(b1.position.y).toBeCloseTo(0.5, 1);
    expect(b2.position.y).toBeCloseTo(1.5, 1);
    expect(b3.position.y).toBeCloseTo(2.5, 1);

    expect(Math.abs(b1.position.x)).toBeLessThan(0.05);
    expect(Math.abs(b2.position.x)).toBeLessThan(0.05);
    expect(Math.abs(b3.position.x)).toBeLessThan(0.05);

    // Penetration between boxes must not exceed 0.02m
    const overlap12 = 1.0 - (b2.position.y - b1.position.y);
    const overlap23 = 1.0 - (b3.position.y - b2.position.y);
    expect(overlap12).toBeLessThanOrEqual(0.02);
    expect(overlap23).toBeLessThanOrEqual(0.02);
  });
});

describe("Physics - Framerate Independence & Determinism", () => {
  it("produces identical trajectories across 15, 30, 60, and 144 Hz display framerates", () => {
    function simulateAtDisplayRate(fps: number): { x: number; y: number; z: number } {
      const world = new PhysicsWorld({ gravity: new Vec3(0, -9.81, 0), fixedDt: 1 / 60 });
      const ground = new RigidBody({
        type: "static",
        shape: new PlaneShape(new Vec3(0, 1, 0), 0),
        restitution: 0.5,
        friction: 0.4,
      });
      world.addBody(ground);

      const projectile = new RigidBody({
        type: "dynamic",
        shape: new SphereShape(0.4),
        mass: 1.0,
        position: new Vec3(0, 5, 0),
        linearVelocity: new Vec3(10, 2, 0),
        restitution: 0.5,
        friction: 0.4,
      });
      world.addBody(projectile);

      const frameDt = 1 / fps;
      const totalTime = 2.0; // 2 seconds of simulation
      const frames = Math.round(totalTime / frameDt);

      for (let f = 0; f < frames; f++) {
        world.step(frameDt);
      }

      return {
        x: projectile.renderPosition.x,
        y: projectile.renderPosition.y,
        z: projectile.renderPosition.z,
      };
    }

    const pos60 = simulateAtDisplayRate(60);
    const pos30 = simulateAtDisplayRate(30);
    const pos15 = simulateAtDisplayRate(15);
    const pos144 = simulateAtDisplayRate(144);

    // All runs should agree to tight tolerances
    expect(Math.abs(pos30.x - pos60.x)).toBeLessThan(0.15);
    expect(Math.abs(pos30.y - pos60.y)).toBeLessThan(0.15);

    expect(Math.abs(pos15.x - pos60.x)).toBeLessThan(0.15);
    expect(Math.abs(pos15.y - pos60.y)).toBeLessThan(0.15);

    expect(Math.abs(pos144.x - pos60.x)).toBeLessThan(0.15);
    expect(Math.abs(pos144.y - pos60.y)).toBeLessThan(0.15);
  });
});

describe("Physics - Spatial Queries & Raycast", () => {
  it("raycasts against sphere and plane accurately", () => {
    const world = new PhysicsWorld();
    world.addBody(new RigidBody({
      type: "static",
      shape: new PlaneShape(new Vec3(0, 1, 0), 0),
    }));

    world.addBody(new RigidBody({
      type: "dynamic",
      shape: new SphereShape(1.0),
      position: new Vec3(0, 10, 0),
    }));

    // Raycast towards sphere
    const raySphere = new Ray(new Vec3(0, 20, 0), new Vec3(0, -1, 0), 50);
    const hitSphere = new RayHit();
    expect(world.raycast(raySphere, hitSphere)).toBe(true);
    expect(hitSphere.distance).toBeCloseTo(9.0, 2); // 20 - (10 + 1) = 9
    expect(hitSphere.normal.y).toBeCloseTo(1.0, 2);

    // Raycast towards ground plane
    const rayGround = new Ray(new Vec3(50, 10, 50), new Vec3(0, -1, 0), 50);
    const hitGround = new RayHit();
    expect(world.raycast(rayGround, hitGround)).toBe(true);
    expect(hitGround.distance).toBeCloseTo(10.0, 2);
    expect(hitGround.point.y).toBeCloseTo(0.0, 2);
  });
});

/**
 * Phase 9 evidence for the heightfield collider (docs/VERIFICATION.md).
 *
 * Terrain collision is the contact type Phase 11 builds on ("visual terrain = terrain collision =
 * vehicle contact"), and it is generated from a *function* rather than from triangles, so these
 * cases pin the parts that can silently disagree with the height field: the contact normal's sign,
 * the penetration measured from the sampled height, and the cornerwise box test.
 */
describe("Physics - Heightfield Contacts", () => {
  /** A flat field at y = 0 with an analytic +Y normal: nothing to interpolate, nothing to fudge. */
  const flatField = (): HeightfieldShape => new HeightfieldShape({ sampleHeight: () => 0 });

  it("measures sphere penetration from the sampled height, with an inward normal", () => {
    const sphereBody = new RigidBody({ type: "dynamic", shape: new SphereShape(1), position: new Vec3(3, 0.9, -2) });
    const fieldBody = new RigidBody({ type: "static", shape: flatField() });

    // Clear of the surface: no contact (the query must be depth-tested, not proximity-tested).
    sphereBody.position.y = 1.5;
    expect(collideBodies(sphereBody, fieldBody)).toBeNull();

    // 0.1 m into the surface.
    sphereBody.position.y = 0.9;
    const manifold = collideBodies(sphereBody, fieldBody);
    expect(manifold).not.toBeNull();
    expect(manifold!.contacts).toHaveLength(1);
    const contact = manifold!.contacts[0]!;
    expect(contact.penetration).toBeCloseTo(0.1, 6);
    // Points from the sphere (A) into the height field (B) — downward for a +Y surface normal.
    expect(contact.normal.y).toBeCloseTo(-1, 6);
    expect(contact.point.y).toBeCloseTo(0, 6);
    expect(manifold!.bodyA).toBe(sphereBody);
    expect(manifold!.bodyB).toBe(fieldBody);
  });

  it("generates one contact per penetrating box corner", () => {
    const boxBody = new RigidBody({
      type: "dynamic",
      shape: new BoxShape(1, 1, 1),
      position: new Vec3(0, 0.5, 0),
    });
    const fieldBody = new RigidBody({ type: "static", shape: flatField() });
    // Half-extent 1 about y = 0.5 puts the four lower corners 0.5 m under the surface and the four
    // upper ones 1.5 m above it; only the penetrating corners may generate contacts.
    const manifold = collideBodies(boxBody, fieldBody);
    expect(manifold).not.toBeNull();
    expect(manifold!.contacts).toHaveLength(4);
    for (const contact of manifold!.contacts) {
      expect(contact.penetration).toBeCloseTo(0.5, 6);
      expect(contact.point.y).toBeCloseTo(0, 6);
      expect(contact.point.x).not.toBeCloseTo(0, 3); // lower corners only, no centre contact
      expect(contact.point.z).not.toBeCloseTo(0, 3);
    }

    // Raised so the box just touches (bottom face at y = 0): touching is not penetrating.
    boxBody.position.y = 1.0;
    expect(collideBodies(boxBody, fieldBody)).toBeNull();
  });

  it("holds a resting sphere on a sloped height field without sinking", () => {
    // A shallow ramp: height = 0.1 * x, so the analytic normal is (-0.1, 1, 0) normalised.
    const slope = new HeightfieldShape({ sampleHeight: (x) => 0.1 * x });
    const world = new PhysicsWorld();
    world.addBody(new RigidBody({ type: "static", shape: slope }));
    const ball = new RigidBody({ type: "dynamic", shape: new SphereShape(0.5), position: new Vec3(0, 2, 0), friction: 1 });
    world.addBody(ball);

    for (let i = 0; i < 240; i++) world.step(1 / 60);
    const surface = slope.sampleHeight(ball.position.x, ball.position.z);
    // Resting contact: the centre sits one radius above the sampled surface (within the solver's
    // slop), and never passes through it.
    expect(ball.position.y).toBeGreaterThan(surface + 0.5 - 0.05);
    expect(ball.position.y).toBeLessThan(surface + 0.5 + 0.05);
  });
});

/**
 * Shape construction is the one place a dimension mistake can be caught cheaply: shapes are built
 * once, and a NaN half-extent used to surface much later as NaN contacts (or an invisible body).
 */
describe("Physics - Shape Validation", () => {
  it("rejects non-finite dimensions at the constructor instead of producing NaN geometry", () => {
    // The classic mistake: every neighbouring API takes vectors, these take components.
    expect(() => new BoxShape(new Vec3(1, 1, 1) as unknown as number)).toThrow(UsageError);
    expect(() => new BoxShape(new Vec3(1, 1, 1) as unknown as number)).toThrow(/finite number/);
    expect(() => new SphereShape(NaN)).toThrow(/SphereShape\.radius/);
    expect(() => new CapsuleShape(1, Number.POSITIVE_INFINITY)).toThrow(/CapsuleShape\.halfHeight/);
    expect(() => new CylinderShape(0.5, NaN)).toThrow(/CylinderShape\.halfHeight/);

    // Finite dimensions are still clamped, and the clamp stays visible in the shape:
    expect(new SphereShape(-5).radius).toBe(0.001);
    expect(new BoxShape(2, 0, 1).halfExtents.y).toBe(0.001);
  });
});
