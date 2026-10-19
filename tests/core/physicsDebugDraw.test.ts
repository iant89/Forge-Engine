/**
 * @suite core:physicsDebugDraw
 * @group unit
 * @covers engine/src/debug/physicsDebugDraw.ts
 * @covers engine/src/index.ts
 * @covers engine/src/physics/body.ts
 * @covers engine/src/physics/world.ts
 * @desc Phase 21.5 — renderer-independent physics wireframes and bounded snapshots
 */

export const suite = {
  name: "core:physicsDebugDraw",
  group: "unit",
  covers: ["engine/src/debug/physicsDebugDraw.ts", "engine/src/index.ts", "engine/src/physics/body.ts", "engine/src/physics/world.ts"],
  desc: "Phase 21.5 — renderer-independent physics wireframes and bounded snapshots",
};

import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import { BoxShape, drawPhysicsDebug, PhysicsWorld, physicsDebugDraw, PlaneShape, RigidBody, SphereShape, Vec3 } from "@forge/engine";

group("physics debug draw", () => {
  test("returns bounded, renderer-independent collider and optional diagnostic lines", () => {
    const world = new PhysicsWorld({ gravity: new Vec3(0, 0, 0) });
    const sphere = new RigidBody({ shape: new SphereShape(1), position: new Vec3(3, 4, 5), linearVelocity: new Vec3(2, 0, 0) });
    const box = new RigidBody({ type: "static", shape: new BoxShape(1, 2, 3), position: new Vec3(-2, 0, 0) });
    world.addBody(sphere);
    world.addBody(box);

    const view = physicsDebugDraw(world, { maxBodies: 1, segments: 5, showAabbs: true, showVelocity: true });
    assert.deepEqual([view.bodyCount, view.processedBodies, view.truncatedBodies], [2, 1, 1]);
    assert.equal(view.lineCount, view.lines.length);
    assert.ok(view.lines.some((line) => line.kind === "shape"));
    assert.ok(view.lines.some((line) => line.kind === "aabb"));
    const velocity = view.lines.find((line) => line.kind === "velocity")!;
    assert.deepEqual(velocity.start, [3, 4, 5]);
    assert.deepEqual(velocity.end, [4, 4, 5]);
    assert.ok(view.lines.every((line) => line.bodyId === sphere.id));

    const forwarded: number[] = [];
    const forwardedView = drawPhysicsDebug(world, (_start, _end, color) => forwarded.push(color), { maxBodies: 0 });
    assert.equal(forwarded.length, 0);
    assert.equal(forwardedView.truncatedBodies, 2);
  });

  test("places finite plane wireframes according to the plane equation", () => {
    const world = new PhysicsWorld({ gravity: new Vec3(0, 0, 0) });
    world.addBody(new RigidBody({ type: "static", shape: new PlaneShape(new Vec3(0, 1, 0), -3), position: new Vec3(10, 20, 30) }));
    const view = physicsDebugDraw(world, { planeExtent: 2 });
    assert.equal(view.lines.length, 6);
    assert.ok(view.lines.every((line) => Math.abs(line.start[1] - 3) < 1e-6 && Math.abs(line.end[1] - 3) < 1e-6));
  });

  test("emits the expected box edge count and leaves bodies unchanged", () => {
    const world = new PhysicsWorld({ gravity: new Vec3(0, 0, 0) });
    const body = new RigidBody({ type: "static", shape: new BoxShape(1, 1, 1), position: new Vec3(10, 2, -4) });
    world.addBody(body);
    const before = [body.position.x, body.position.y, body.position.z];
    const view = physicsDebugDraw(world);
    assert.equal(view.lines.length, 12);
    assert.deepEqual([body.position.x, body.position.y, body.position.z], before);
    assert.ok(view.lines.every((line) => line.color === 0xff00d080));
  });
});

finish();
