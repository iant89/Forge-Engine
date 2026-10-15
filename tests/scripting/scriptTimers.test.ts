/**
 * @suite scripting:scriptTimers
 * @group unit
 * @covers engine/src/scripting/timers.ts
 * @covers engine/src/scripting/runtime.ts
 * @covers engine/src/scripting/script.ts
 * @desc Phase 18.2 script timers: deterministic "sim" timers fire on the same fixed steps however frames split them, "render" timers on frame seconds; cancel, ownership (disabled/destroyed/faulted), isolation and validation
 */

export const suite = {
  name: "scripting:scriptTimers",
  group: "unit",
  covers: ["engine/src/scripting/timers.ts", "engine/src/scripting/runtime.ts", "engine/src/scripting/script.ts"],
  desc: "Phase 18.2 script timers: deterministic \"sim\" timers fire on the same fixed steps however frames split them, \"render\" timers on frame seconds; cancel, ownership (disabled/destroyed/faulted), isolation and validation",
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
  type ScriptContext,
  type ScriptRuntimeOptions,
  type SystemContext,
  type TimerHandle,
} from "@forge/engine";

let frame = 0;
function ctx(world: EntityWorld, fixedSteps = 1, dt = 1 / 60, fixedDt = 1 / 60): SystemContext {
  frame++;
  return {
    world,
    clock: new Clock(),
    dt,
    fixedDt,
    fixedSteps,
    alpha: 0,
    elapsed: frame * dt,
    frame,
    logger: new Logger({ level: LogLevel.Silent }),
    profiler: new Profiler(),
    services: { get: () => undefined, engineConfig: {} },
    scratch: new SystemScratch(),
  };
}

function setup(options: ScriptRuntimeOptions = {}): { world: EntityWorld; runtime: ScriptRuntime } {
  const world = new EntityWorld();
  return { world, runtime: ScriptRuntime.install(world, options) };
}

function attach(world: EntityWorld, script: Script, name = "e"): Script {
  world.createEntity(name).add(new ScriptComponent(script));
  return script;
}

group("sim timers (deterministic)", () => {
  test("seconds round up to whole fixed steps; the callback runs at the start of its step", () => {
    const { world } = setup();
    const log: string[] = [];
    class S extends Script {
      override onCreate(): void {
        this.after(0.05, (c) => log.push(`timer@${c.time.tick}`)); // 3 steps at 1/60
        this.after(0.051, (c) => log.push(`late@${c.time.tick}`)); // 3.06 -> 4 steps
      }
      override onFixedUpdate(c: ScriptContext): void {
        log.push(`fixed@${c.time.tick}`);
      }
    }
    attach(world, new S());
    for (let i = 0; i < 4; i++) world.runSystems(ctx(world, 1));
    assert.deepEqual(log, ["fixed@1", "fixed@2", "timer@3", "fixed@3", "late@4", "fixed@4"]);
  });

  test("the same fixed steps give the same firings, however frames split them", () => {
    const run = (splits: number[]): string[] => {
      const { world } = setup();
      const log: string[] = [];
      class S extends Script {
        override onCreate(): void {
          this.every(0, (c) => log.push(`A${c.time.tick}`), { steps: 3 });
          this.after(0.1, (c) => log.push(`B${c.time.tick}`));
          this.every(0.05, (c) => log.push(`C${c.time.tick}`));
        }
      }
      attach(world, new S());
      for (const n of splits) world.runSystems(ctx(world, n));
      return log;
    };
    const steady = run(Array(12).fill(1));
    // Equal due ticks fire in creation order: A (made first), then B, then C.
    assert.deepEqual(steady, ["A3", "C3", "A6", "B6", "C6", "A9", "C9", "A12", "C12"]);
    assert.deepEqual(run([2, 0, 3, 1, 4, 2]), steady);
    assert.deepEqual(run([12]), steady);
    assert.deepEqual(run([0, 0, 5, 0, 7]), steady);
  });

  test("a timer scheduled from a render-rate hook counts from the current tick", () => {
    const { world } = setup();
    const fired: number[] = [];
    let scheduledAt = -1;
    class S extends Script {
      override onUpdate(c: ScriptContext): void {
        if (scheduledAt < 0 && c.time.tick === 2) {
          scheduledAt = c.time.tick;
          this.after(0, (cc) => fired.push(cc.time.tick), { steps: 2 });
        }
      }
    }
    attach(world, new S());
    for (let i = 0; i < 6; i++) world.runSystems(ctx(world, 1));
    assert.deepEqual(fired, [scheduledAt + 2]);
  });
});

group("render timers", () => {
  test("count frame seconds and fire before onUpdate; repeating ones drop overshot intervals", () => {
    const { world } = setup();
    const log: string[] = [];
    class S extends Script {
      override onCreate(): void {
        this.after(0.5, () => log.push("once"), { clock: "render" });
        this.every(0.25, () => log.push("tick"), { clock: "render" });
      }
      override onUpdate(): void {
        log.push("update");
      }
    }
    attach(world, new S());
    for (const dt of [0.2, 0.2, 0.2, 1.0, 0.2]) world.runSystems(ctx(world, 0, dt));
    // renderTime: 0.2 0.4 0.6 1.6 1.8 -> tick due 0.25 (fires f2, next 0.5), 0.5 (f3, next 0.75),
    // 0.75 overshot at 1.6 (fires once, next 1.85), not yet at 1.8.
    assert.deepEqual(log, ["update", "tick", "update", "once", "tick", "update", "tick", "update", "update"]);
  });

  test("an after(0) chain fires once per pass, never spins", () => {
    const { world } = setup();
    let fires = 0;
    class S extends Script {
      override onCreate(): void {
        const again = (): void => {
          fires++;
          this.after(0, again, { clock: "render" });
        };
        this.after(0, again, { clock: "render" });
      }
    }
    attach(world, new S());
    for (let i = 0; i < 5; i++) world.runSystems(ctx(world, 0));
    assert.equal(fires, 5);
  });
});

group("ownership and cancel", () => {
  test("cancel, cancel from inside the callback, cancelTimers, and handle state", () => {
    const { world, runtime } = setup();
    let a = 0, b = 0, c = 0;
    let ha: TimerHandle | null = null, hb: TimerHandle | null = null;
    class S extends Script {
      override onCreate(): void {
        ha = this.every(0, () => a++, { steps: 1 });
        hb = this.every(0, (_c, self) => {
          if (++b === 2) self.cancel();
        }, { steps: 1 });
        this.every(0, () => c++, { steps: 1 });
      }
    }
    const s = attach(world, new S());
    for (let i = 0; i < 3; i++) world.runSystems(ctx(world, 1));
    assert.deepEqual([a, b, c], [3, 2, 3]);
    assert.equal(hb!.active, false);
    assert.equal(s.timers.length, 2);
    ha!.cancel();
    assert.equal(ha!.active, false);
    assert.equal(ha!.fires, 3);
    s.cancelTimers();
    assert.equal(s.timers.length, 0);
    for (let i = 0; i < 3; i++) world.runSystems(ctx(world, 1));
    assert.deepEqual([a, b, c], [3, 2, 3]);
    assert.equal(runtime.stats().timersActive, 0);
    assert.equal(runtime.stats().timersFired, 8);
  });

  test("a timer due while its script is disabled waits, then resumes its cadence", () => {
    const { world } = setup();
    const ticks: number[] = [];
    class S extends Script {
      override onCreate(): void {
        this.every(0, (c) => ticks.push(c.time.tick), { steps: 2 });
      }
    }
    const s = attach(world, new S());
    world.runSystems(ctx(world, 2)); // fires at 2
    s.enabled = false;
    world.runSystems(ctx(world, 3)); // due at 4 while disabled: held
    s.enabled = true;
    world.runSystems(ctx(world, 3)); // ticks 6..8: held one fires at 6, next 8
    assert.deepEqual(ticks, [2, 6, 8]);
  });

  test("destroying the script cancels its timers; scheduling from onDestroy is a recorded usage error", () => {
    const { world, runtime } = setup();
    let fired = 0;
    class S extends Script {
      override onCreate(): void {
        this.after(0, () => fired++, { steps: 2 });
      }
      override onDestroy(): void {
        this.after(0, () => fired++, { steps: 1 });
      }
    }
    const s = attach(world, new S());
    world.runSystems(ctx(world, 1));
    world.facade(s.entityId!)!.destroy();
    world.runSystems(ctx(world, 3));
    assert.equal(fired, 0);
    assert.equal(runtime.stats().timersActive, 0);
    assert.equal(runtime.lastError!.phase, "destroy");
    assert.match(runtime.lastError!.message, /cannot schedule a timer on a destroyed script/);
    assert.throws(() => s.after(1, () => {}), /destroyed script|does not own/);
  });
});

group("isolation and validation", () => {
  test("a throwing callback is the script's error: faulted, its timers cancelled, others keep firing", () => {
    const { world, runtime } = setup();
    let goodFires = 0, otherFires = 0;
    const made: number[] = [];
    class Bad extends Script {
      override onCreate(): void {
        this.after(0, () => {
          made.push(world.createEntity("leak").id);
          throw new Error("timer boom");
        }, { steps: 1 });
        this.every(0, () => otherFires++, { steps: 1 });
      }
    }
    class Good extends Script {
      override onCreate(): void {
        this.every(0, () => goodFires++, { steps: 1 });
      }
    }
    const bad = attach(world, new Bad(), "bad");
    attach(world, new Good(), "good");
    for (let i = 0; i < 3; i++) world.runSystems(ctx(world, 1));
    assert.equal(bad.state, "faulted");
    assert.equal(runtime.lastError!.phase, "timer");
    assert.equal(runtime.lastError!.message, "timer boom");
    assert.equal(world.exists(made[0]!), false, "the entity the callback created was rolled back");
    assert.equal(otherFires, 0, "the faulted script's other timer was cancelled (it was due after the throwing one)");
    assert.equal(bad.timers.length, 0);
    assert.equal(goodFires, 3);
  });

  test("bad durations and scheduling before attach are usage errors", () => {
    const { world } = setup();
    class S extends Script {}
    const loose = new S();
    assert.throws(() => loose.after(1, () => {}), /attached to a world/);
    const s = attach(world, new S());
    assert.throws(() => s.every(0, () => {}), /invalid duration/);
    assert.throws(() => s.every(0, () => {}, { clock: "render" }), /invalid duration/);
    assert.throws(() => s.after(-1, () => {}, { clock: "render" }), /invalid duration/);
    assert.throws(() => s.after(1, () => {}, { clock: "render", steps: 2 }), /"sim" clock only/);
    assert.throws(() => s.every(0, () => {}, { steps: 0 }), /invalid duration/);
  });
});

await finish();
