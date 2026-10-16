# Scripting (Phase 18)

Gameplay code as scripts on entities: `engine/src/scripting/`. As built so far: **18.1 lifecycle**,
**18.2 timers** and **18.5 error isolation**. Coroutines (18.3), typed events (18.4) and hot reload
(18.7) are not built yet. The 18.6 API boundary is partly enforced (below).

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
