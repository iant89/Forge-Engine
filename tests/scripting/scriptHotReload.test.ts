/**
 * @suite scripting:scriptHotReload
 * @group unit
 * @covers engine/src/scripting/runtime.ts
 * @covers engine/src/scripting/script.ts
 * @desc Phase 18.7 script hot reload: in-place swap keeping data and execution order, old closures cancelled, onUnload/onReload (or onCreate), failed constructors keep the old script, faulted scripts revived, pending scripts and later components
 */

export const suite = {
  name: "scripting:scriptHotReload",
  group: "unit",
  covers: ["engine/src/scripting/runtime.ts", "engine/src/scripting/script.ts"],
  desc: "Phase 18.7 script hot reload: in-place swap keeping data and execution order, old closures cancelled, onUnload/onReload (or onCreate), failed constructors keep the old script, faulted scripts revived, pending scripts and later components",
};
import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import {
  Clock,
  EntityWorld,
  LogLevel,
  Logger,
  Profiler,
  Script,
  ScriptComponent,
  ScriptRuntime,
  SystemScratch,
  defineEvent,
  type ScriptContext,
  type SystemContext,
} from "@forge/engine";

let frame = 0;
function ctx(world: EntityWorld, fixedSteps = 1): SystemContext {
  frame++;
  return {
    world,
    clock: new Clock(),
    dt: 1 / 60,
    fixedDt: 1 / 60,
    fixedSteps,
    alpha: 0,
    elapsed: frame / 60,
    frame,
    logger: new Logger({ level: LogLevel.Silent }),
    profiler: new Profiler(),
    services: { get: () => undefined, engineConfig: {} },
    scratch: new SystemScratch(),
  };
}

const Hit = defineEvent<number>("Hit");

group("hot reload", () => {
  test("swaps in place: data carries over, order holds, old closures stop, onUnload/onReload run", () => {
    const world = new EntityWorld();
    const runtime = ScriptRuntime.install(world);
    const log: string[] = [];
    class GuardV1 extends Script {
      hp = 100;
      override onCreate(): void {
        this.every(0, () => log.push("v1 tick"), { steps: 1 });
        this.on(Hit, (n) => (this.hp -= n));
        this.startCoroutine(function* () {
          for (;;) {
            log.push("v1 co");
            yield;
          }
        });
      }
      override onUpdate(): void {
        log.push(`v1 update hp=${this.hp}`);
      }
      override onUnload(): void {
        log.push("v1 unload");
      }
    }
    class GuardV2 extends Script {
      hp = 999; // initializer runs, then the old value is copied over it
      override onReload(c: ScriptContext, previous: Script): void {
        log.push(`v2 reload from ${previous.constructor.name} on ${c.entity.name}`);
        this.on(Hit, (n) => (this.hp -= n * 2));
      }
      override onUpdate(): void {
        log.push(`v2 update hp=${this.hp}`);
      }
    }
    runtime.define("Guard", GuardV1);
    class Before extends Script {
      override onUpdate(): void {
        log.push("before");
      }
    }
    class After extends Script {
      override onUpdate(): void {
        log.push("after");
      }
    }
    world.createEntity("a").add(new ScriptComponent(new Before()));
    world.createEntity("g").add(new ScriptComponent("Guard"));
    world.createEntity("b").add(new ScriptComponent(new After()));
    world.runSystems(ctx(world));
    runtime.events.emit(Hit, 10);
    log.length = 0;

    const report = runtime.reload("Guard", GuardV2);
    assert.deepEqual(report, { replaced: 1, failed: 0 });
    assert.deepEqual(log, ["v1 unload", "v2 reload from GuardV1 on g"]);
    log.length = 0;
    runtime.events.emit(Hit, 5);
    world.runSystems(ctx(world));
    assert.deepEqual(log, ["before", "v2 update hp=80", "after"], "hp 90 - 2x5, same slot, no v1 timer/coroutine");
    const comp = world.facade(world.findByName("g")[0]!)!.get(ScriptComponent)!;
    assert.ok(comp.scripts[0] instanceof GuardV2);
    assert.equal(runtime.stats().scriptsReloaded, 1);
    assert.equal(runtime.events.listenerCount(Hit), 1, "only the new listener remains");
  });

  test("without onReload the new instance's onCreate runs and sees the carried data", () => {
    const world = new EntityWorld();
    const runtime = ScriptRuntime.install(world);
    const seen: number[] = [];
    class A extends Script {
      count = 0;
      override onUpdate(): void {
        this.count++;
      }
    }
    class B extends Script {
      count = 0;
      override onCreate(): void {
        seen.push(this.count);
      }
    }
    runtime.define("Counter", A);
    world.createEntity("e").add(new ScriptComponent("Counter"));
    for (let i = 0; i < 3; i++) world.runSystems(ctx(world));
    runtime.reload("Counter", B);
    assert.deepEqual(seen, [3]);
  });

  test("instances attached directly are matched by the previously defined class; others are untouched", () => {
    const world = new EntityWorld();
    const runtime = ScriptRuntime.install(world);
    class Old extends Script {}
    class New extends Script {}
    class Other extends Script {}
    runtime.define("Thing", Old);
    const direct = new Old();
    const other = new Other();
    world.createEntity("e").add(new ScriptComponent(direct, other));
    world.runSystems(ctx(world));
    assert.deepEqual(runtime.reload("Thing", New), { replaced: 1, failed: 0 });
    const scripts = world.facade(world.findByName("e")[0]!)!.get(ScriptComponent)!.scripts;
    assert.ok(scripts[0] instanceof New);
    assert.equal(scripts[1], other);
    assert.equal(direct.state, "destroyed");
  });

  test("a throwing constructor keeps the old script running", () => {
    const world = new EntityWorld();
    const runtime = ScriptRuntime.install(world);
    let ticks = 0;
    class Good extends Script {
      override onUpdate(): void {
        ticks++;
      }
    }
    class Broken extends Script {
      constructor() {
        super();
        throw new Error("syntax-ish error");
      }
    }
    runtime.define("S", Good);
    world.createEntity("e").add(new ScriptComponent("S"));
    world.runSystems(ctx(world));
    assert.deepEqual(runtime.reload("S", Broken), { replaced: 0, failed: 1 });
    assert.equal(runtime.lastError!.phase, "reload");
    world.runSystems(ctx(world));
    assert.equal(ticks, 2);
  });

  test("a faulted script is revived by a fixed class; a throwing onReload faults the new one", () => {
    const world = new EntityWorld();
    const runtime = ScriptRuntime.install(world);
    let fixedRuns = 0;
    class Buggy extends Script {
      override onUpdate(): void {
        throw new Error("bug");
      }
    }
    class Fixed extends Script {
      override onUpdate(): void {
        fixedRuns++;
      }
    }
    class Worse extends Script {
      override onReload(): void {
        throw new Error("reload hook bug");
      }
    }
    runtime.define("S", Buggy);
    const comp = new ScriptComponent("S");
    world.createEntity("e").add(comp);
    world.runSystems(ctx(world));
    assert.equal(comp.scripts[0]!.state, "faulted");
    runtime.reload("S", Fixed);
    world.runSystems(ctx(world));
    assert.equal(fixedRuns, 1);
    assert.equal(comp.scripts[0]!.state, "active");
    runtime.reload("S", Worse);
    assert.equal(comp.scripts[0]!.state, "faulted");
    assert.equal(runtime.lastError!.message, "reload hook bug");
  });

  test("pending scripts swap silently and start with onCreate; later components get the new class", () => {
    const world = new EntityWorld();
    const runtime = ScriptRuntime.install(world);
    const log: string[] = [];
    class V1 extends Script {
      override onCreate(): void {
        log.push("v1 create");
      }
    }
    class V2 extends Script {
      override onCreate(): void {
        log.push("v2 create");
      }
      override onReload(): void {
        log.push("v2 reload");
      }
    }
    runtime.define("S", V1);
    const comp = new ScriptComponent("S");
    world.createEntity("e").add(comp);
    comp.scripts[0]!.enabled = false;
    runtime.reload("S", V2);
    assert.deepEqual(log, [], "never created: no hooks at reload");
    assert.equal(comp.scripts[0]!.enabled, false, "enabled carries over");
    comp.scripts[0]!.enabled = true;
    world.createEntity("f").add(new ScriptComponent("S"));
    world.runSystems(ctx(world));
    assert.deepEqual(log, ["v2 create", "v2 create"]);
  });
});

await finish();
