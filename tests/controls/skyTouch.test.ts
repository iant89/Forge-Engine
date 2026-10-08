/**
 * @suite controls:skyTouch
 * @group unit
 * @covers examples/src/controls/skyTouch.ts
 * @desc Sky touch panel — the sky demo's controls, on every device
 */

export const suite = {
  name: "controls:skyTouch",
  group: "unit",
  covers:   [
    "examples/src/controls/skyTouch.ts"
  ],
  desc: "Sky touch panel — the sky demo's controls, on every device",
};
/**
 * Sky touch panel — the sky demo's controls, on every device.
 *
 * Same contract as the weather panel (see `tests/controls/weatherTouch.test.ts`): the buttons are a second
 * entrance to the actions the keys already own (`[`/`]`, `T`, `M`), so every mistake that costs is
 * a mismatch between the two — an action only the keys reach, a button that fires twice because a
 * tap sends both `pointerdown` and `click` (a double-toggled Pause is indistinguishable from a dead
 * button), a hold on `+1h` that drops the hour the tap would have applied, or a panel that
 * repaints every frame. The stub elements stand in for the markup in `examples/index.html`.
 */
import assert from "node:assert/strict";
import { advanceTimersByTime, afterEach, finish, group, test, useFakeTimers, useRealTimers } from "selrun";
import {
  attachSkyTouch,
  HOLD_DELAY_MS,
  HOLD_REPEAT_MS,
  type SkyTouchActions,
  type SkyTouchHandle,
} from "../../examples/src/controls/skyTouch.js";

const BUTTON_IDS = ["sk-time-back", "sk-time-fwd", "sk-pause", "sk-mars"] as const;

type Listener = (event: Event) => void;

/** The slice of `HTMLElement` the panel uses: listeners, classes, attributes, pointer capture. */
class StubElement {
  readonly listeners = new Map<string, Listener[]>();
  readonly classes = new Set<string>();
  readonly attrs = new Map<string, string>();
  /** Every class/attribute write, so "an unchanged state writes nothing" can be asserted. */
  writes = 0;
  readonly ownerDocument = { defaultView: undefined };

  readonly classList = {
    add: (name: string): void => {
      this.classes.add(name);
      this.writes++;
    },
    remove: (name: string): void => {
      this.classes.delete(name);
      this.writes++;
    },
    contains: (name: string): boolean => this.classes.has(name),
    toggle: (name: string, force?: boolean): boolean => {
      const next = force ?? !this.classes.has(name);
      if (next) this.classes.add(name);
      else this.classes.delete(name);
      this.writes++;
      return next;
    },
  };

  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type);
    if (list) list.push(fn);
    else this.listeners.set(type, [fn]);
  }

  removeEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type);
    if (!list) return;
    const at = list.indexOf(fn);
    if (at >= 0) list.splice(at, 1);
  }

  setPointerCapture(): void {}
  releasePointerCapture(): void {}
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
    this.writes++;
  }

  /** Deliver an event synchronously, like a real dispatch would. */
  fire(type: string, event: Record<string, unknown> = {}): void {
    const full = { pointerId: 1, pointerType: "touch", button: 0, preventDefault() {}, ...event };
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(full as unknown as Event);
  }

  listenerCount(): number {
    let total = 0;
    for (const list of this.listeners.values()) total += list.length;
    return total;
  }
}

function stubPanel(): { root: HTMLElement; el: (id: (typeof BUTTON_IDS)[number]) => StubElement } {
  const elements = new Map<string, StubElement>();
  for (const id of BUTTON_IDS) elements.set(`#${id}`, new StubElement());
  const root = {
    querySelector: (selector: string) => elements.get(selector) ?? null,
    ownerDocument: { defaultView: undefined },
  };
  return {
    root: root as unknown as HTMLElement,
    el: (id) => elements.get(`#${id}`)!,
  };
}

interface Harness {
  panel: ReturnType<typeof stubPanel> | null;
  handle: SkyTouchHandle;
  scrubs: number[];
  pauses: () => number;
  planets: () => Array<"earth" | "mars">;
  writes: () => number;
}

function harness(withPanel = true): Harness {
  const panel = withPanel ? stubPanel() : null;
  const scrubs: number[] = [];
  const planets: Array<"earth" | "mars"> = [];
  let pauses = 0;
  let paused = false;
  let planet: "earth" | "mars" = "earth";
  const actions: SkyTouchActions = {
    scrubHours: (hours) => scrubs.push(hours),
    togglePause: () => {
      pauses++;
      paused = !paused;
      return paused;
    },
    togglePlanet: () => {
      planet = planet === "earth" ? "mars" : "earth";
      planets.push(planet);
      return planet;
    },
    // What the real scene reports: the planet it is on plus the clock state.
    currentState: () => ({ planet, paused }),
  };
  const writes = () => (panel ? BUTTON_IDS.reduce((sum, id) => sum + panel.el(id).writes, 0) : 0);
  return {
    panel,
    handle: attachSkyTouch(panel?.root ?? null, actions),
    scrubs,
    pauses: () => pauses,
    planets: () => planets,
    writes,
  };
}

afterEach(() => {
  useRealTimers();
});

group("sky touch panel - buttons are the keys' own actions", () => {
  test("sends each button's action, not its neighbour's", () => {
    const { panel, ...h } = harness();
    panel!.el("sk-pause").fire("click");
    panel!.el("sk-mars").fire("click");
    panel!.el("sk-time-back").fire("click");
    panel!.el("sk-time-fwd").fire("click");
    assert.equal(h.pauses(), 1);
    assert.deepEqual(h.planets(), ["mars"]);
    assert.deepEqual(h.scrubs, [-1, 1]);
  });

  test("runs a tap once — a touch tap is pointerdown + pointerup + click, not two actions", () => {
    const { panel, ...h } = harness();
    const pause = panel!.el("sk-pause");
    pause.fire("pointerdown", { pointerId: 7 });
    pause.fire("pointerup", { pointerId: 7 });
    pause.fire("click");
    assert.equal(h.pauses(), 1);
  });

  test("does not start a hold on a right-press, which is the orbit pan gesture", () => {
    useFakeTimers();
    const { panel, ...h } = harness();
    panel!.el("sk-time-fwd").fire("pointerdown", { pointerType: "mouse", button: 2 });
    advanceTimersByTime(HOLD_REPEAT_MS * 20);
    assert.deepEqual(h.scrubs, []);
  });
});

group("sky touch panel - holding the clock buttons", () => {
  test("repeats while held, applies the hold's own hour, and the release adds nothing", () => {
    useFakeTimers();
    const { panel, ...h } = harness();
    const fwd = panel!.el("sk-time-fwd");

    fwd.fire("pointerdown", { pointerId: 2 });
    advanceTimersByTime(HOLD_DELAY_MS - 1);
    assert.deepEqual(h.scrubs, []); // a press shorter than the delay is just a tap
    advanceTimersByTime(1);
    assert.deepEqual(h.scrubs, [1]); // the hold steps as soon as it starts repeating
    advanceTimersByTime(HOLD_REPEAT_MS * 5);
    assert.deepEqual(h.scrubs, [1, 1, 1, 1, 1, 1]);

    // The click that ends a hold already-took effect: it must not be counted as a second tap.
    fwd.fire("pointerup", { pointerId: 2 });
    fwd.fire("click");
    advanceTimersByTime(HOLD_REPEAT_MS * 10);
    assert.deepEqual(h.scrubs, [1, 1, 1, 1, 1, 1]);

    // …and the swallow must not outlive that press: the next tap on the other button still works.
    const back = panel!.el("sk-time-back");
    back.fire("pointerdown", { pointerId: 3 });
    back.fire("pointerup", { pointerId: 3 });
    back.fire("click");
    assert.deepEqual(h.scrubs, [1, 1, 1, 1, 1, 1, -1]);
  });

  test("stops repeating on dispose, when the scene (and its clock) is gone", () => {
    useFakeTimers();
    const { panel, handle, ...h } = harness();
    const fwd = panel!.el("sk-time-fwd");
    fwd.fire("pointerdown", { pointerId: 4 });
    advanceTimersByTime(HOLD_DELAY_MS);
    assert.deepEqual(h.scrubs, [1]);

    handle.dispose();
    advanceTimersByTime(HOLD_REPEAT_MS * 10);
    assert.deepEqual(h.scrubs, [1]);
    fwd.fire("click");
    assert.deepEqual(h.scrubs, [1]);
    assert.equal(fwd.listenerCount(), 0);
  });
});

group("sky touch panel - painting the scene's state", () => {
  test("marks Pause and Mars from the scene's state, and skips a state that did not change", () => {
    const { panel, handle, writes } = harness();
    handle.sync({ planet: "mars", paused: true });
    assert.equal(panel!.el("sk-mars").classes.has("active"), true);
    assert.equal(panel!.el("sk-mars").attrs.get("aria-pressed"), "true");
    assert.equal(panel!.el("sk-pause").classes.has("active"), true);
    assert.equal(panel!.el("sk-pause").attrs.get("aria-pressed"), "true");

    // `update()` calls this every frame; an unchanged state must not touch the DOM at all.
    const after = writes();
    handle.sync({ planet: "mars", paused: true });
    handle.sync({ planet: "mars", paused: true });
    assert.equal(writes(), after);

    // A change from elsewhere (a key, `window.__forge`) still repaints.
    handle.sync({ planet: "earth", paused: false });
    assert.equal(panel!.el("sk-mars").classes.has("active"), false);
    assert.equal(panel!.el("sk-mars").attrs.get("aria-pressed"), "false");
    assert.equal(panel!.el("sk-pause").classes.has("active"), false);
    assert.equal(panel!.el("sk-pause").attrs.get("aria-pressed"), "false");
    assert.ok(writes() > after);
  });

  test("paints a press immediately, without waiting for the next frame's sync()", () => {
    const { panel, ...h } = harness();
    panel!.el("sk-mars").fire("click");
    assert.equal(panel!.el("sk-mars").classes.has("active"), true);
    panel!.el("sk-pause").fire("click");
    assert.equal(panel!.el("sk-pause").attrs.get("aria-pressed"), "true");
    assert.deepEqual([h.pauses(), h.planets()], [1, ["mars"]]);

    // And the frame loop's sync is the authority once it runs (the keys can change the same state).
    h.handle.sync({ planet: "earth", paused: false });
    assert.equal(panel!.el("sk-mars").classes.has("active"), false);
    assert.equal(panel!.el("sk-pause").attrs.get("aria-pressed"), "false");
  });

  test("is a no-op without the markup (a renamed panel), and still disposes", () => {
    const { handle } = harness(false);
    assert.doesNotThrow(() => handle.sync({ planet: "earth", paused: false }));
    assert.doesNotThrow(() => handle.dispose());
  });
});

await finish();
