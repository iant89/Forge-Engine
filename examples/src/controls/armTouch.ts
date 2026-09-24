/**
 * On-screen thumbsticks for the Mars showcase's robotic arm.
 *
 * Two sticks appear once the arm has fully unfolded and hide the moment it starts to stow (the
 * scene drives `setVisible`). On touch / phone-sized layouts they sit above the drive stick and
 * the A–D pad (beside them on short landscape screens); on a desktop they take the bottom corners.
 *   left stick   X swings the arm (azimuth), Y raises / lowers the shoulder
 *   right stick  Y raises / lowers the elbow, X spins the instrument turret
 *
 * Each stick behaves like the drive stick in `vehicleTouch.ts` — same dead zone, pointer capture
 * and iOS selection / callout suppression, knob tracking the finger inside the ring — and tracks
 * its own pointer, so one thumb can drive while the other works the arm. Axes are −1..1 with
 * screen-up and screen-right positive; the scene adds the keyboard (T/G F/H, I/K J/L) and feeds
 * the sum to `RoverArmController`.
 */

import { stickDeflection, suppressTouchChrome } from "./vehicleTouch.js";

export interface ArmStickAxes {
  /** Left stick X: −1 swing left … +1 swing right. */
  swing: number;
  /** Left stick Y: +1 raise the shoulder … −1 lower it. */
  shoulder: number;
  /** Right stick Y: +1 raise the elbow … −1 lower it. */
  elbow: number;
  /** Right stick X: +1 spin the turret clockwise … −1 anticlockwise. */
  turret: number;
}

export interface ArmTouchHandle {
  sample(): ArmStickAxes;
  /** Show (arm unfolded) or hide the sticks. Hiding releases held sticks. Cheap to call every frame. */
  setVisible(visible: boolean): void;
  /** Whether the sticks are currently shown. */
  readonly visible: boolean;
  dispose(): void;
}

/** Ring radius minus this is the knob's travel: half the shared 44 px `.veh-knob`, as on the drive stick. */
const KNOB_INSET = 22;

interface ArmStick {
  x: number;
  y: number;
  /** End the gesture if `pointerId` is the one holding this stick (window-level fallback). */
  end(pointerId: number): void;
  release(): void;
}

export function attachArmTouch(root: HTMLElement | null): ArmTouchHandle {
  const listeners: Array<[HTMLElement, string, EventListener]> = [];
  let shown = false;

  const bind = (el: HTMLElement | null): ArmStick => {
    const knob = el?.querySelector<HTMLElement>(".veh-knob") ?? null;
    let pointer: number | null = null;
    // Declared before the early return below: `release` uses it even when the stick is missing.
    const place = (px: number, py: number, visible: boolean): void => {
      if (!knob) return;
      knob.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px))`;
      knob.classList.toggle("shown", visible);
    };
    const stick: ArmStick = {
      x: 0,
      y: 0,
      end(pointerId: number): void {
        if (pointerId === pointer) stick.release();
      },
      release(): void {
        pointer = null;
        stick.x = 0;
        stick.y = 0;
        el?.classList.remove("active");
        place(0, 0, false);
      },
    };
    if (!el) return stick;
    listeners.push(...suppressTouchChrome(el));
    const apply = (event: PointerEvent): void => {
      const rect = el.getBoundingClientRect();
      const def = stickDeflection(
        event.clientX - (rect.left + rect.width * 0.5),
        event.clientY - (rect.top + rect.height * 0.5),
        Math.max(8, rect.width * 0.5 - KNOB_INSET),
      );
      stick.x = def.x;
      // Screen +Y is down; the arm axes are up-positive (and a dead-zoned 0 stays +0, not −0).
      stick.y = def.y === 0 ? 0 : -def.y;
      place(def.px, def.py, true);
    };
    const onDown = (event: Event): void => {
      const e = event as PointerEvent;
      if (pointer !== null || !shown) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      pointer = e.pointerId;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* The pointer can already be gone on a flaky touchend; the window handler still resets. */
      }
      el.classList.add("active");
      apply(e);
    };
    const onMove = (event: Event): void => {
      const e = event as PointerEvent;
      if (e.pointerId !== pointer) return;
      e.preventDefault();
      apply(e);
    };
    const onEnd = (event: Event): void => {
      stick.end((event as PointerEvent).pointerId);
    };
    const pairs: Array<[string, EventListener]> = [
      ["pointerdown", onDown],
      ["pointermove", onMove],
      ["pointerup", onEnd],
      ["pointercancel", onEnd],
      ["lostpointercapture", onEnd],
    ];
    for (const [type, fn] of pairs) {
      el.addEventListener(type, fn);
      listeners.push([el, type, fn]);
    }
    return stick;
  };

  const left = bind(root?.querySelector<HTMLElement>("#arm-stick-left") ?? null);
  const right = bind(root?.querySelector<HTMLElement>("#arm-stick-right") ?? null);

  // Capture can fail when the browser already gave the gesture to the page: a window-level end
  // still resets a stick whose element never sees the terminal event.
  const view: Window | null = root?.ownerDocument?.defaultView ?? (typeof window !== "undefined" ? window : null);
  const onWindowEnd = (event: Event): void => {
    const id = (event as PointerEvent).pointerId;
    left.end(id);
    right.end(id);
  };
  if (view && typeof view.addEventListener === "function") {
    view.addEventListener("pointerup", onWindowEnd);
    view.addEventListener("pointercancel", onWindowEnd);
    listeners.push([view as unknown as HTMLElement, "pointerup", onWindowEnd], [view as unknown as HTMLElement, "pointercancel", onWindowEnd]);
  }

  const setVisible = (visible: boolean): void => {
    if (visible === shown) return;
    shown = visible;
    root?.classList.toggle("shown", visible);
    root?.setAttribute("aria-hidden", visible ? "false" : "true");
    if (!visible) {
      left.release();
      right.release();
    }
  };

  return {
    sample(): ArmStickAxes {
      return { swing: left.x, shoulder: left.y, elbow: right.y, turret: right.x };
    },
    setVisible,
    get visible(): boolean {
      return shown;
    },
    dispose(): void {
      for (const [el, type, fn] of listeners) el.removeEventListener(type, fn);
      listeners.length = 0;
      setVisible(false);
      left.release();
      right.release();
    },
  };
}
