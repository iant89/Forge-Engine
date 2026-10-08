/**
 * @suite scene:ecs
 * @group unit
 * @covers engine/src/core/errors.ts
 * @covers engine/src/core/log.ts
 * @covers engine/src/core/time.ts
 * @covers engine/src/debug/profiler.ts
 * @covers engine/src/gpu/device.ts
 * @covers engine/src/index.ts
 * @covers engine/src/math/vec.ts
 * @covers engine/src/rendering/geometry.ts
 * @covers engine/src/scene/components.ts
 * @covers engine/src/scene/components/index.ts
 * @covers engine/src/scene/scene.ts
 * @covers engine/src/scene/systems.ts
 * @covers engine/src/scene/world.ts
 * @desc Pins ecs behavior and regression guarantees
 */

export const suite = {
  name: "scene:ecs",
  group: "unit",
  covers:   [
    "engine/src/core/errors.ts",
    "engine/src/core/log.ts",
    "engine/src/core/time.ts",
    "engine/src/debug/profiler.ts",
    "engine/src/gpu/device.ts",
    "engine/src/index.ts",
    "engine/src/math/vec.ts",
    "engine/src/rendering/geometry.ts",
    "engine/src/scene/components.ts",
    "engine/src/scene/components/index.ts",
    "engine/src/scene/scene.ts",
    "engine/src/scene/systems.ts",
    "engine/src/scene/world.ts"
  ],
  desc: "Pins ecs behavior and regression guarantees",
};
import assert from "node:assert/strict";
import { assertCloseTo, assertContains, assertNotContains, assertThrows, finish, group, test } from "selrun";
import {
  EntityWorld,
  Component,
  registerComponent,
  Transform,
  Scene,
  Vec3,
  UsageError,
  System,
  FixedSystem,
  type SystemContext,
  Clock,
  Logger,
  Profiler,
  SystemScratch,
  Geometry,
  GraphicsDevice,
  Renderable,
} from "@forge/engine";

class TagA extends Component {
  value = 1;
}

class TagB extends Component {
  value = 2;
}

class TagC extends Component {
  value = 3;
}

registerComponent(TagA, { name: "TagA", allowMultiple: false });
registerComponent(TagB, { name: "TagB", allowMultiple: false });
registerComponent(TagC, { name: "TagC", allowMultiple: false });

function createMockContext(world: EntityWorld): SystemContext {
  return {
    world,
    clock: new Clock(),
    dt: 0.016,
    fixedDt: 0.016,
    fixedSteps: 1,
    alpha: 0,
    elapsed: 0,
    frame: 1,
    logger: new Logger(),
    profiler: new Profiler(),
    services: { get: () => undefined, engineConfig: {} },
    scratch: new SystemScratch(),
  };
}

group("Scene/ECS - EntityWorld and Lifecycle", () => {
  test("allocates generational entity IDs and detects stale IDs", () => {
    const world = new EntityWorld();
    const e1 = world.createEntity("first");
    const id1 = e1.id;
    const slot1 = world.slotOf(id1);
    assert.equal(world.exists(id1), true);
    assert.equal(world.name(id1), "first");
    assert.ok(slot1 >= 0);

    // Destroy e1
    assert.equal(world.destroyEntity(id1), true);
    assert.equal(world.exists(id1), false);
    assert.equal(world.slotOf(id1), -1);

    // Recreate: should reuse slot with incremented generation
    const e2 = world.createEntity("second");
    const id2 = e2.id;
    assert.equal(world.exists(id2), true);
    assert.equal(world.slotOf(id2), slot1); // slot reused
    assert.notEqual(id2, id1); // generation differs
    assert.equal(world.exists(id1), false); // old handle is strictly invalid

    world.dispose();
  });

  test("enforces maxEntities cap when specified", () => {
    const world = new EntityWorld({ maxEntities: 2 });
    world.createEntity("e1");
    world.createEntity("e2");
    assertThrows(() => world.createEntity("e3"), UsageError);
    world.dispose();
  });

  test("findByName retrieves entities by assigned name", () => {
    const world = new EntityWorld();
    const e1 = world.createEntity("target");
    const e2 = world.createEntity("target");
    const e3 = world.createEntity("other");

    const found = world.findByName("target");
    assert.equal((found).length, 2);
    assertContains(found, e1.id);
    assertContains(found, e2.id);
    assertNotContains(found, e3.id);

    world.dispose();
  });
});

group("Scene/ECS - Components and Queries", () => {
  test("attaches, retrieves, and detaches components with lifecycle callbacks", () => {
    const world = new EntityWorld();
    const entity = world.createEntity("test-entity");

    let attached = false;
    let detached = false;
    let disposed = false;

    class LifecycleComponent extends Component {
      override onAttach() {
        attached = true;
      }
      override onDetach() {
        detached = true;
      }
      override dispose() {
        disposed = true;
      }
    }
    registerComponent(LifecycleComponent, { name: "LifecycleComponent" });

    const comp = new LifecycleComponent();
    entity.add(comp);

    assert.equal(attached, true);
    assert.equal(entity.has(LifecycleComponent), true);
    assert.equal(entity.get(LifecycleComponent), comp);
    assert.equal(comp.entity, entity.id);

    entity.remove(LifecycleComponent);
    assert.equal(detached, true);
    assert.equal(disposed, true);
    assert.equal(entity.has(LifecycleComponent), false);

    world.dispose();
  });

  test("executes queries with all, anyOf, and noneOf filters correctly", () => {
    const world = new EntityWorld();

    const eA = world.createEntity("A");
    eA.add(new TagA());

    const eAB = world.createEntity("AB");
    eAB.add(new TagA());
    eAB.add(new TagB());

    const eABC = world.createEntity("ABC");
    eABC.add(new TagA());
    eABC.add(new TagB());
    eABC.add(new TagC());

    const eC = world.createEntity("C");
    eC.add(new TagC());

    // Query for TagA and TagB
    const qAB = world.query([TagA, TagB]);
    qAB.refresh();
    const abEntities = [qAB.entity(0), qAB.entity(1)];
    assert.equal(qAB.count, 2);
    assertContains(abEntities, eAB.id);
    assertContains(abEntities, eABC.id);

    // Query for TagA, excluding TagC
    const qAWithoutC = world.query([TagA], { noneOf: [TagC] });
    qAWithoutC.refresh();
    const aNoCEntities = [qAWithoutC.entity(0), qAWithoutC.entity(1)];
    assert.equal(qAWithoutC.count, 2);
    assertContains(aNoCEntities, eA.id);
    assertContains(aNoCEntities, eAB.id);

    // Query with TagA and anyOf TagB or TagC
    const qAny = world.query([TagA], { anyOf: [TagB, TagC] });
    qAny.refresh();
    const anyEntities = [qAny.entity(0), qAny.entity(1)];
    assert.equal(qAny.count, 2);
    assertContains(anyEntities, eAB.id);
    assertContains(anyEntities, eABC.id);

    world.dispose();
  });

  test("journals structural operations during system execution to prevent mid-loop mutation", () => {
    const world = new EntityWorld();
    const e1 = world.createEntity("e1");
    e1.add(new TagA());

    let observedCountDuringUpdate = 0;

    class MutatingSystem extends System {
      readonly name = "mutator";
      update(context: SystemContext): void {
        const q = context.world.query([TagA]);
        q.refresh();
        observedCountDuringUpdate = q.count;
        // Mutate during pass: add an entity with TagA and destroy e1
        const e2 = context.world.createEntity("e2");
        e2.add(new TagA());
        context.world.destroyEntity(e1.id);

        // Within this system pass, query rows should remain consistent
        q.refresh();
        assert.equal(q.count, observedCountDuringUpdate);
      }
    }

    world.registerSystem(new MutatingSystem());
    const ctx = createMockContext(world);
    world.runSystems(ctx);

    // After system pass finishes, journal was flushed
    const qAfter = world.query([TagA]);
    qAfter.refresh();
    assert.equal(qAfter.count, 1);
    assert.equal(world.exists(e1.id), false);

    world.dispose();
  });
});

group("Scene/ECS - Hierarchy and Transforms", () => {
  test("manages parent-child relationships and detects hierarchy cycles", () => {
    const world = new EntityWorld();
    const parent = world.createEntity("parent");
    const child = world.createEntity("child");
    const grandchild = world.createEntity("grandchild");

    child.parent = parent;
    grandchild.parent = child;

    assert.equal(child.parent?.id, parent.id);
    assert.equal(grandchild.parent?.id, child.id);
    assert.deepEqual(parent.children.map((c) => c.id), [child.id]);
    assert.deepEqual(child.children.map((c) => c.id), [grandchild.id]);

    // Self-parenting must throw
    assertThrows(() => {
      parent.parent = parent;
    }, UsageError);

    // Cycle detection: parent cannot be child of grandchild
    assertThrows(() => {
      parent.parent = grandchild;
    }, UsageError);

    // Destroying parent cascades down to destroy descendants
    parent.destroy();
    assert.equal(world.exists(parent.id), false);
    assert.equal(world.exists(child.id), false);
    assert.equal(world.exists(grandchild.id), false);

    world.dispose();
  });

  test("propagates world transforms down the hierarchy", () => {
    const world = new EntityWorld();
    const parent = world.createEntity("parent");
    parent.add(new Transform()).setPosition(10, 0, 0);

    const child = world.createEntity("child");
    child.parent = parent;
    child.add(new Transform()).setPosition(0, 5, 0);

    const changed: number[] = [];
    world.updateTransforms(changed);

    const pPos = parent.getPosition();
    const cPos = child.getPosition();

    assertCloseTo(pPos.x, 10, 2);
    assertCloseTo(pPos.y, 0, 2);
    assertCloseTo(cPos.x, 10, 2);
    assertCloseTo(cPos.y, 5, 2);

    world.dispose();
  });
});

group("Scene/ECS - System Scheduler", () => {
  test("topologically sorts systems according to order and before/after constraints", () => {
    const world = new EntityWorld();
    const executionOrder: string[] = [];

    class SysC extends System {
      readonly name = "sysC";
      override readonly order = 300;
      update() {
        executionOrder.push(this.name);
      }
    }

    class SysA extends System {
      readonly name = "sysA";
      override readonly order = 100;
      update() {
        executionOrder.push(this.name);
      }
    }

    class SysB extends System {
      readonly name = "sysB";
      override readonly order = 200;
      override readonly after = ["sysA"];
      override readonly before = ["sysC"];
      update() {
        executionOrder.push(this.name);
      }
    }

    // Register out of order
    world.registerSystem(new SysC());
    world.registerSystem(new SysA());
    world.registerSystem(new SysB());

    const ctx = createMockContext(world);
    world.runSystems(ctx);

    assert.deepEqual(executionOrder, ["sysA", "sysB", "sysC"]);

    world.dispose();
  });

  test("detects and rejects dependency cycles among systems", () => {
    const world = new EntityWorld();

    class Cycle1 extends System {
      readonly name = "cycle1";
      override readonly after = ["cycle2"];
      update() {}
    }

    class Cycle2 extends System {
      readonly name = "cycle2";
      override readonly after = ["cycle1"];
      update() {}
    }

    world.registerSystem(new Cycle1());
    world.registerSystem(new Cycle2());

    assertThrows(() => world.sortSystems(), UsageError);

    world.dispose();
  });

  test("keeps component storage per world, not per component type", () => {
    // Regression: `ComponentTypeInfo` used to hand every world the *same* store instance. Entity slots
    // restart at 0 in each world, so a second scene aliased slot 0 of the first: adding a Transform to
    // its own entity #0 threw "already has a Transform component", and `world.dispose()` cleared the
    // other world's components. Two live scenes in one process (the demo's scene switcher) hit both.
    const first = new EntityWorld();
    const second = new EntityWorld();

    const a = first.createEntity("a");
    a.add(new TagA()).value = 11;
    const b = second.createEntity("b");
    b.add(new TagA()).value = 22;

    assert.equal(first.getComponent(a.id, TagA)?.value, 11);
    assert.equal(second.getComponent(b.id, TagA)?.value, 22);
    assert.equal(first.store(TagA).count, 1);
    assert.equal(second.store(TagA).count, 1);

    // Disposing one world must leave the other's components alone.
    first.dispose();
    assert.equal(second.getComponent(b.id, TagA)?.value, 22);
    assert.equal(second.liveEntityCount, 1);

    second.dispose();
  });

  test("lets a scene be built while another is still live", () => {
    const first = new Scene({ name: "first" });
    const second = new Scene({ name: "second" });
    first.createTransformedEntity("camera", new Vec3(0, 0, 0));
    second.createTransformedEntity("ground", new Vec3(0, 1, 0));

    assert.equal(first.entityCount, 1);
    assert.equal(second.entityCount, 1);

    first.dispose();
    second.dispose();
  });

  test("runs FixedSystem with exact number of fixed steps", () => {
    const world = new EntityWorld();
    let stepsCounted = 0;

    class PhysicsMock extends FixedSystem {
      readonly name = "physicsMock";
      fixedStep() {
        stepsCounted++;
      }
    }

    world.registerSystem(new PhysicsMock());
    const ctx = {
      ...createMockContext(world),
      fixedSteps: 3,
    };

    world.runSystems(ctx);
    assert.equal(stepsCounted, 3);

    world.dispose();
  });

  test("uses the mesh BVH for transformed scene picking, rejecting AABB-only false positives", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const scene = new Scene({ name: "bvh-picking" });
    const geometry = Geometry.create(device, {
      positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]),
      indices: new Uint16Array([0, 1, 2]),
      label: "pick-triangle",
    });
    const entity = scene.createTransformedEntity("triangle", new Vec3(4, 0, 0));
    entity.transform.scale = new Vec3(2, 0.5, 1);
    const renderable = new Renderable();
    renderable.geometry = geometry;
    scene.world.addComponent(entity.id, renderable);
    scene.world.updateTransforms([], true);

    const miss = scene.raycast(new Vec3(7.5, 0.75, 1), new Vec3(0, 0, -1), 10);
    assert.equal((miss).length, 0); // inside the transformed mesh AABB, outside the triangle

    const hits = scene.raycast(new Vec3(4.5, 0.25, 1), new Vec3(0, 0, -1), 10);
    assert.equal((hits).length, 1);
    assertCloseTo(hits[0]!.distance, 1, 2);
    assert.equal(hits[0]!.hit.index, 0);
    assertCloseTo(hits[0]!.hit.normal.z, 1, 2);

    const builtIndex = geometry.getMeshBvh();
    const originalVertexBuffer = geometry.vertexBuffer;
    const originalIndexBuffer = geometry.indexBuffer!;
    geometry.updateFrom({
      positions: new Float32Array([100, 0, 0, 102, 0, 0, 100, 2, 0]),
      indices: new Uint32Array([0, 2, 1]),
    });
    assert.notEqual(geometry.getMeshBvh(), builtIndex);
    assert.equal(geometry.bounds.min.x, 100);
    assert.equal(geometry.indexCount, 3);
    assert.equal(geometry.indexFormat, "uint32");
    assert.notEqual(geometry.indexBuffer, originalIndexBuffer);
    assert.equal((originalIndexBuffer as unknown as { destroyed: boolean }).destroyed, true);
    assert.equal(geometry.vertexBuffer, originalVertexBuffer);
    const uploadedVertices = new Float32Array(
      (geometry.vertexBuffer as unknown as { data: ArrayBuffer }).data,
    );
    assert.deepEqual(Array.from(uploadedVertices.slice(0, 12)), [100, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
    assert.equal((scene.raycast(new Vec3(4.5, 0.25, 1), new Vec3(0, 0, -1), 10)).length, 0);

    const resized = Geometry.create(device, {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint16Array([0, 1, 2]),
    });
    const oldResizedVertexBuffer = resized.vertexBuffer;
    resized.updateFrom({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
      indices: new Uint16Array([0, 1, 2, 1, 3, 2]),
    });
    assert.notEqual(resized.vertexBuffer, oldResizedVertexBuffer);
    assert.equal(resized.vertexCount, 4);
    assert.equal(resized.indexCount, 6);
    assert.equal(resized.bounds.max.x, 1);
    resized.dispose();

    scene.dispose();
    geometry.dispose();
    await device.dispose();
  });
});

await finish();
