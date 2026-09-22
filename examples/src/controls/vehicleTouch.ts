/**
 * On-screen drive controls for the vehicle playground.
 *
 * A fixed translucent stick sits in the bottom-left. Its knob is hidden until a finger lands, then
 * tracks that finger and stays inside the circle. Horizontal deflection is steer; up is throttle and
 * down is brake, so the stick works on its own. The A/B pair on the bottom-right is the digital
 * version of the same two axes (gas / brake). Keyboard input is combined by the scene, not here.
 */

export interface VehicleTouchAxes {
  /** -1 left, +1 right. */
  steer: number;
  /** 0..1, from the stick pushed up or the gas button. */
  throttle: number;
  /** 0..1, from the stick pulled down or the brake button. */
  brake: number;
}

export interface VehicleTouchHandle {
  sample(): VehicleTouchAxes;
  dispose(): void;
}

const DEADZONE = 0.14;

/** Clamp a pointer offset to the stick and return axes in -1..1. Screen +Y is down. */
export function stickDeflection(dx: number, dy: number, radius: number): { x: number; y: number; px: number; py: number } {
  if (!(radius > 0)) return { x: 0, y: 0, px: 0, py: 0 };
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return { x: 0, y: 0, px: 0, py: 0 };
  const scale = Math.min(1, radius / dist);
  const px = dx * scale;
  const py = dy * scale;
  let x = px / radius;
  let y = py / radius;
  if (Math.abs(x) < DEADZONE) x = 0;
  if (Math.abs(y) < DEADZONE) y = 0;
  return { x, y, px, py };
}

export function attachVehicleTouch(root: HTMLElement | null): VehicleTouchHandle {
  const stick = root?.querySelector<HTMLElement>("#veh-stick") ?? null;
  const knob = root?.querySelector<HTMLElement>("#veh-stick-knob") ?? null;
  const gas = root?.querySelector<HTMLElement>("#veh-gas") ?? null;
  const brake = root?.querySelector<HTMLElement>("#veh-brake") ?? null;

  let steer = 0;
  let stickThrottle = 0;
  let stickBrake = 0;
  let gasHeld = false;
  let brakeHeld = false;
  let stickPointer: number | null = null;

  const placeKnob = (px: number, py: number, visible: boolean): void => {
    if (!knob) return;
    knob.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px))`;
    knob.classList.toggle("shown", visible);
  };

  const applyStick = (event: PointerEvent): void => {
    if (!stick) return;
    const rect = stick.getBoundingClientRect();
    const radius = rect.width * 0.5 - 22;
    const dx = event.clientX - (rect.left + rect.width * 0.5);
    const dy = event.clientY - (rect.top + rect.height * 0.5);
    const def = stickDeflection(dx, dy, Math.max(8, radius));
    steer = def.x;
    // Screen +Y is down, so a finger above the centre is negative dy and positive throttle.
    stickThrottle = Math.max(0, -def.y);
    stickBrake = Math.max(0, def.y);
    placeKnob(def.px, def.py, true);
  };

  const endStick = (event: PointerEvent): void => {
    if (event.pointerId !== stickPointer) return;
    stickPointer = null;
    steer = 0;
    stickThrottle = 0;
    stickBrake = 0;
    stick?.classList.remove("active");
    placeKnob(0, 0, false);
  };

  const onStickDown = (event: PointerEvent): void => {
    if (stickPointer !== null) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    stickPointer = event.pointerId;
    try {
      stick?.setPointerCapture(event.pointerId);
    } catch {
      /* The pointer can already be gone on a flaky touchend. The window up handler still resets. */
    }
    stick?.classList.add("active");
    applyStick(event);
  };
  const onStickMove = (event: PointerEvent): void => {
    if (event.pointerId !== stickPointer) return;
    event.preventDefault();
    applyStick(event);
  };

  const hold = (el: HTMLElement | null, set: (down: boolean) => void): Array<[HTMLElement, string, EventListener]> => {
    if (!el) return [];
    const down = (event: Event): void => {
      const e = event as PointerEvent;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* Released before capture. pointerup on the element may not arrive; window up covers the stick. */
      }
      el.classList.add("pressed");
      set(true);
    };
    const up = (event: Event): void => {
      const e = event as PointerEvent;
      el.classList.remove("pressed");
      set(false);
      void e;
    };
    const pairs: Array<[string, EventListener]> = [
      ["pointerdown", down],
      ["pointerup", up],
      ["pointercancel", up],
    ];
    for (const [type, fn] of pairs) el.addEventListener(type, fn);
    return pairs.map(([type, fn]) => [el, type, fn]);
  };

  const listeners: Array<[HTMLElement, string, EventListener]> = [
    ...hold(gas, (down) => {
      gasHeld = down;
    }),
    ...hold(brake, (down) => {
      brakeHeld = down;
    }),
  ];
  if (stick) {
    const pairs: Array<[string, EventListener]> = [
      ["pointerdown", onStickDown as EventListener],
      ["pointermove", onStickMove as EventListener],
      ["pointerup", endStick as EventListener],
      ["pointercancel", endStick as EventListener],
    ];
    for (const [type, fn] of pairs) {
      stick.addEventListener(type, fn);
      listeners.push([stick, type, fn]);
    }
  }
  // Capture can fail on a browser that already gave the gesture to the page. A window-level up
  // still recentres the knob if this was our pointer.
  const onWindowUp = (event: Event): void => endStick(event as PointerEvent);
  window.addEventListener("pointerup", onWindowUp);
  window.addEventListener("pointercancel", onWindowUp);
  listeners.push([window as unknown as HTMLElement, "pointerup", onWindowUp], [window as unknown as HTMLElement, "pointercancel", onWindowUp]);

  return {
    sample(): VehicleTouchAxes {
      return {
        steer,
        throttle: Math.max(stickThrottle, gasHeld ? 1 : 0),
        brake: Math.max(stickBrake, brakeHeld ? 1 : 0),
      };
    },
    dispose(): void {
      for (const [el, type, fn] of listeners) el.removeEventListener(type, fn);
      gas?.classList.remove("pressed");
      brake?.classList.remove("pressed");
      stick?.classList.remove("active");
      placeKnob(0, 0, false);
      steer = 0;
      stickThrottle = 0;
      stickBrake = 0;
      gasHeld = false;
      brakeHeld = false;
      stickPointer = null;
    },
  };
}
