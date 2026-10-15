/**
 * @suite scripting:scriptLifecycle
 * @group unit
 * @covers engine/src/scripting/script.ts
 * @covers engine/src/scripting/component.ts
 * @covers engine/src/scripting/runtime.ts
 * @covers engine/src/scripting/index.ts
 * @covers engine/src/scene/world.ts
 * @desc Phase 18.1 script lifecycle (hook bands and order, create/destroy timing, enable gating, names) and 18.5 error isolation (faults, structural rollback, other scripts/systems and the clock untouched)
 */

export const suite = {
  name: "scripting:scriptLifecycle",
  group: "unit",
  covers: [
    "engine/src/scripting/script.ts",
    "engine/src/scripting/component.ts",
    "engine/src/scripting/runtime.ts",
    "engine/src/scripting/index.ts",
    "engine/src/scene/world.ts",
  ],
  desc: "Phase 18.1 script lifecycle (hook bands and order, create/destroy timing, enable gating, names) and 18.5 error isolation (faults, structural rollback, other scripts/systems and the clock untouched)",
};
import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import {
  Clock,
  Component,
  EntityWorld,
  LogLevel,
  Logger,
  Profiler,
  Script,
  ScriptComponent,
  ScriptRuntime,
  System,
  SystemScratch,
  registerComponent,
  type ScriptContext,
  type SystemContext,
} from "@forge/engine";

class Health extends Component {
  static readonly typeName = "TestHealth";
  constructor(public hp = 100) {
    super();
  }
}
registerComponent(Health as never, { name: "TestHealth" });

let frame = 0;
function ctx(world: EntityWorld, fixedSteps = 1, dt = 1 / 30, fixedDt = 1 / 60): SystemContext {
  frame++;
  return {
    world,
    clock: new Clock(),
    dt,
    fixedDt,
    fixedSteps,
    alpha: 0.25,
    elapsed: frame * dt,
    frame,
    logger: new Logger({ level: LogLevel.Silent }),
    profiler: new Profiler(),
    services: { get: () => undefined, engineConfig: {} },
    scratch: new SystemScratch(),
  };
}

/** Records every hook into a shared log as "<tag>:<hook>". */
class Recorder extends Script {
  constructor(private readonly log: string[], readonly tag: string) {
    super();
  }
  override onCreate(): void {
    this.log.push(`${this.tag}:create`);
  }
  override onPreUpdate(): void {
    this.log.push(`${this.tag}:pre`);
  }
  override onFixedUpdate(c: ScriptContext): void {
    this.log.push(`${this.tag}:fixed${c.time.fixedStep}`);
  }
  override onUpdate(): void {
    this.log.push(`${this.tag}:update`);
  }
  override onLateUpdate(): void {
    this.log.push(`${this.tag}:late`);
  }
  override onDestroy(): void {
    this.log.push(`${this.tag}:destroy`);
  }
}

/** A plain system in a given band that logs when it runs. */
class Probe extends System {
  override readonly order: number;
  constructor(readonly name: string, order: number, private readonly log: string[]) {
    super();
    this.order = order;
  }
  update(): void {
    this.log.push(`sys:${this.name}`);
  }
}

function setup(options = {}): { world: EntityWorld; runtime: ScriptRuntime; log: string[] } {
  const world = new EntityWorld();
  const runtime = ScriptRuntime.install(world, options);
  return { world, runtime, log: [] };
}

group("lifecycle (18.1)", () => {
  test("one frame runs create, pre, each fixed step, update, late in their bands", () => {
    const { world, log } = setup();
    world.registerSystem(new Probe("vehicles", 110, log));
    world.registerSystem(new Probe("animation", 300, log));
    world.registerSystem(new Probe("world", 400, log));
    world.createEntity("a").add(new ScriptComponent(new Recorder(log, "a")));
    world.runSystems(ctx(world, 2));
    assert.deepEqual(log, ["a:create", "a:pre", "a:fixed0", "a:fixed1", "sys:vehicles", "a:update", "sys:animation", "sys:world", "a:late"]);
    log.length = 0;
    world.runSystems(ctx(world, 0));
    assert.deepEqual(log, ["a:pre", "sys:vehicles", "a:update", "sys:animation", "sys:world", "a:late"], "no fixed hooks on a render-only frame");
    const order = world.systems.map((s) => s.name);
    assert.ok(order.indexOf("scripts.late") < order.indexOf("transforms"), "late hooks run before transforms");
  });

  test("scripts run in creation order, across components and entities, every frame", () => {
    const { world, log } = setup();
    const a = world.createEntity("a");
    const b = world.createEntity("b");
    b.add(new ScriptComponent(new Recorder(log, "b1"), new Recorder(log, "b2")));
    a.add(new ScriptComponent(new Recorder(log, "a1")));
    world.runSystems(ctx(world, 0));
    world.runSystems(ctx(world, 0));
    const updates = log.filter((x) => x.endsWith(":update"));
    assert.deepEqual(updates, ["b1:update", "b2:update", "a1:update", "b1:update", "b2:update", "a1:update"]);
  });

  test("time: copies of the clock, fixed dt and step index inside onFixedUpdate", () => {
    const { world } = setup();
    const seen: string[] = [];
    class T extends Script {
      override onFixedUpdate(c: ScriptContext): void {
        seen.push(`fixed ${c.time.dt.toFixed(4)} ${c.time.fixedStep}`);
      }
      override onUpdate(c: ScriptContext): void {
        seen.push(`update ${c.time.dt.toFixed(4)} ${c.time.alpha} ${c.time.frame === frame}`);
        assert.equal(c.entity.name, "t");
        assert.equal(c.world, world);
        assert.equal((c as unknown as Record<string, unknown>).clock, undefined, "no Clock reachable from a script");
        assert.equal((c as unknown as Record<string, unknown>).render, undefined, "no render context reachable from a script");
      }
    }
    world.createEntity("t").add(new ScriptComponent(new T()));
    world.runSystems(ctx(world, 2, 1 / 30, 1 / 60));
    assert.deepEqual(seen, ["fixed 0.0167 0", "fixed 0.0167 1", "update 0.0333 0.25 true"]);
  });

  test("a script added mid-frame starts at the next phase; never a hook before onCreate", () => {
    const { world, log } = setup();
    const late = world.createEntity("late");
    class Spawner extends Script {
      override onUpdate(): void {
        if (!late.has(ScriptComponent)) late.add(new ScriptComponent(new Recorder(log, "n")));
        log.push("spawner:update");
      }
    }
    world.createEntity("s").add(new ScriptComponent(new Spawner()));
    world.runSystems(ctx(world, 1));
    assert.deepEqual(log, ["spawner:update", "n:create", "n:late"]);
  });

  test("enabled gates per-frame hooks and defers onCreate; component.enabled does too", () => {
    const { world, log } = setup();
    const r = new Recorder(log, "r");
    r.enabled = false;
    const comp = new ScriptComponent(r);
    world.createEntity("e").add(comp);
    world.runSystems(ctx(world, 1));
    assert.deepEqual(log, []);
    assert.equal(r.state, "pending");
    r.enabled = true;
    world.runSystems(ctx(world, 0));
    assert.deepEqual(log, ["r:create", "r:pre", "r:update", "r:late"]);
    log.length = 0;
    comp.enabled = false;
    world.runSystems(ctx(world, 1));
    assert.deepEqual(log, []);
  });

  test("onDestroy: entity destroy sees the other components; remove(); never-created scripts get none", () => {
    const { world, log } = setup();
    const e = world.createEntity("e");
    e.add(new Health(42));
    let hpAtDestroy = -1;
    class Watch extends Script {
      override onDestroy(c: ScriptContext): void {
        hpAtDestroy = c.entity.get(Health)?.hp ?? -1;
        log.push("watch:destroy");
      }
    }
    const pendingOnly = new Recorder(log, "p");
    pendingOnly.enabled = false;
    const comp = new ScriptComponent(new Watch(), pendingOnly);
    e.add(comp);
    world.runSystems(ctx(world, 0));
    const extra = new Recorder(log, "x");
    world.createEntity("x").add(new ScriptComponent(extra));
    world.runSystems(ctx(world, 0));
    log.length = 0;
    assert.ok(world.facade(extra.entityId!)!.get(ScriptComponent)!.remove(extra));
    assert.deepEqual(log, ["x:destroy"]);
    assert.equal(extra.state, "destroyed");
    log.length = 0;
    e.destroy();
    assert.deepEqual(log, ["watch:destroy"], "the never-created script got no onDestroy");
    assert.equal(hpAtDestroy, 42);
    assert.equal(pendingOnly.state, "destroyed");
    assert.equal(comp.scripts.length, 0);
  });

  test("removing the component, and destroying from inside a hook, both end in onDestroy", () => {
    const { world, log } = setup();
    const a = world.createEntity("a");
    a.add(new ScriptComponent(new Recorder(log, "a")));
    const b = world.createEntity("b");
    b.add(new ScriptComponent(new Recorder(log, "b")));
    class Killer extends Script {
      override onUpdate(): void {
        b.destroy();
        log.push("killer:update");
      }
    }
    world.createEntity("k").add(new ScriptComponent(new Killer()));
    world.runSystems(ctx(world, 0));
    assert.ok(log.indexOf("b:destroy") > log.indexOf("killer:update"), "destroy is deferred to the end of the hook's scope");
    assert.ok(!log.includes("b:late"), "a destroyed script runs nothing after it");
    log.length = 0;
    a.remove(ScriptComponent);
    assert.deepEqual(log, ["a:destroy"]);
  });

  test("names: define, components attached before install are adopted, unknown names are recorded", () => {
    const world = new EntityWorld();
    const log: string[] = [];
    class Named extends Script {
      override onUpdate(): void {
        log.push(`named:${this.scriptName}`);
      }
    }
    world.createEntity("e").add(new ScriptComponent("Mover", "Nope"));
    const runtime = ScriptRuntime.install(world);
    runtime.define("Mover", Named);
    // Names resolve at adoption; adoption happened at install, before define, so re-attach.
    assert.equal(runtime.errors.length, 2);
    const e2 = world.createEntity("e2");
    e2.add(new ScriptComponent("Mover"));
    world.runSystems(ctx(world, 0));
    assert.deepEqual(log, ["named:Mover"]);
    assert.equal(runtime.errors[0]!.message.includes("unknown script"), true);
    assert.throws(() => runtime.define("Mover", Named), /already defined/);
    assert.throws(() => ScriptRuntime.install(world), /already has a script runtime/);
  });

  test("dispose: every created script gets onDestroy, systems unregistered, components inert", () => {
    const { world, runtime, log } = setup();
    world.createEntity("a").add(new ScriptComponent(new Recorder(log, "a")));
    world.runSystems(ctx(world, 0));
    log.length = 0;
    runtime.dispose();
    assert.deepEqual(log, ["a:destroy"]);
    assert.ok(!world.systems.some((s) => s.name.startsWith("scripts.")));
    assert.equal(ScriptRuntime.of(world), undefined);
    world.runSystems(ctx(world, 1));
    assert.deepEqual(log, ["a:destroy"]);
    ScriptRuntime.install(world).dispose();
  });
});

group("error isolation (18.5)", () => {
  test("a throwing hook faults its script; the rest of the phase, other systems and later frames run", () => {
    const errors: string[] = [];
    const { world, runtime, log } = setup({ onError: (e: { script: string; phase: string }) => errors.push(`${e.script}:${e.phase}`) });
    world.registerSystem(new Probe("after", 250, log));
    class Bad extends Script {
      override onUpdate(): void {
        log.push("bad:update");
        throw new Error("boom");
      }
      override onLateUpdate(): void {
        log.push("bad:late");
      }
    }
    const bad = new Bad();
    world.createEntity("bad").add(new ScriptComponent(bad));
    world.createEntity("good").add(new ScriptComponent(new Recorder(log, "good")));
    world.runSystems(ctx(world, 0));
    assert.deepEqual(log.filter((x) => !x.endsWith(":create") && !x.endsWith(":pre")), ["bad:update", "good:update", "sys:after", "good:late"]);
    assert.equal(bad.state, "faulted");
    assert.deepEqual(errors, ["Bad:update"]);
    assert.equal(runtime.lastError!.message, "boom");
    assert.equal(runtime.lastError!.faulted, true);
    log.length = 0;
    world.runSystems(ctx(world, 0));
    assert.deepEqual(log, ["good:pre", "good:update", "sys:after", "good:late"]);
    const st = runtime.stats();
    assert.deepEqual([st.scriptsFaulted, st.scriptsActive, st.scriptErrors, st.scriptRollbacks], [1, 1, 1, 1]);
  });

  test("structural changes of a failing hook are discarded as a unit; a passing hook's land", () => {
    const { world } = setup();
    const victim = world.createEntity("victim");
    const target = world.createEntity("target");
    let spawned = 0;
    class Partial extends Script {
      constructor(private readonly fail: boolean) {
        super();
      }
      override onUpdate(): void {
        const made = world.createEntity("made");
        spawned = made.id;
        made.add(new Health(1));
        target.add(new Health(5));
        victim.destroy();
        if (this.fail) throw new Error("half way");
      }
    }
    const before = world.liveEntityCount;
    const p = new Partial(true);
    world.createEntity("p").add(new ScriptComponent(p));
    world.runSystems(ctx(world, 0));
    assert.equal(world.liveEntityCount, before + 1, "only the script's own entity was added");
    assert.ok(world.exists(victim.id), "the queued destroy was discarded");
    assert.equal(target.has(Health), false, "the queued add was discarded");
    assert.equal(world.exists(spawned), false, "the entity the hook created is gone");

    world.createEntity("q").add(new ScriptComponent(new Partial(false)));
    world.runSystems(ctx(world, 0));
    assert.equal(world.exists(victim.id), false);
    assert.equal(target.get(Health)!.hp, 5);
    assert.equal(world.facade(spawned)!.get(Health)!.hp, 1);
  });

  test("a script cannot disturb the clock or the time other scripts see", () => {
    const { world } = setup();
    const seen: number[] = [];
    class Vandal extends Script {
      override onUpdate(c: ScriptContext): void {
        (c.time as { dt: number }).dt = 999;
        (c.time as { elapsed: number }).elapsed = -1;
        throw new Error("and then threw");
      }
    }
    class Reader extends Script {
      override onUpdate(c: ScriptContext): void {
        seen.push(c.time.dt, c.time.elapsed);
      }
    }
    world.createEntity("v").add(new ScriptComponent(new Vandal()));
    world.createEntity("r").add(new ScriptComponent(new Reader()));
    const c = ctx(world, 0, 0.02);
    const clockBefore = { ...c.clock };
    world.runSystems(c);
    assert.deepEqual(seen, [0.02, c.elapsed]);
    assert.deepEqual({ ...c.clock }, clockBefore, "the frame's Clock object is untouched");
  });

  test("a throwing onCreate faults (no hooks) but still gets onDestroy to clean up", () => {
    const { world, runtime, log } = setup();
    class BadStart extends Script {
      override onCreate(): void {
        log.push("create");
        throw new Error("no");
      }
      override onUpdate(): void {
        log.push("update");
      }
      override onDestroy(): void {
        log.push("destroy");
      }
    }
    const e = world.createEntity("e");
    e.add(new ScriptComponent(new BadStart()));
    world.runSystems(ctx(world, 1));
    world.runSystems(ctx(world, 1));
    e.destroy();
    assert.deepEqual(log, ["create", "destroy"]);
    assert.equal(runtime.lastError!.phase, "create");
  });

  test("faultAfter: errors are tolerated until the limit; 0 never faults", () => {
    for (const [faultAfter, expectRuns] of [[3, 3], [0, 5]] as const) {
      const { world } = setup({ faultAfter });
      let runs = 0;
      class Flaky extends Script {
        override onUpdate(): void {
          runs++;
          throw new Error("flaky");
        }
      }
      const f = new Flaky();
      world.createEntity("f").add(new ScriptComponent(f));
      for (let i = 0; i < 5; i++) world.runSystems(ctx(world, 0));
      assert.equal(runs, expectRuns, `faultAfter ${faultAfter}`);
      assert.equal(f.errorCount, expectRuns);
      assert.equal(f.state, faultAfter === 0 ? "active" : "faulted");
    }
  });

  test("a throwing onDestroy or onError handler does not break destruction", () => {
    const { world, runtime } = setup({
      onError: () => {
        throw new Error("handler also broken");
      },
    });
    class BadEnd extends Script {
      override onDestroy(): void {
        throw new Error("cleanup failed");
      }
    }
    const e = world.createEntity("e");
    e.add(new Health(3));
    e.add(new ScriptComponent(new BadEnd()));
    world.runSystems(ctx(world, 0));
    const id = e.id;
    e.destroy();
    assert.equal(world.exists(id), false);
    assert.equal(runtime.lastError!.phase, "destroy");
    assert.equal(runtime.stats().scriptsLive, 0);
  });

  test("errors history is capped", () => {
    const { world, runtime } = setup({ faultAfter: 0, errorHistory: 4 });
    class Loud extends Script {
      override onUpdate(c: ScriptContext): void {
        throw new Error(`frame ${c.time.frame}`);
      }
    }
    world.createEntity("l").add(new ScriptComponent(new Loud()));
    for (let i = 0; i < 10; i++) world.runSystems(ctx(world, 0));
    assert.equal(runtime.errors.length, 4);
    assert.equal(runtime.stats().scriptErrors, 10);
    assert.equal(runtime.errors[3]!.message, `frame ${frame}`);
  });
});

await finish();
