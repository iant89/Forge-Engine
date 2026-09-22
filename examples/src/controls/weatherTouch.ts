/**
 * On-screen weather controls for the weather demo.
 *
 * The scene's shortcuts are keys — `1..4` presets, `L` a strike, `U` the flooded camera, `[`/`]` the
 * clock, `T` pause — and a phone has no keyboard. This binds the panel in `examples/index.html` to
 * the *same* callbacks the keys call, so the two inputs cannot drift: the scene owns the actions,
 * the panel only names them.
 *
 * Actions run on `click`, never on `pointerdown`. A tap produces both, and for `Dive`/`Pause` (and
 * for a re-tapped preset) running the action twice is a no-op that reads as a dead button. `click`
 * is also what Enter/Space on a focused button sends, so the keyboard path works too. The clock
 * buttons *hold*: a press that outlives `HOLD_DELAY_MS` starts stepping like a held-down key, and
 * the `click` that ends that press is swallowed — the total is the hours the user asked for.
 *
 * Visibility is CSS, not this module: `body.scene-weather` plus a coarse pointer or a phone-sized
 * viewport (see `examples/index.html`). Wiring a hidden panel is harmless, and a missing one is not
 * an error either, which is what lets a stub root drive this in the unit tests.
 */

import type { WeatherPresetName } from "@forge/engine";

/** The scene actions the buttons stand in for. Each one is a keyboard shortcut's own path. */
export interface WeatherTouchActions {
  /** `1..4` — snap and hold a preset. */
  setWeather(preset: WeatherPresetName): void;
  /** `L` — schedule a strike now. */
  triggerLightning(): void;
  /** `U` — flood/drain the lake over the camera; returns the new value. */
  toggleUnderwater(): boolean;
  /** `[` / `]` — scrub the day/night clock by `hours` (negative goes back). */
  scrubHours(hours: number): void;
  /** `T` — pause/resume the clock; returns true when the clock is now paused. */
  togglePause(): boolean;
  /**
   * The scene's current panel state. Read once after every action, so a press repaints itself then
   * instead of waiting for the next frame: the frame loop is not guaranteed to be running (the
   * browser gate freezes it to compare pixels), and a press that never paints reads as a dead button.
   */
  currentState(): WeatherTouchState;
}

/** What the panel paints: the scene's current preset, flood state and clock state. */
export interface WeatherTouchState {
  preset: WeatherPresetName;
  underwater: boolean;
  paused: boolean;
}

export interface WeatherTouchHandle {
  /** Repaint the pressed buttons. Safe to call every frame; an unchanged state writes nothing. */
  sync(state: WeatherTouchState): void;
  dispose(): void;
}

/** A press longer than this starts the clock repeat (a keyboard's own repeat delay is ~500 ms). */
export const HOLD_DELAY_MS = 400;
/** Period once the hold started. 10 hours per second of holding the button down. */
export const HOLD_REPEAT_MS = 100;

/** The panel's buttons by id, in the order they appear in `examples/index.html`. */
const PRESET_BUTTONS: ReadonlyArray<readonly [string, WeatherPresetName]> = [
  ["#wx-clear", "clear"],
  ["#wx-overcast", "overcast"],
  ["#wx-rain", "rain"],
  ["#wx-storm", "storm"],
];
const STRIKE_BUTTON = "#wx-strike";
const DIVE_BUTTON = "#wx-dive";
const PAUSE_BUTTON = "#wx-pause";
const CLOCK_BUTTONS: ReadonlyArray<readonly [string, number]> = [
  ["#wx-time-back", -1],
  ["#wx-time-fwd", 1],
];

export function attachWeatherTouch(root: HTMLElement | null, actions: WeatherTouchActions): WeatherTouchHandle {
  const find = (selector: string): HTMLElement | null => root?.querySelector<HTMLElement>(selector) ?? null;

  const bound: Array<[EventTarget, string, EventListener]> = [];
  const on = (el: EventTarget | null, type: string, fn: EventListener): void => {
    if (!el) return;
    el.addEventListener(type, fn);
    bound.push([el, type, fn]);
  };
  const asPointer = (event: Event): PointerEvent => event as PointerEvent;

  // ---------------------------------------------------------------- painting
  const dive = find(DIVE_BUTTON);
  const pause = find(PAUSE_BUTTON);
  const presetButtons: Array<[HTMLElement, WeatherPresetName]> = [];
  for (const [selector, preset] of PRESET_BUTTONS) {
    const el = find(selector);
    if (el) presetButtons.push([el, preset]);
  }

  // The last painted state: the scene calls `sync` every frame, and a frame that changed nothing
  // must not touch the DOM (nor, on a phone, force a style recalculation).
  let lastPreset: WeatherPresetName | null = null;
  let lastUnderwater: boolean | null = null;
  let lastPaused: boolean | null = null;

  const setPressed = (el: HTMLElement | null, pressed: boolean): void => {
    if (!el) return;
    el.classList.toggle("active", pressed);
    el.setAttribute("aria-pressed", pressed ? "true" : "false");
  };
  const paint = (state: WeatherTouchState): void => {
    if (state.preset === lastPreset && state.underwater === lastUnderwater && state.paused === lastPaused) return;
    lastPreset = state.preset;
    lastUnderwater = state.underwater;
    lastPaused = state.paused;
    for (const [el, preset] of presetButtons) el.classList.toggle("active", preset === state.preset);
    setPressed(dive, state.underwater);
    setPressed(pause, state.paused);
  };
  /** Run an action, then paint the state it produced (the next frame may be a long way off). */
  const run = (action: () => void): void => {
    action();
    paint(actions.currentState());
  };

  // ---------------------------------------------------------------- holding the clock buttons
  let holdPointer: number | null = null;
  let holdFired = false;
  let suppressClick = false;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let repeatTimer: ReturnType<typeof setInterval> | null = null;

  const stopRepeat = (): void => {
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    if (repeatTimer !== null) {
      clearInterval(repeatTimer);
      repeatTimer = null;
    }
  };

  // The window a real element lives in; null for a stub root (an element's own pointerup handlers
  // are the primary path — this only catches a pointer that escaped the button when the browser
  // refused the capture).
  const view: Window | null = root?.ownerDocument?.defaultView ?? null;
  const endHold = (event: Event): void => {
    const pointer = asPointer(event);
    if (holdPointer !== null && pointer.pointerId !== holdPointer) return;
    holdPointer = null;
    const held = holdFired;
    stopRepeat();
    holdFired = false;
    // A press that already repeated did its work: the click it ends with must not add a tap.
    if (held) suppressClick = true;
  };

  /**
   * A clock button: `click` steps one hour, a held press steps one per `HOLD_REPEAT_MS` after
   * `HOLD_DELAY_MS` — the press-then-repeat a keyboard does for `[` and `]`.
   */
  const bindClock = (el: HTMLElement | null, hours: number): void => {
    if (!el) return;
    on(el, "click", (event) => {
      if (suppressClick) {
        suppressClick = false;
        event.preventDefault();
        return;
      }
      run(() => actions.scrubHours(hours));
    });
    on(el, "pointerdown", (event) => {
      const pointer = asPointer(event);
      if (pointer.pointerType === "mouse" && pointer.button !== 0) return;
      if (holdPointer !== null) return; // one hold at a time; a second finger is not a repeat
      holdPointer = pointer.pointerId;
      holdFired = false;
      suppressClick = false;
      stopRepeat();
      try {
        el.setPointerCapture(pointer.pointerId);
      } catch {
        // Capture can be refused; the pointerup handlers below (and the window's) still end the hold.
      }
      holdTimer = setTimeout(() => {
        holdTimer = null;
        holdFired = true;
        run(() => actions.scrubHours(hours)); // the hold's first hour, then one per repeat
        repeatTimer = setInterval(() => run(() => actions.scrubHours(hours)), HOLD_REPEAT_MS);
      }, HOLD_DELAY_MS);
    });
    on(el, "pointerup", endHold);
    on(el, "pointercancel", endHold);
    on(el, "lostpointercapture", endHold);
  };

  // ---------------------------------------------------------------- bindings
  for (const [el, preset] of presetButtons) on(el, "click", () => run(() => actions.setWeather(preset)));
  // A strike changes nothing the panel paints, so it has no repaint of its own.
  on(find(STRIKE_BUTTON), "click", () => actions.triggerLightning());
  on(dive, "click", () => run(() => actions.toggleUnderwater()));
  on(pause, "click", () => run(() => actions.togglePause()));
  for (const [selector, hours] of CLOCK_BUTTONS) bindClock(find(selector), hours);
  on(view, "pointerup", endHold);
  on(view, "pointercancel", endHold);

  return {
    sync(state: WeatherTouchState): void {
      paint(state);
    },
    dispose(): void {
      stopRepeat();
      for (const [el, type, fn] of bound) el.removeEventListener(type, fn);
      bound.length = 0;
      presetButtons.length = 0;
      dive?.classList.remove("active");
      pause?.classList.remove("active");
      holdPointer = null;
      holdFired = false;
      suppressClick = false;
      lastPreset = null;
      lastUnderwater = null;
      lastPaused = null;
    },
  };
}
