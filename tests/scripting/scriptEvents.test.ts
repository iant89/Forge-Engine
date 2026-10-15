/**
 * @suite scripting:scriptEvents
 * @group unit
 * @covers engine/src/scripting/events.ts
 * @covers engine/src/scripting/runtime.ts
 * @covers engine/src/scripting/script.ts
 * @desc Phase 18.4 typed script events: world and entity channels, immediate emit and phase-queued post, once/dispose and re-entrancy, isolated handlers, ownership, the depth guard and host listeners
 */

export const suite = {
  name: "scripting:scriptEvents",
  group: "unit",
  covers: ["engine/src/scripting/events.ts", "engine/src/scripting/runtime.ts", "engine/src/scripting/script.ts"],
  desc: "Phase 18.4 typed script events: world and entity channels, immediate emit and phase-queued post, once/dispose and re-entrancy, isolated handlers, ownership, the depth guard and host listeners",
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
  type Entity,
  type ScriptContext,
  type ScriptRuntimeOptions,
  type SystemContext,
} from "@forge/engine";

let frame = 0;
function ctx(world: EntityWorld, fixedSteps = 0): SystemContext {
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

function setup(options: ScriptRuntimeOptions = {}): { world: EntityWorld; runtime: ScriptRuntime } {
  const world = new EntityWorld();
  return { world, runtime: ScriptRuntime.install(world, options) };
}

/** Attach a script built from hooks; returns the script once it has been created. */
function attach<S extends Script>(world: EntityWorld, script: S, name: string): S {
  world.createEntity(name).add(new ScriptComponent(script));
  return script;
}

const Damaged = defineEvent<{ amount: number }>("Damaged");
const Ping = defineEvent<number>("Ping");

class Listener extends Script {
  constructor(private readonly log: string[], readonly tag: string, private readonly onMe = false) {
    super();
  }
  override onCreate(): void {
    this.on(Damaged, (e, c: ScriptContext) => this.log.push(`${this.tag}:${e.amount}@${c.entity.name}`), this.onMe ? { entity: this.entity! } : undefined);
  }
}

group("delivery", () => {
  test("emit delivers now, in subscription order, with each listener's own context", () => {
    const { world } = setup();
    const log: string[] = [];
    attach(world, new Listener(log, "a"), "ea");
    attach(world, new Listener(log, "b"), "eb");
    class Shooter extends Script {
      override onUpdate(): void {
        this.emit(Damaged, { amount: 5 });
        log.push("after emit");
      }
    }
    attach(world, new Shooter(), "shooter");
    world.runSystems(ctx(world));
    assert.deepEqual(log, ["a:5@ea", "b:5@eb", "after emit"]);
  });

  test("entity channels: a targeted event reaches only that entity's listeners", () => {
    const { world } = setup();
    const log: string[] = [];
    const a = attach(world, new Listener(log, "a", true), "ea");
    attach(world, new Listener(log, "b", true), "eb");
    attach(world, new Listener(log, "world"), "ew");
    let target: Entity | null = null;
    class Shooter extends Script {
      override onUpdate(): void {
        target ??= a.entity;
        this.emit(Damaged, { amount: 7 }, { to: target! });
      }
    }
    attach(world, new Shooter(), "shooter");
    world.runSystems(ctx(world));
    assert.deepEqual(log, ["a:7@ea"]);
  });

  test("post queues until the start of the next phase, first in first out, before that phase's hooks", () => {
    const { world } = setup();
    const log: string[] = [];
    class Poster extends Script {
      override onCreate(): void {
        this.on(Ping, (n) => {
          log.push(`ping${n}`);
          if (n === 1) this.post(Ping, 3); // posted during delivery: next phase
        });
      }
      override onPreUpdate(): void {
        this.post(Ping, 1);
        this.post(Ping, 2);
        log.push("pre");
      }
      override onUpdate(): void {
        log.push("update");
      }
      override onLateUpdate(): void {
        log.push("late");
      }
    }
    attach(world, new Poster(), "p");
    world.runSystems(ctx(world));
    assert.deepEqual(log, ["pre", "ping1", "ping2", "update", "ping3", "late"]);
  });

  test("once, dispose, and changes during a dispatch: added listeners hear the next one, removals skip no sibling", () => {
    const { world, runtime } = setup();
    const log: string[] = [];
    class S extends Script {
      override onCreate(): void {
        this.on(Ping, (n) => log.push(`once${n}`), { once: true });
        const h = this.on(Ping, (n) => {
          log.push(`self-removing${n}`);
          h.dispose();
          this.on(Ping, (m) => log.push(`late-joiner${m}`));
        });
        this.on(Ping, (n) => log.push(`steady${n}`));
      }
    }
    attach(world, new S(), "s");
    world.runSystems(ctx(world));
    runtime.events.emit(Ping, 1);
    runtime.events.emit(Ping, 2);
    assert.deepEqual(log, ["once1", "self-removing1", "steady1", "steady2", "late-joiner2"]);
    assert.equal(runtime.events.listenerCount(Ping), 2);
  });
});

group("isolation and ownership", () => {
  test("a throwing handler is its script's error: faulted and unsubscribed; emitter and siblings carry on", () => {
    const { world, runtime } = setup();
    const log: string[] = [];
    const made: number[] = [];
    class Bad extends Script {
      override onCreate(): void {
        this.on(Damaged, () => {
          made.push(world.createEntity("leak").id);
          throw new Error("handler boom");
        });
      }
    }
    const bad = attach(world, new Bad(), "bad");
    attach(world, new Listener(log, "good"), "good");
    class Shooter extends Script {
      override onUpdate(): void {
        this.emit(Damaged, { amount: 1 });
        log.push("shooter continues");
      }
    }
    const shooter = attach(world, new Shooter(), "shooter");
    world.runSystems(ctx(world));
    world.runSystems(ctx(world));
    assert.equal(bad.state, "faulted");
    assert.equal(shooter.state, "active");
    assert.equal(runtime.lastError!.phase, "event");
    assert.equal(world.exists(made[0]!), false);
    assert.deepEqual(log, ["good:1@good", "shooter continues", "good:1@good", "shooter continues"]);
    assert.equal(runtime.events.listenerCount(Damaged), 1, "the faulted script's listener is gone");
  });

  test("disabled scripts miss events; destroyed scripts and entities take their listeners with them", () => {
    const { world, runtime } = setup();
    const log: string[] = [];
    const a = attach(world, new Listener(log, "a"), "ea");
    const b = attach(world, new Listener(log, "b", true), "eb");
    world.runSystems(ctx(world));
    a.enabled = false;
    runtime.events.emit(Damaged, { amount: 1 });
    a.enabled = true;
    runtime.events.emit(Damaged, { amount: 2 });
    assert.deepEqual(log, ["a:2@ea"]);
    const bId = b.entityId!;
    assert.equal(runtime.events.listenerCount(Damaged, { entity: bId }), 1);
    world.facade(bId)!.destroy();
    assert.equal(runtime.events.listenerCount(Damaged, { entity: bId }), 0);
    world.facade(a.entityId!)!.destroy();
    assert.equal(runtime.events.listenerCount(Damaged), 0);
  });

  test("the depth guard stops an event loop with a recorded error instead of recursing", () => {
    const { world, runtime } = setup({ maxEventDepth: 8, faultAfter: 0 });
    let deliveries = 0;
    class Echo extends Script {
      override onCreate(): void {
        this.on(Ping, (n) => {
          deliveries++;
          this.emit(Ping, n + 1);
        });
      }
    }
    attach(world, new Echo(), "echo");
    world.runSystems(ctx(world));
    runtime.events.emit(Ping, 0);
    assert.equal(deliveries, 8);
    assert.match(runtime.lastError!.message, /nested emit deeper than 8/);
  });

  test("host listeners: on/emit/post from engine code, errors caught and recorded", () => {
    const { world, runtime } = setup();
    const heard: number[] = [];
    const h = runtime.events.on(Ping, (n) => heard.push(n));
    runtime.events.on(Ping, () => {
      throw new Error("host boom");
    });
    class S extends Script {
      sent = false;
      override onUpdate(): void {
        if (!this.sent) this.post(Ping, 9); // delivered at the start of the late phase
        this.sent = true;
      }
    }
    attach(world, new S(), "s");
    runtime.events.emit(Ping, 1);
    world.runSystems(ctx(world));
    world.runSystems(ctx(world));
    assert.deepEqual(heard, [1, 9]);
    assert.equal(runtime.lastError!.script, "host");
    h.dispose();
    runtime.events.emit(Ping, 2);
    assert.deepEqual(heard, [1, 9]);
    const st = runtime.stats();
    assert.ok(st.eventsDelivered >= 4);
    assert.equal(st.eventsQueued, 0);
  });

  test("validation: events need a defined type and an attached script", () => {
    const { world } = setup();
    class S extends Script {}
    assert.throws(() => new S().emit(Ping, 1), /attached to a world/);
    const s = attach(world, new S(), "s");
    assert.throws(() => s.emit({ name: "fake" } as never, 1), /not an event type/);
    assert.throws(() => s.on({} as never, () => {}), /not an event type/);
    assert.notEqual(defineEvent("Ping").id, Ping.id, "same name, different event");
  });
});

await finish();
