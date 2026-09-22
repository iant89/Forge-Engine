/**
 * Sky touch panel — the sky demo's controls, on every device.
 *
 * Same contract as the weather panel (see `tests/weatherTouch.test.ts`): the buttons are a second
 * entrance to the actions the keys already own (`[`/`]`, `T`, `M`), so every mistake that costs is
 * a mismatch between the two — an action only the keys reach, a button that fires twice because a
 * tap sends both `pointerdown` and `click` (a double-toggled Pause is indistinguishable from a dead
 * button), a hold on `+1h` that drops the hour the tap would have applied, or a panel that
 * repaints every frame. The stub elements stand in for the markup in `examples/index.html`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachSkyTouch,
  HOLD_DELAY_MS,
  HOLD_REPEAT_MS,
  type SkyTouchActions,
  type SkyTouchHandle,
} from "../examples/src/controls/skyTouch.js";

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
  vi.useRealTimers();
});

describe("sky touch panel - buttons are the keys' own actions", () => {
  it("sends each button's action, not its neighbour's", () => {
    const { panel, ...h } = harness();
    panel!.el("sk-pause").fire("click");
    panel!.el("sk-mars").fire("click");
    panel!.el("sk-time-back").fire("click");
    panel!.el("sk-time-fwd").fire("click");
    expect(h.pauses()).toBe(1);
    expect(h.planets()).toEqual(["mars"]);
    expect(h.scrubs).toEqual([-1, 1]);
  });

  it("runs a tap once — a touch tap is pointerdown + pointerup + click, not two actions", () => {
    const { panel, ...h } = harness();
    const pause = panel!.el("sk-pause");
    pause.fire("pointerdown", { pointerId: 7 });
    pause.fire("pointerup", { pointerId: 7 });
    pause.fire("click");
    expect(h.pauses()).toBe(1);
  });

  it("does not start a hold on a right-press, which is the orbit pan gesture", () => {
    vi.useFakeTimers();
    const { panel, ...h } = harness();
    panel!.el("sk-time-fwd").fire("pointerdown", { pointerType: "mouse", button: 2 });
    vi.advanceTimersByTime(HOLD_REPEAT_MS * 20);
    expect(h.scrubs).toEqual([]);
  });
});

describe("sky touch panel - holding the clock buttons", () => {
  it("repeats while held, applies the hold's own hour, and the release adds nothing", () => {
    vi.useFakeTimers();
    const { panel, ...h } = harness();
    const fwd = panel!.el("sk-time-fwd");

    fwd.fire("pointerdown", { pointerId: 2 });
    vi.advanceTimersByTime(HOLD_DELAY_MS - 1);
    expect(h.scrubs).toEqual([]); // a press shorter than the delay is just a tap
    vi.advanceTimersByTime(1);
    expect(h.scrubs).toEqual([1]); // the hold steps as soon as it starts repeating
    vi.advanceTimersByTime(HOLD_REPEAT_MS * 5);
    expect(h.scrubs).toEqual([1, 1, 1, 1, 1, 1]);

    // The click that ends a hold already-took effect: it must not be counted as a second tap.
    fwd.fire("pointerup", { pointerId: 2 });
    fwd.fire("click");
    vi.advanceTimersByTime(HOLD_REPEAT_MS * 10);
    expect(h.scrubs).toEqual([1, 1, 1, 1, 1, 1]);

    // …and the swallow must not outlive that press: the next tap on the other button still works.
    const back = panel!.el("sk-time-back");
    back.fire("pointerdown", { pointerId: 3 });
    back.fire("pointerup", { pointerId: 3 });
    back.fire("click");
    expect(h.scrubs).toEqual([1, 1, 1, 1, 1, 1, -1]);
  });

  it("stops repeating on dispose, when the scene (and its clock) is gone", () => {
    vi.useFakeTimers();
    const { panel, handle, ...h } = harness();
    const fwd = panel!.el("sk-time-fwd");
    fwd.fire("pointerdown", { pointerId: 4 });
    vi.advanceTimersByTime(HOLD_DELAY_MS);
    expect(h.scrubs).toEqual([1]);

    handle.dispose();
    vi.advanceTimersByTime(HOLD_REPEAT_MS * 10);
    expect(h.scrubs).toEqual([1]);
    fwd.fire("click");
    expect(h.scrubs).toEqual([1]);
    expect(fwd.listenerCount()).toBe(0);
  });
});

describe("sky touch panel - painting the scene's state", () => {
  it("marks Pause and Mars from the scene's state, and skips a state that did not change", () => {
    const { panel, handle, writes } = harness();
    handle.sync({ planet: "mars", paused: true });
    expect(panel!.el("sk-mars").classes.has("active")).toBe(true);
    expect(panel!.el("sk-mars").attrs.get("aria-pressed")).toBe("true");
    expect(panel!.el("sk-pause").classes.has("active")).toBe(true);
    expect(panel!.el("sk-pause").attrs.get("aria-pressed")).toBe("true");

    // `update()` calls this every frame; an unchanged state must not touch the DOM at all.
    const after = writes();
    handle.sync({ planet: "mars", paused: true });
    handle.sync({ planet: "mars", paused: true });
    expect(writes()).toBe(after);

    // A change from elsewhere (a key, `window.__forge`) still repaints.
    handle.sync({ planet: "earth", paused: false });
    expect(panel!.el("sk-mars").classes.has("active")).toBe(false);
    expect(panel!.el("sk-mars").attrs.get("aria-pressed")).toBe("false");
    expect(panel!.el("sk-pause").classes.has("active")).toBe(false);
    expect(panel!.el("sk-pause").attrs.get("aria-pressed")).toBe("false");
    expect(writes()).toBeGreaterThan(after);
  });

  it("paints a press immediately, without waiting for the next frame's sync()", () => {
    const { panel, ...h } = harness();
    panel!.el("sk-mars").fire("click");
    expect(panel!.el("sk-mars").classes.has("active")).toBe(true);
    panel!.el("sk-pause").fire("click");
    expect(panel!.el("sk-pause").attrs.get("aria-pressed")).toBe("true");
    expect([h.pauses(), h.planets()]).toEqual([1, ["mars"]]);

    // And the frame loop's sync is the authority once it runs (the keys can change the same state).
    h.handle.sync({ planet: "earth", paused: false });
    expect(panel!.el("sk-mars").classes.has("active")).toBe(false);
    expect(panel!.el("sk-pause").attrs.get("aria-pressed")).toBe("false");
  });

  it("is a no-op without the markup (a renamed panel), and still disposes", () => {
    const { handle } = harness(false);
    expect(() => handle.sync({ planet: "earth", paused: false })).not.toThrow();
    expect(() => handle.dispose()).not.toThrow();
  });
});
