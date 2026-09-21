import { describe, expect, it } from "vitest";
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

describe("Scene/ECS - EntityWorld and Lifecycle", () => {
  it("allocates generational entity IDs and detects stale IDs", () => {
    const world = new EntityWorld();
    const e1 = world.createEntity("first");
    const id1 = e1.id;
    const slot1 = world.slotOf(id1);
    expect(world.exists(id1)).toBe(true);
    expect(world.name(id1)).toBe("first");
    expect(slot1).toBeGreaterThanOrEqual(0);

    // Destroy e1
    expect(world.destroyEntity(id1)).toBe(true);
    expect(world.exists(id1)).toBe(false);
    expect(world.slotOf(id1)).toBe(-1);

    // Recreate: should reuse slot with incremented generation
    const e2 = world.createEntity("second");
    const id2 = e2.id;
    expect(world.exists(id2)).toBe(true);
    expect(world.slotOf(id2)).toBe(slot1); // slot reused
    expect(id2).not.toBe(id1); // generation differs
    expect(world.exists(id1)).toBe(false); // old handle is strictly invalid

    world.dispose();
  });

  it("enforces maxEntities cap when specified", () => {
    const world = new EntityWorld({ maxEntities: 2 });
    world.createEntity("e1");
    world.createEntity("e2");
    expect(() => world.createEntity("e3")).toThrow(UsageError);
    world.dispose();
  });

  it("findByName retrieves entities by assigned name", () => {
    const world = new EntityWorld();
    const e1 = world.createEntity("target");
    const e2 = world.createEntity("target");
    const e3 = world.createEntity("other");

    const found = world.findByName("target");
    expect(found).toHaveLength(2);
    expect(found).toContain(e1.id);
    expect(found).toContain(e2.id);
    expect(found).not.toContain(e3.id);

    world.dispose();
  });
});

describe("Scene/ECS - Components and Queries", () => {
  it("attaches, retrieves, and detaches components with lifecycle callbacks", () => {
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

    expect(attached).toBe(true);
    expect(entity.has(LifecycleComponent)).toBe(true);
    expect(entity.get(LifecycleComponent)).toBe(comp);
    expect(comp.entity).toBe(entity.id);

    entity.remove(LifecycleComponent);
    expect(detached).toBe(true);
    expect(disposed).toBe(true);
    expect(entity.has(LifecycleComponent)).toBe(false);

    world.dispose();
  });

  it("executes queries with all, anyOf, and noneOf filters correctly", () => {
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
    expect(qAB.count).toBe(2);
    expect(abEntities).toContain(eAB.id);
    expect(abEntities).toContain(eABC.id);

    // Query for TagA, excluding TagC
    const qAWithoutC = world.query([TagA], { noneOf: [TagC] });
    qAWithoutC.refresh();
    const aNoCEntities = [qAWithoutC.entity(0), qAWithoutC.entity(1)];
    expect(qAWithoutC.count).toBe(2);
    expect(aNoCEntities).toContain(eA.id);
    expect(aNoCEntities).toContain(eAB.id);

    // Query with TagA and anyOf TagB or TagC
    const qAny = world.query([TagA], { anyOf: [TagB, TagC] });
    qAny.refresh();
    const anyEntities = [qAny.entity(0), qAny.entity(1)];
    expect(qAny.count).toBe(2);
    expect(anyEntities).toContain(eAB.id);
    expect(anyEntities).toContain(eABC.id);

    world.dispose();
  });

  it("journals structural operations during system execution to prevent mid-loop mutation", () => {
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
        expect(q.count).toBe(observedCountDuringUpdate);
      }
    }

    world.registerSystem(new MutatingSystem());
    const ctx = createMockContext(world);
    world.runSystems(ctx);

    // After system pass finishes, journal was flushed
    const qAfter = world.query([TagA]);
    qAfter.refresh();
    expect(qAfter.count).toBe(1);
    expect(world.exists(e1.id)).toBe(false);

    world.dispose();
  });
});

describe("Scene/ECS - Hierarchy and Transforms", () => {
  it("manages parent-child relationships and detects hierarchy cycles", () => {
    const world = new EntityWorld();
    const parent = world.createEntity("parent");
    const child = world.createEntity("child");
    const grandchild = world.createEntity("grandchild");

    child.parent = parent;
    grandchild.parent = child;

    expect(child.parent?.id).toBe(parent.id);
    expect(grandchild.parent?.id).toBe(child.id);
    expect(parent.children.map((c) => c.id)).toEqual([child.id]);
    expect(child.children.map((c) => c.id)).toEqual([grandchild.id]);

    // Self-parenting must throw
    expect(() => {
      parent.parent = parent;
    }).toThrow(UsageError);

    // Cycle detection: parent cannot be child of grandchild
    expect(() => {
      parent.parent = grandchild;
    }).toThrow(UsageError);

    // Destroying parent cascades down to destroy descendants
    parent.destroy();
    expect(world.exists(parent.id)).toBe(false);
    expect(world.exists(child.id)).toBe(false);
    expect(world.exists(grandchild.id)).toBe(false);

    world.dispose();
  });

  it("propagates world transforms down the hierarchy", () => {
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

    expect(pPos.x).toBeCloseTo(10);
    expect(pPos.y).toBeCloseTo(0);
    expect(cPos.x).toBeCloseTo(10);
    expect(cPos.y).toBeCloseTo(5);

    world.dispose();
  });
});

describe("Scene/ECS - System Scheduler", () => {
  it("topologically sorts systems according to order and before/after constraints", () => {
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

    expect(executionOrder).toEqual(["sysA", "sysB", "sysC"]);

    world.dispose();
  });

  it("detects and rejects dependency cycles among systems", () => {
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

    expect(() => world.sortSystems()).toThrow(UsageError);

    world.dispose();
  });

  it("runs FixedSystem with exact number of fixed steps", () => {
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
    expect(stepsCounted).toBe(3);

    world.dispose();
  });
});
