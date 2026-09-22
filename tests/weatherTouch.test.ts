/**
 * Weather touch panel — the demo's controls for devices with no keyboard.
 *
 * The bug these pin: the panel is a *second* entrance to the actions the keys already own
 * (`1..4`, `L`, `U`, `[`/`]`, `T`), and every mistake that costs is a mismatch between the two —
 * an action that only the keys reach, a button that fires twice because a tap sends both
 * `pointerdown` and `click` (a double-toggled Dive is indistinguishable from a dead button), a
 * hold on `+1h` that drops the hour the tap would have applied, or a panel that repaints every
 * frame on a phone. The stub elements below stand in for the markup in `examples/index.html`;
 * `tests/orbitControls.test.ts` sets the precedent of a hand-rolled DOM over jsdom.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WeatherPresetName } from "@forge/engine";
import {
  attachWeatherTouch,
  HOLD_DELAY_MS,
  HOLD_REPEAT_MS,
  type WeatherTouchActions,
  type WeatherTouchHandle,
} from "../examples/src/controls/weatherTouch.js";

const BUTTON_IDS = [
  "wx-clear",
  "wx-overcast",
  "wx-rain",
  "wx-storm",
  "wx-strike",
  "wx-dive",
  "wx-time-back",
  "wx-time-fwd",
  "wx-pause",
] as const;

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
  handle: WeatherTouchHandle;
  weather: string[];
  scrubs: number[];
  strikes: () => number;
  dives: () => number;
  pauses: () => number;
  writes: () => number;
}

function harness(withPanel = true): Harness {
  const panel = withPanel ? stubPanel() : null;
  const weather: string[] = [];
  const scrubs: number[] = [];
  let strikes = 0;
  let dives = 0;
  let pauses = 0;
  let underwater = false;
  let paused = false;
  const actions: WeatherTouchActions = {
    setWeather: (preset) => weather.push(preset),
    triggerLightning: () => {
      strikes++;
    },
    toggleUnderwater: () => {
      dives++;
      underwater = !underwater;
      return underwater;
    },
    scrubHours: (hours) => scrubs.push(hours),
    togglePause: () => {
      pauses++;
      paused = !paused;
      return paused;
    },
    // What the real scene reports: the preset it last snapped to plus the two live states.
    currentState: () => ({ preset: (weather[weather.length - 1] ?? "overcast") as WeatherPresetName, underwater, paused }),
  };
  const writes = () =>
    panel ? BUTTON_IDS.reduce((sum, id) => sum + panel.el(id).writes, 0) : 0;
  return {
    panel,
    handle: attachWeatherTouch(panel?.root ?? null, actions),
    weather,
    scrubs,
    strikes: () => strikes,
    dives: () => dives,
    pauses: () => pauses,
    writes,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("weather touch panel - buttons are the keys' own actions", () => {
  it("sends each button's action, not its neighbour's", () => {
    const { panel, ...h } = harness();
    const presets: Array<[(typeof BUTTON_IDS)[number], string]> = [
      ["wx-clear", "clear"],
      ["wx-overcast", "overcast"],
      ["wx-rain", "rain"],
      ["wx-storm", "storm"],
    ];
    for (const [id] of presets) panel!.el(id).fire("click");
    expect(h.weather).toEqual(["clear", "overcast", "rain", "storm"]);

    panel!.el("wx-strike").fire("click");
    panel!.el("wx-dive").fire("click");
    panel!.el("wx-pause").fire("click");
    panel!.el("wx-time-back").fire("click");
    panel!.el("wx-time-fwd").fire("click");
    expect([h.strikes(), h.dives(), h.pauses()]).toEqual([1, 1, 1]);
    expect(h.scrubs).toEqual([-1, 1]);
  });

  it("runs a tap once — a touch tap is pointerdown + pointerup + click, not three actions", () => {
    const { panel, ...h } = harness();
    const dive = panel!.el("wx-dive");
    dive.fire("pointerdown", { pointerId: 7 });
    dive.fire("pointerup", { pointerId: 7 });
    dive.fire("click");
    expect(h.dives()).toBe(1);
  });

  it("does not start a hold on a right-press, which is the orbit pan gesture", () => {
    vi.useFakeTimers();
    const { panel, ...h } = harness();
    panel!.el("wx-time-fwd").fire("pointerdown", { pointerType: "mouse", button: 2 });
    vi.advanceTimersByTime(HOLD_REPEAT_MS * 20);
    expect(h.scrubs).toEqual([]);
  });
});

describe("weather touch panel - holding the clock buttons", () => {
  it("repeats while held, applies the hold's own hour, and the release adds nothing", () => {
    vi.useFakeTimers();
    const { panel, ...h } = harness();
    const fwd = panel!.el("wx-time-fwd");

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
    const back = panel!.el("wx-time-back");
    back.fire("pointerdown", { pointerId: 3 });
    back.fire("pointerup", { pointerId: 3 });
    back.fire("click");
    expect(h.scrubs).toEqual([1, 1, 1, 1, 1, 1, -1]);
  });

  it("stops repeating on dispose, when the scene (and its clock) is gone", () => {
    vi.useFakeTimers();
    const { panel, handle, ...h } = harness();
    const fwd = panel!.el("wx-time-fwd");
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

describe("weather touch panel - painting the scene's state", () => {
  it("marks the pressed preset and the two toggles, and skips a state that did not change", () => {
    const { panel, handle, writes } = harness();
    handle.sync({ preset: "storm", underwater: true, paused: false });
    expect(panel!.el("wx-storm").classes.has("active")).toBe(true);
    expect(panel!.el("wx-clear").classes.has("active")).toBe(false);
    expect(panel!.el("wx-rain").classes.has("active")).toBe(false);
    expect(panel!.el("wx-dive").attrs.get("aria-pressed")).toBe("true");
    expect(panel!.el("wx-pause").attrs.get("aria-pressed")).toBe("false");

    // `update()` calls this every frame; an unchanged state must not touch the DOM at all.
    const after = writes();
    handle.sync({ preset: "storm", underwater: true, paused: false });
    handle.sync({ preset: "storm", underwater: true, paused: false });
    expect(writes()).toBe(after);

    // A change from elsewhere (the keyboard, `window.__forge`) still repaints.
    handle.sync({ preset: "clear", underwater: false, paused: true });
    expect(panel!.el("wx-storm").classes.has("active")).toBe(false);
    expect(panel!.el("wx-clear").classes.has("active")).toBe(true);
    expect(panel!.el("wx-dive").attrs.get("aria-pressed")).toBe("false");
    expect(panel!.el("wx-pause").attrs.get("aria-pressed")).toBe("true");
    expect(writes()).toBeGreaterThan(after);
  });

  it("paints a press immediately, without waiting for the next frame's sync()", () => {
    const { panel, ...h } = harness();
    panel!.el("wx-storm").fire("click");
    expect(panel!.el("wx-storm").classes.has("active")).toBe(true);
    panel!.el("wx-rain").fire("click");
    expect(panel!.el("wx-rain").classes.has("active")).toBe(true);
    expect(panel!.el("wx-storm").classes.has("active")).toBe(false);

    panel!.el("wx-dive").fire("click");
    panel!.el("wx-pause").fire("click");
    expect(panel!.el("wx-dive").attrs.get("aria-pressed")).toBe("true");
    expect(panel!.el("wx-pause").attrs.get("aria-pressed")).toBe("true");
    expect([h.dives(), h.pauses()]).toEqual([1, 1]);

    // And the frame loop's sync is the authority once it runs (the keys can change the same state).
    h.handle.sync({ preset: "clear", underwater: false, paused: false });
    expect(panel!.el("wx-pause").attrs.get("aria-pressed")).toBe("false");
    expect(panel!.el("wx-clear").classes.has("active")).toBe(true);
  });

  it("is a no-op without the markup (desktop, or a renamed panel), and still disposes", () => {
    const { handle } = harness(false);
    expect(() => handle.sync({ preset: "clear", underwater: false, paused: false })).not.toThrow();
    expect(() => handle.dispose()).not.toThrow();
  });
});
