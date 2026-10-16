# Scripting (Phase 18)

Gameplay code as scripts on entities: `engine/src/scripting/`. As built so far: **18.1 lifecycle**,
**18.2 timers**, **18.3 coroutines**, **18.4 typed events**, **18.5 error isolation** and **18.7 hot
reload**. The 18.6 API boundary is partly enforced (below). The 18.6 API boundary is partly enforced (below).

## Using it

```ts
import { Script, ScriptComponent, ScriptRuntime, type ScriptContext } from "@forge/engine";

class Spinner extends Script {
  speed = 1;
  override onCreate(c: ScriptContext): void {
    c.logger.info(`spinner on ${c.entity.name}`);
  }
  override onUpdate(c: ScriptContext): void {
    // act on the world through the entity and its components
  }
}

const scripts = ScriptRuntime.install(scene.world); // once per world
scripts.define("Spinner", Spinner);                 // optional: lets components name it
scene.createEntity("top").add(new ScriptComponent(new Spinner()));
scene.createEntity("top2").add(new ScriptComponent("Spinner"));
```

Hooks are optional methods on `Script`, so under `noImplicitOverride` (this repo's setting) they
take `override`.

One `ScriptComponent` holds any number of scripts (`add`, `remove`, `get(Class)`). A name is
resolved when the runtime adopts the component, so define names before attaching components that
use them; an unknown name is recorded as a script error, not thrown.

## Hooks and where they run

`ScriptRuntime.install` registers four systems in the world's bands (`scene/systems.ts`):

| Hook | System | Band | Runs |
| --- | --- | --- | --- |
| `onCreate` | every phase | — | once, at the first phase after the script is attached and enabled, before any other hook |
| `onPreUpdate` | `scripts.pre` | 0 | every frame, before the simulation |
| `onFixedUpdate` | `scripts.fixed` | 100 | once per fixed step, before `vehicles` (110) and `physics` (300) |
| `onUpdate` | `scripts.update` | 200 | every frame, after the fixed band |
| `onLateUpdate` | `scripts.late` | 450 | after animation (300/310) and world systems (400), before `transforms` (500) |
| `onDestroy` | — | — | once, when the script, its component or its entity is removed, or the runtime is disposed |

Rules the tests pin (`tests/scripting/scriptLifecycle.test.ts`):

- **Order.** Within a phase, scripts run in creation order, the same every frame.
- **Late arrivals.** A script attached mid-frame (say, by another script's `onUpdate`) is created at
  the next phase of the same frame and gets that phase's hook. It never sees a hook before `onCreate`.
- **Enabling.** `script.enabled = false` (or `component.enabled = false`) skips the per-frame hooks
  and defers `onCreate` until the script is enabled.
- **Destroying.** `onDestroy` runs only for scripts whose `onCreate` started. When the entity is
  destroyed, its other components are still readable inside `onDestroy`. A destroy requested inside
  a hook is applied when that hook's scope ends, like any structural change made inside a system.
- **Time.** `context.time` holds copies: `dt` (`fixedDt` inside `onFixedUpdate`), `fixedDt`,
  `elapsed`, `frame`, `alpha`, and `fixedStep` (the step index within the frame). The context
  object is reused between calls, so read from it during the call and don't keep it.

Like every `FixedSystem`, `scripts.fixed` runs all of the frame's fixed steps before `vehicles` runs
its own; the engine does not interleave fixed systems step by step. A script that sets inputs in
`onFixedUpdate` is fine. One that needs to read the vehicle's state after each step is not served by
that yet.

## Timers (18.2)

```ts
class Turret extends Script {
  override onCreate(): void {
    this.every(0.5, (c) => this.fire(c));                       // "sim": every 30 steps at 60 Hz
    this.after(0, () => this.reload(), { steps: 90 });          // exact fixed steps
    this.every(0.25, () => this.blink(), { clock: "render" });  // frame seconds, cosmetic
  }
}
```

`after(seconds, cb, options?)` runs once and `every(seconds, cb, options?)` repeats. Both return a
handle with `cancel()`, `active`, `fires`, `clock` and `interval`. `script.timers` lists the live
ones and `script.cancelTimers()` drops them all. The callback receives the script context and its
own handle, so a repeating timer can cancel itself.

- **`"sim"` (the default) is deterministic.** Seconds become whole fixed steps (`seconds / fixedDt`,
  rounded up, at least 1), or pass `{ steps }` for an exact count. Due timers fire at the start of
  the fixed step they land on, before that step's `onFixedUpdate`. Timers due on the same step fire
  in creation order. The same sequence of fixed steps gives the same firings on the same ticks,
  however the steps were split across frames. `context.time.tick` is that fixed-step counter (the
  first step is 1).
- **`"render"` counts frame seconds** (`dt`, so time scale applies) and fires at the start of the
  update phase, before `onUpdate`. A repeating render timer fires at most once per frame. If a frame
  overshoots a whole interval, the missed occurrences are dropped and the next one is scheduled an
  interval from now.
- **Timers belong to their script.** They fire only while the script is active and enabled. One that
  comes due while the script is disabled waits, and fires at the first chance after it is enabled
  again. A repeating timer then resumes its cadence. Destroying or faulting the script cancels its
  timers, and scheduling from a destroyed or faulted script, including from inside `onDestroy`, is a
  usage error. A timer created by a timer callback waits at least until the next pass, so an
  `after(0)` chain runs once per frame and never spins.
- **Callbacks are isolated like hooks.** A throw is recorded with phase `"timer"`, counts toward
  `faultAfter`, and rolls back the callback's structural changes.

Seconds are converted with the latest `fixedDt` the runtime has seen (1/60 before the first frame).

## Coroutines (18.3)

```ts
import { Wait } from "@forge/engine";

class Door extends Script {
  override onCreate(): void {
    const opening = this.startCoroutine(function* (ctx) {
      yield Wait.until(() => switchPressed());   // checked every frame
      for (let i = 0; i < 30; i++) {
        moveDoor(i / 30);
        yield;                                    // one frame
      }
      yield Wait.seconds(5);
      closeDoor();
    });
    // opening.pause() / opening.resume() / opening.cancel()
  }
}
```

`startCoroutine(body, { clock, name })` takes a generator function, called with `this` bound to the
script. It returns a handle with `pause()`, `resume()`, `cancel()`, `state` (`running`, `paused`,
`done`, `cancelled` or `failed`) and `alive`. `script.coroutines` lists the live ones, and
`script.stopCoroutines()` cancels them all.

- **It starts now.** The body runs immediately, up to its first `yield`, inside the caller's call.
  Each later resume receives a fresh context as the value of the `yield` expression.
- **Clocks.** `"render"` (default) advances once per frame at the start of the update phase, after due
  render timers and before `onUpdate`. `"sim"` advances once per fixed step, after due sim timers and
  before `onFixedUpdate`, and lands on the same ticks however frames split the steps. Coroutines on
  one clock advance in start order. A coroutine started in `onCreate` or `onPreUpdate` gets its next
  render tick in that same frame's update phase.
- **What it can yield:**
  - a bare `yield`, to resume on the next tick;
  - `Wait.seconds(s)`, which counts frame `dt` on the render clock and whole fixed steps (rounded up)
    on the sim clock;
  - `Wait.frames(n)` (render only) or `Wait.steps(n)` (sim only);
  - `Wait.until(pred)` or `Wait.while(pred)`, re-checked every tick starting with the next one;
  - another coroutine's handle, to resume once that coroutine has finished, been cancelled or
    failed.

  Yielding anything else is an error.
- **Pause and resume.** A paused coroutine stops where it is: its wait stops counting and its
  predicate is not evaluated. `resume()` continues with the time that was left.
- **Cancel.** Cancelling closes the generator, so its `finally` blocks run. A coroutine that cancels
  itself does so at its next `yield`. Coroutines are cancelled when their script is destroyed or
  faulted.
- **Ownership and isolation.** A coroutine advances only while its script is active and enabled.
  While it can't advance, its waits don't count down. A throw from the body, from a predicate or from
  a bad yield fails the coroutine, still runs its `finally` blocks, rolls back the step's structural
  changes, and counts as its script's error (phase `"coroutine"`, toward `faultAfter`).
  `runtime.stats()` counts active, completed, cancelled and failed coroutines.

## Typed events (18.4)

```ts
import { defineEvent, type EntityId } from "@forge/engine";

export const Damaged = defineEvent<{ amount: number; from: EntityId }>("Damaged");

class Health extends Script {
  hp = 100;
  override onCreate(): void {
    this.on(Damaged, (e) => (this.hp -= e.amount), { entity: this.entity! }); // hits on me only
  }
}
class Turret extends Script {
  shoot(target: Entity): void {
    this.emit(Damaged, { amount: 10, from: this.entityId! }, { to: target });
  }
}
```

- **Typed tokens.** `defineEvent<T>(name)` returns a token that carries the payload type, so emitters
  and listeners in different modules agree without a shared global type. Two definitions are two
  different events, even with the same name.
- **Channels.** An event goes to the world channel, or with `{ to: entity }` to that entity's
  channel. `this.on(type, handler, { entity })` listens on an entity's channel; without it, on the
  world channel. A targeted event reaches only that entity's listeners.
- **`emit` delivers now**, synchronously, in subscription order. **`post` queues the event.** Queued
  events are delivered first in, first out, at the start of the next script phase (pre, each fixed
  step, update or late), before that phase's timers, coroutines and hooks. An event posted while the
  queue is being delivered waits for the phase after that.
- **Script listeners are isolated like hooks** (phase `"event"`). A throw is recorded, rolls back
  the handler's structural changes and counts toward `faultAfter`. The emitter and the other
  listeners are unaffected. A listener hears events only while its script is active and enabled; an
  event arriving otherwise is not kept for it. Its listeners are removed when the script is destroyed
  or faulted, and an entity's channel goes away with the entity. `{ once: true }` and disposing the
  returned handle also unsubscribe.
- **Re-entrancy.** Handlers may emit, subscribe and unsubscribe. A listener added during a dispatch
  first hears the next one, and removing a listener never skips a sibling. A nested `emit` deeper
  than `maxEventDepth` (option, default 16) is refused with a recorded usage error, so an event loop
  stops instead of recursing.
- **Host code** uses `runtime.events.on/emit/post/listenerCount`. Host listeners are plain callbacks:
  their errors are caught and recorded as script `"host"`. `runtime.stats()` counts deliveries and
  queued events.

## Hot reload (18.7)

`runtime.reload(name, NewClass)` makes `name` resolve to `NewClass` from now on. It also swaps every
live script created under that name, or as an instance of the class previously defined for it, for a
new instance, in place: same entity, same component slot, same execution order. It returns
`{ replaced, failed }`. The engine stays bundler-agnostic, so the dev server wires it up. With Vite:

```ts
// scripts/guard.ts
export class Guard extends Script { /* ... */ }
if (import.meta.hot) {
  import.meta.hot.accept((mod) => mod && scripts.reload("Guard", mod.Guard));
}
```

For each matching script:

1. **The new instance is constructed first.** If its constructor throws, the error is recorded
   (phase `"reload"`), the old script keeps running, and it counts as `failed`.
2. **The old instance is retired.** Its timers, coroutines and event listeners are cancelled, because
   their closures belong to the old code. Then its `onUnload(ctx)` runs, if it had been created.
3. **Data carries over.** The old instance's own data fields are copied onto the new one: enumerable
   fields only, no functions and no `_`-prefixed internals, so `enabled` carries over. Field
   initializers run first, and the copied values replace them.
4. **The new instance starts.** If the old one had been created, the new one's
   `onReload(ctx, previous)` runs. Re-register timers, coroutines and listeners there. Without
   `onReload`, its `onCreate` runs instead, and sees the carried data (an `onCreate` that resets fields
   will reset them). A script that was never created stays pending and gets its `onCreate` as usual.

A faulted script is replaced too, so a hot fix revives it. A throw from `onReload`, `onCreate` or
`onUnload` during a reload faults that instance, like a throwing `onCreate`. Components attached
later with the name get the new class. `runtime.stats().scriptsReloaded` counts the swaps.

## Error isolation (18.5)

Every hook is called inside its own deferred-structure scope
(`EntityWorld._beginStructuralScope`/`_endStructuralScope`, the same queue `runSystems` uses per
system). When a hook throws:

- **The ECS stays whole.** The add, remove and destroy calls it queued are discarded, and the
  entities it created are destroyed. A hook's structural changes land all-or-nothing. Plain field
  writes made before the throw do stay, so compute first and commit last.
- **Nothing else stops.** The runtime catches the error, so the other scripts in the phase, every
  other system (physics, rendering, transforms) and later frames run as usual.
- **The clock is untouched.** Scripts never receive the `Clock`, only copies of its values, and the
  copies are rewritten before every call, so one script cannot change the time another one sees.
- **The script is faulted** after `faultAfter` errors (option, default 1; 0 never faults). A
  throwing `onCreate` always faults. A faulted script runs no more per-frame hooks but still gets
  `onDestroy` to release what it holds.
- **It is reported** in `runtime.errors` (the last `errorHistory`, default 32), `runtime.lastError`,
  the `onError` option, and the frame logger scoped `scripts`. `runtime.stats()` counts live,
  active, pending and faulted scripts, plus errors, rollbacks and hook calls.

**Limit:** JavaScript cannot interrupt a hook that never returns. An infinite loop in a script still
hangs the frame.

## API boundary (18.6, partial)

A script's context holds the entity, the world, the time copies and a logger. It holds no GPU
device, render context or solver internals. `engine/src/scripting/` may import only `core`, `math`
and `scene`, which is enforced by `npm run lint:arch` and `tests/engine/architecture.test.ts`.

Not closed yet: a script can reach every component on its entity, so a component that wraps GPU
state is reachable through it.
