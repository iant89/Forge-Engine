/**
 * @suite core:ecsInspector
 * @group unit
 * @covers engine/src/debug/ecsInspector.ts
 * @covers engine/src/index.ts
 * @desc Phase 21.2 — bounded, read-only ECS inspection data
 */

export const suite = {
  name: "core:ecsInspector",
  group: "unit",
  covers: ["engine/src/debug/ecsInspector.ts", "engine/src/index.ts"],
  desc: "Phase 21.2 — bounded, read-only ECS inspection data",
};

import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import { Component, EntityWorld, Profiler, Transform, inspectEcs, inspectEntity, registerComponent, summariseEcsFields } from "@forge/engine";

class InspectorFixture extends Component {
  health = 65;
  label = "sample";
  velocity = { x: 1, y: 2, z: 3 };
  orientation = { x: 0, y: 0, z: 0, w: 1 };
  samples = new Float32Array([1.5, 2.5]);
  oversized = new Float32Array(32);
  nested = { internal: { value: 1 } };
}
registerComponent(InspectorFixture);

group("ECS inspector", () => {
  test("summarizes scheduler, populations, hierarchy and filtered entities without leaking live data", () => {
    const world = new EntityWorld();
    const profiler = new Profiler();
    world.registerSystem({ name: "physics", order: 100, enabled: true, update() {}, stats: () => ({ bodies: 3, mode: "cpu" }) });
    world.registerSystem({ name: "disabled", order: 900, enabled: false, update() {} });
    const root = world.createEntity("Crate Alpha");
    const component = new InspectorFixture();
    root.add(new Transform());
    root.add(component);
    const child = world.createEntity("Point Light");
    child.add(new Transform());
    world.setParent(child.id, root.id);
    profiler.absorb([{ name: "physics", ms: 2.5 }]);

    const beforeGeneration = world.generation;
    const systemOrderBefore = world.systems.map((system) => system.name);
    const snapshot = inspectEcs(world, { profiler });
    assert.equal(snapshot.generation, beforeGeneration);
    assert.deepEqual(world.systems.map((system) => system.name), systemOrderBefore, "inspection must not reorder registered systems");
    assert.equal(snapshot.entities, 2);
    assert.equal(snapshot.components, 3);
    assert.equal(snapshot.hierarchyDepth, 2);
    assert.deepEqual(snapshot.byComponent.find((entry) => entry.name === "InspectorFixture"), { name: "InspectorFixture", count: 1 });
    const physics = snapshot.systems.find((entry) => entry.name === "physics")!;
    assert.equal(physics.runIndex, snapshot.systems.findIndex((entry) => entry.name === "physics"));
    assert.equal(physics.ms, 2.5);
    assert.deepEqual(physics.stats, { bodies: 3, mode: "cpu" });
    assert.equal(snapshot.systems.find((entry) => entry.name === "disabled")!.enabled, false);
    assert.equal(snapshot.systems.find((entry) => entry.name === "transforms")!.ms, null);

    const childView = snapshot.list.find((entry) => entry.name === "Point Light")!;
    assert.equal(childView.parent, root.id);
    assert.deepEqual(childView.position, [0, 0, 0]);
    assert.deepEqual(inspectEcs(world, { filter: "inspectorfixture" }).list.map((entry) => entry.id), [root.id]);
    assert.deepEqual(inspectEcs(world, { filter: "CRATE" }).list.map((entry) => entry.id), [root.id]);
    const limited = inspectEcs(world, { limit: 1 });
    assert.equal(limited.list.length, 1);
    assert.equal(limited.truncated, true);
    assert.equal(inspectEcs(world, { limit: 0 }).truncated, true);
    assert.equal(inspectEcs(world, { filter: "missing" }).truncated, false);
    assert.equal(world.generation, beforeGeneration, "inspection must not mutate the entity world");

    const detail = inspectEntity(world, root.id)!;
    const fields = detail.detail.find((entry) => entry.type === "InspectorFixture")!.fields;
    assert.deepEqual(fields, {
      health: 65,
      label: "sample",
      velocity: [1, 2, 3],
      orientation: [0, 0, 0, 1],
      samples: [1.5, 2.5],
    });
    assert.notEqual(detail.detail.find((entry) => entry.type === "InspectorFixture")!.fields, component);
    world.destroyEntity(child.id);
    assert.equal(inspectEntity(world, child.id), null);
    world.dispose();
  });

  test("summarizes only bounded scalar/vector data", () => {
    assert.deepEqual(summariseEcsFields({
      n: 4,
      text: "ok",
      yes: true,
      nil: null,
      vector: { x: 1, y: 2, z: 3 },
      quaternion: { x: 0, y: 0, z: 0, w: 1 },
      short: [1, 2],
      long: new Array(20).fill(0),
      nested: { deep: true },
      _internal: 7,
      entity: 9,
      enabled: false,
    }), {
      n: 4,
      text: "ok",
      yes: true,
      nil: null,
      vector: [1, 2, 3],
      quaternion: [0, 0, 0, 1],
      short: [1, 2],
    });
  });
});

finish();
