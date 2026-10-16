/**
 * @suite scripting:scriptCoroutines
 * @group unit
 * @covers engine/src/scripting/coroutines.ts
 * @covers engine/src/scripting/runtime.ts
 * @covers engine/src/scripting/script.ts
 * @desc Phase 18.3 script coroutines: start-now semantics, render/sim clocks and waits, pause/resume freezing the wait, cancellation running finally blocks, ownership, isolation and validation
 */

export const suite = {
  name: "scripting:scriptCoroutines",
  group: "unit",
  covers: ["engine/src/scripting/coroutines.ts", "engine/src/scripting/runtime.ts", "engine/src/scripting/script.ts"],
  desc: "Phase 18.3 script coroutines: start-now semantics, render/sim clocks and waits, pause/resume freezing the wait, cancellation running finally blocks, ownership, isolation and validation",
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
  Wait,
  type CoroutineHandle,
  type ScriptContext,
  type ScriptRuntimeOptions,
  type SystemContext,
} from "@forge/engine";

let frame = 0;
function ctx(world: EntityWorld, fixedSteps = 0, dt = 0.2, fixedDt = 1 / 60): SystemContext {
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

/** A script whose onCreate starts the given coroutine(s) and logs onUpdate. */
function host(world: EntityWorld, start: (s: Script, log: string[]) => void, log: string[] = [], name = "e"): Script {
  class Host extends Script {
    override onCreate(): void {
      start(this, log);
    }
    override onUpdate(): void {
      log.push("update");
    }
  }
  const s = new Host();
  world.createEntity(name).add(new ScriptComponent(s));
  return s;
}

group("starting and waiting", () => {
  test("the body runs now up to its first yield; a bare yield resumes on the clock's next tick, before onUpdate", () => {
    const { world } = setup();
    const log: string[] = [];
    let resumedOn = "";
    host(world, (s) => {
      s.startCoroutine(function* (c) {
        log.push(`start ${c.entity.name}`);
        const resumed: ScriptContext = yield;
        resumedOn = resumed.entity.name; // read during the call: the context is not kept
        log.push("second");
        yield;
        log.push("third");
      });
      log.push("after start");
    }, log);
    world.runSystems(ctx(world));
    world.runSystems(ctx(world));
    world.runSystems(ctx(world));
    // Started in onCreate (band 0): the render clock's next tick is this frame's update phase.
    assert.deepEqual(log, ["start e", "after start", "second", "update", "third", "update", "update"]);
    assert.equal(resumedOn, "e", "each resume receives the context");
  });

  test("render waits: seconds count frame dt; frames count frames", () => {
    const { world } = setup();
    const log: string[] = [];
    host(world, (s) => {
      s.startCoroutine(function* (c) {
        yield Wait.seconds(0.5); // dt 0.2: 0.2 0.4 0.6 -> third frame
        log.push(`sec@${c.time.frame}`);
        yield Wait.frames(2);
        log.push(`frames@${c.time.frame}`);
      });
    });
    const start = frame;
    for (let i = 0; i < 6; i++) world.runSystems(ctx(world));
    assert.deepEqual(log, [`sec@${start + 3}`, `frames@${start + 5}`]);
  });

  test("sim coroutines advance per fixed step and land on the same ticks however frames split the steps", () => {
    const run = (splits: number[]): string[] => {
      const { world } = setup();
      const log: string[] = [];
      host(world, (s) => {
        s.startCoroutine(function* (c) {
          yield Wait.seconds(0.05); // 3 steps
          log.push(`a${c.time.tick}`);
          yield Wait.steps(4);
          log.push(`b${c.time.tick}`);
          yield;
          log.push(`c${c.time.tick}`);
        }, { clock: "sim" });
      });
      for (const n of splits) world.runSystems(ctx(world, n));
      return log;
    };
    const steady = run(Array(10).fill(1));
    assert.deepEqual(steady, ["a3", "b7", "c8"]);
    assert.deepEqual(run([3, 0, 2, 5]), steady);
    assert.deepEqual(run([10]), steady);
  });

  test("Wait.until / Wait.while check every tick, starting on the next one", () => {
    const { world } = setup();
    const log: string[] = [];
    let flag = false;
    let checks = 0;
    host(world, (s) => {
      s.startCoroutine(function* () {
        yield Wait.until(() => (checks++, flag));
        log.push("until done");
        yield Wait.while(() => flag);
        log.push("while done");
      });
    });
    world.runSystems(ctx(world));
    world.runSystems(ctx(world));
    assert.equal(checks, 2);
    flag = true;
    world.runSystems(ctx(world));
    assert.deepEqual(log, ["until done"]);
    world.runSystems(ctx(world));
    flag = false;
    world.runSystems(ctx(world));
    assert.deepEqual(log, ["until done", "while done"]);
  });

  test("yielding a handle waits until that coroutine ends, however it ends", () => {
    const { world } = setup();
    const log: string[] = [];
    let child: CoroutineHandle | null = null;
    host(world, (s) => {
      s.startCoroutine(function* () {
        child = s.startCoroutine(function* () {
          yield Wait.frames(2);
          log.push("child done");
        });
        yield child;
        log.push(`parent sees ${child.state}`);
        const forever = s.startCoroutine(function* () {
          for (;;) yield;
        });
        s.startCoroutine(function* () {
          yield;
          forever.cancel();
        });
        yield forever;
        log.push(`parent sees ${forever.state}`);
      });
    });
    for (let i = 0; i < 6; i++) world.runSystems(ctx(world));
    assert.deepEqual(log, ["child done", "parent sees done", "parent sees cancelled"]);
  });
});

group("pause, resume and cancel", () => {
  test("pause freezes the wait where it is; resume continues with the time left", () => {
    const { world } = setup();
    const log: string[] = [];
    let h: CoroutineHandle | null = null;
    host(world, (s) => {
      h = s.startCoroutine(function* (c) {
        yield Wait.seconds(0.5);
        log.push(`done@${c.time.frame}`);
      });
    });
    const start = frame;
    world.runSystems(ctx(world)); // 0.2 counted (0.3 left)
    h!.pause();
    assert.equal(h!.state, "paused");
    for (let i = 0; i < 4; i++) world.runSystems(ctx(world));
    h!.resume();
    world.runSystems(ctx(world)); // 0.1 left
    world.runSystems(ctx(world)); // done
    assert.deepEqual(log, [`done@${start + 7}`]);
    assert.equal(h!.state, "done");
    assert.equal(h!.alive, false);
  });

  test("cancel runs finally blocks; from inside itself it takes effect at the next yield", () => {
    const { world, runtime } = setup();
    const log: string[] = [];
    let outer: CoroutineHandle | null = null;
    const s = host(world, (sc) => {
      outer = sc.startCoroutine(function* () {
        try {
          for (;;) yield;
        } finally {
          log.push("outer finally");
        }
      });
      const self: { h: CoroutineHandle | null } = { h: null };
      self.h = sc.startCoroutine(function* () {
        try {
          yield;
          self.h!.cancel();
          log.push("still runs to the yield");
          yield;
          log.push("never");
        } finally {
          log.push("self finally");
        }
      });
    });
    world.runSystems(ctx(world));
    assert.deepEqual(log, ["still runs to the yield", "self finally"]);
    outer!.cancel();
    assert.deepEqual(log.slice(2), ["outer finally"]);
    assert.equal(outer!.state, "cancelled");
    assert.equal(s.coroutines.length, 0);
    assert.equal(runtime.stats().coroutinesCancelled, 2);
  });

  test("stopCoroutines, a disabled script (frozen), destroy and fault all end its coroutines", () => {
    const { world } = setup();
    const log: string[] = [];
    let ticks = 0;
    const s = host(world, (sc) => {
      sc.startCoroutine(function* () {
        try {
          for (;;) {
            ticks++;
            yield;
          }
        } finally {
          log.push("finally");
        }
      });
    });
    world.runSystems(ctx(world));
    s.enabled = false;
    world.runSystems(ctx(world));
    world.runSystems(ctx(world));
    assert.equal(ticks, 2, "frozen while disabled");
    s.enabled = true;
    world.runSystems(ctx(world));
    assert.equal(ticks, 3);
    world.facade(s.entityId!)!.destroy();
    assert.deepEqual(log, ["finally"]);
    assert.throws(() => s.startCoroutine(function* () {}), /destroyed script|does not own/);
  });
});

group("isolation and validation", () => {
  test("a throwing body fails the coroutine, faults the script, cancels its others; other scripts run", () => {
    const { world, runtime } = setup();
    const log: string[] = [];
    const made: number[] = [];
    const bad = host(world, (s) => {
      s.startCoroutine(function* () {
        try {
          for (;;) yield;
        } finally {
          log.push("sibling finally");
        }
      });
      s.startCoroutine(function* () {
        yield;
        made.push(world.createEntity("leak").id);
        throw new Error("co boom");
      });
    }, [], "bad");
    let goodTicks = 0;
    host(world, (s) => {
      s.startCoroutine(function* () {
        for (;;) {
          goodTicks++;
          yield;
        }
      });
    }, [], "good");
    world.runSystems(ctx(world));
    world.runSystems(ctx(world));
    assert.equal(bad.state, "faulted");
    assert.equal(runtime.lastError!.phase, "coroutine");
    assert.equal(runtime.lastError!.message, "co boom");
    assert.deepEqual(log, ["sibling finally"]);
    assert.equal(world.exists(made[0]!), false, "the step's created entity was rolled back");
    assert.equal(goodTicks, 3);
    const st = runtime.stats();
    assert.deepEqual([st.coroutinesFailed, st.coroutinesCancelled, st.coroutinesActive], [1, 1, 1]);
  });

  test("a throwing predicate or a bad yield fails the coroutine and still runs its finally", () => {
    const { world, runtime } = setup({ faultAfter: 0 });
    const log: string[] = [];
    host(world, (s) => {
      s.startCoroutine(function* () {
        try {
          yield Wait.until(() => {
            throw new Error("pred boom");
          });
        } finally {
          log.push("pred finally");
        }
      });
      s.startCoroutine(function* () {
        try {
          yield Wait.steps(2); // render coroutine
        } finally {
          log.push("bad yield finally");
        }
      });
    });
    world.runSystems(ctx(world));
    assert.deepEqual(log.sort(), ["bad yield finally", "pred finally"]);
    const messages = runtime.errors.map((e) => e.message).sort();
    assert.deepEqual(messages, ["Wait.steps is for sim coroutines", "pred boom"]);
    assert.equal(runtime.stats().coroutinesFailed, 2);
  });

  test("start needs an attached script and a generator function", () => {
    const { world } = setup();
    class S extends Script {}
    assert.throws(() => new S().startCoroutine(function* () {}), /attached to a world/);
    const s = new S();
    world.createEntity("e").add(new ScriptComponent(s));
    assert.throws(() => s.startCoroutine((() => 1) as never), /generator function/);
    assert.throws(() => s.startCoroutine(function* () {}, { clock: "wall" as never }), /unknown clock/);
    const h = s.startCoroutine(function* () {});
    assert.equal(h.state, "done", "an empty body finishes at start");
  });
});

await finish();
