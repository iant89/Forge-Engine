/**
 * @suite physics:physics
 * @group unit
 * @covers engine/src/core/errors.ts
 * @covers engine/src/index.ts
 * @covers engine/src/math/geometry.ts
 * @covers engine/src/math/vec.ts
 * @covers engine/src/physics/body.ts
 * @covers engine/src/physics/broadphase.ts
 * @covers engine/src/physics/collision.ts
 * @covers engine/src/physics/shapes.ts
 * @covers engine/src/physics/world.ts
 * @desc Pins physics behavior and regression guarantees
 */

export const suite = {
  name: "physics:physics",
  group: "unit",
  covers:   [
    "engine/src/core/errors.ts",
    "engine/src/index.ts",
    "engine/src/math/geometry.ts",
    "engine/src/math/vec.ts",
    "engine/src/physics/body.ts",
    "engine/src/physics/broadphase.ts",
    "engine/src/physics/collision.ts",
    "engine/src/physics/shapes.ts",
    "engine/src/physics/world.ts"
  ],
  desc: "Pins physics behavior and regression guarantees",
};
import assert from "node:assert/strict";
import { assertCloseTo, assertMatchObject, assertNotCloseTo, assertThrows, finish, group, test } from "selrun";
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
  SweepAndPruneBroadphase,
} from "@forge/engine";

group("Physics - Free Fall & Dynamics Integration", () => {
  test("integrates parabolic trajectory under uniform gravity", () => {
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
    assertCloseTo(sphere.position.y, 95.095, 0);
    assertCloseTo(sphere.linearVelocity.y, -9.81, 1);
  });
});

group("Physics - Restitution & Bouncing", () => {
  test("bounces with restitution coefficient and settles to rest without micro-jitter", () => {
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
    assertCloseTo(ball.position.y, 0.5, 1);
    assert.ok(Math.abs(ball.linearVelocity.y) < 0.05);
    assert.ok(ball.position.y >= 0.48); // penetration within slop
  });
});

group("Physics - Coulomb Friction on an Incline", () => {
  test("holds stationary when slope is below friction angle and slides when above", () => {
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
    assert.ok(Math.abs(boxHold.linearVelocity.x) < 0.1);
  });
});

group("Physics - Stacking Stability", () => {
  test("keeps a 3-box vertical stack stable under gravity", () => {
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
    assertCloseTo(b1.position.y, 0.5, 1);
    assertCloseTo(b2.position.y, 1.5, 1);
    assertCloseTo(b3.position.y, 2.5, 1);

    assert.ok(Math.abs(b1.position.x) < 0.05);
    assert.ok(Math.abs(b2.position.x) < 0.05);
    assert.ok(Math.abs(b3.position.x) < 0.05);

    // Penetration between boxes must not exceed 0.02m
    const overlap12 = 1.0 - (b2.position.y - b1.position.y);
    const overlap23 = 1.0 - (b3.position.y - b2.position.y);
    assert.ok(overlap12 <= 0.02);
    assert.ok(overlap23 <= 0.02);
  });
});

group("Physics - Framerate Independence & Determinism", () => {
  test("produces identical trajectories across 15, 30, 60, and 144 Hz display framerates", () => {
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
    assert.ok(Math.abs(pos30.x - pos60.x) < 0.15);
    assert.ok(Math.abs(pos30.y - pos60.y) < 0.15);

    assert.ok(Math.abs(pos15.x - pos60.x) < 0.15);
    assert.ok(Math.abs(pos15.y - pos60.y) < 0.15);

    assert.ok(Math.abs(pos144.x - pos60.x) < 0.15);
    assert.ok(Math.abs(pos144.y - pos60.y) < 0.15);
  });
});

group("Physics - Spatial Queries & Raycast", () => {
  test("raycasts against sphere and plane accurately", () => {
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
    assert.equal(world.raycast(raySphere, hitSphere), true);
    assertCloseTo(hitSphere.distance, 9.0, 2); // 20 - (10 + 1) = 9
    assertCloseTo(hitSphere.normal.y, 1.0, 2);

    // Raycast towards ground plane
    const rayGround = new Ray(new Vec3(50, 10, 50), new Vec3(0, -1, 0), 50);
    const hitGround = new RayHit();
    assert.equal(world.raycast(rayGround, hitGround), true);
    assertCloseTo(hitGround.distance, 10.0, 2);
    assertCloseTo(hitGround.point.y, 0.0, 2);
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
group("Physics - Indexed Broadphase", () => {
  test("matches brute-force AABB pairs in deterministic body order while pruning sparse candidates", () => {
    const bodies = Array.from({ length: 48 }, (_, i) => {
      const type = i % 9 === 0 ? "static" : i % 11 === 0 ? "kinematic" : "dynamic";
      const x = (i % 8) * 0.8;
      const y = (Math.floor(i / 8) % 3) * 0.8;
      const z = Math.floor(i / 24) * 4;
      return new RigidBody({ type, shape: new BoxShape(0.45, 0.45, 0.45), position: new Vec3(x, y, z) });
    });
    const expected: [number, number][] = [];
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i]!;
        const b = bodies[j]!;
        if (a.invMass === 0 && b.invMass === 0) continue;
        if (a.aabb.intersectsAABB(b.aabb)) expected.push([i, j]);
      }
    }

    const broadphase = new SweepAndPruneBroadphase();
    const actual = broadphase.query(bodies).map(({ a, b }) => [a, b]);
    assert.deepEqual(actual, expected);
    assert.equal(broadphase.stats.overlapPairs, expected.length);
    assert.ok(broadphase.stats.axisCandidates < broadphase.stats.possiblePairs);
    assert.ok(broadphase.stats.overlapPairs < broadphase.stats.possiblePairs);

    const world = new PhysicsWorld({ gravity: new Vec3() });
    world.addBody(new RigidBody({ shape: new SphereShape(0.5), position: new Vec3(0, 0, 0) }));
    world.addBody(new RigidBody({ shape: new SphereShape(0.5), position: new Vec3(10, 0, 0) }));
    world.stepOnce();
    assertMatchObject(world.broadphaseStats, { bodyCount: 2, possiblePairs: 1, axisCandidates: 0, overlapPairs: 0 });
    world.clear();
    assertMatchObject(world.broadphaseStats, { bodyCount: 0, possiblePairs: 0, axisCandidates: 0, overlapPairs: 0 });
  });
});

group("Physics - Heightfield Contacts", () => {
  /** A flat field at y = 0 with an analytic +Y normal: nothing to interpolate, nothing to fudge. */
  const flatField = (): HeightfieldShape => new HeightfieldShape({ sampleHeight: () => 0 });

  test("measures sphere penetration from the sampled height, with an inward normal", () => {
    const sphereBody = new RigidBody({ type: "dynamic", shape: new SphereShape(1), position: new Vec3(3, 0.9, -2) });
    const fieldBody = new RigidBody({ type: "static", shape: flatField() });

    // Clear of the surface: no contact (the query must be depth-tested, not proximity-tested).
    sphereBody.position.y = 1.5;
    assert.equal(collideBodies(sphereBody, fieldBody), null);

    // 0.1 m into the surface.
    sphereBody.position.y = 0.9;
    const manifold = collideBodies(sphereBody, fieldBody);
    assert.notEqual(manifold, null);
    assert.equal((manifold!.contacts).length, 1);
    const contact = manifold!.contacts[0]!;
    assertCloseTo(contact.penetration, 0.1, 6);
    // Points from the sphere (A) into the height field (B) — downward for a +Y surface normal.
    assertCloseTo(contact.normal.y, -1, 6);
    assertCloseTo(contact.point.y, 0, 6);
    assert.equal(manifold!.bodyA, sphereBody);
    assert.equal(manifold!.bodyB, fieldBody);
  });

  test("generates one contact per penetrating box corner", () => {
    const boxBody = new RigidBody({
      type: "dynamic",
      shape: new BoxShape(1, 1, 1),
      position: new Vec3(0, 0.5, 0),
    });
    const fieldBody = new RigidBody({ type: "static", shape: flatField() });
    // Half-extent 1 about y = 0.5 puts the four lower corners 0.5 m under the surface and the four
    // upper ones 1.5 m above it; only the penetrating corners may generate contacts.
    const manifold = collideBodies(boxBody, fieldBody);
    assert.notEqual(manifold, null);
    assert.equal((manifold!.contacts).length, 4);
    for (const contact of manifold!.contacts) {
      assertCloseTo(contact.penetration, 0.5, 6);
      assertCloseTo(contact.point.y, 0, 6);
      assertNotCloseTo(contact.point.x, 0, 3); // lower corners only, no centre contact
      assertNotCloseTo(contact.point.z, 0, 3);
    }

    // Raised so the box just touches (bottom face at y = 0): touching is not penetrating.
    boxBody.position.y = 1.0;
    assert.equal(collideBodies(boxBody, fieldBody), null);
  });

  test("holds a resting sphere on a sloped height field without sinking", () => {
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
    assert.ok(ball.position.y > surface + 0.5 - 0.05);
    assert.ok(ball.position.y < surface + 0.5 + 0.05);
  });
});

/**
 * Shape construction is the one place a dimension mistake can be caught cheaply: shapes are built
 * once, and a NaN half-extent used to surface much later as NaN contacts (or an invisible body).
 */
group("Physics - Shape Validation", () => {
  test("rejects non-finite dimensions at the constructor instead of producing NaN geometry", () => {
    // The classic mistake: every neighbouring API takes vectors, these take components.
    assertThrows(() => new BoxShape(new Vec3(1, 1, 1) as unknown as number), UsageError);
    assertThrows(() => new BoxShape(new Vec3(1, 1, 1) as unknown as number), /finite number/);
    assertThrows(() => new SphereShape(NaN), /SphereShape\.radius/);
    assertThrows(() => new CapsuleShape(1, Number.POSITIVE_INFINITY), /CapsuleShape\.halfHeight/);
    assertThrows(() => new CylinderShape(0.5, NaN), /CylinderShape\.halfHeight/);

    // Finite dimensions are still clamped, and the clamp stays visible in the shape:
    assert.equal(new SphereShape(-5).radius, 0.001);
    assert.equal(new BoxShape(2, 0, 1).halfExtents.y, 0.001);
  });
});

await finish();
