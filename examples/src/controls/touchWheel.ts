/**
 * Touch steering wheel and pedals (fe-37c): shared examples input layer, usable by any driving demo.
 *
 * - `attachSteeringWheel(el)`: the finger grabs the wheel anywhere on it and rotates it about its
 *   centre (angle follows the finger, so hand-over-hand works). It is clamped to ±`maxAngle`
 *   (default 135°) and springs back to centre on release. `value()` is steer −1..1. Each wheel
 *   tracks only its own pointer, so other fingers stay free for the pedals (multi-touch).
 * - `attachPedal(el)`: hold to press. Pressure comes from how far down the pedal the finger sits
 *   (top 0.35 → bottom 1) and follows the finger while it is held.
 *
 * iOS Safari: pointer events with capture, `touch-action: none` in the CSS, and preventDefault on
 * pointerdown/move plus touchstart/touchmove (passive: false), so nothing scrolls, zooms or opens
 * the callout. Layout and styling belong to the demo.
 */

export interface TouchAxis {
  value(): number;
  dispose(): void;
}

function blockTouch(el: HTMLElement): Array<() => void> {
  const stop = (e: Event): void => {
    if (e.cancelable) e.preventDefault();
  };
  const types = ["touchstart", "touchmove", "touchend", "contextmenu", "gesturestart"];
  for (const t of types) el.addEventListener(t, stop, { passive: false });
  return types.map((t) => () => el.removeEventListener(t, stop));
}

export function attachSteeringWheel(el: HTMLElement | null, options: { maxAngle?: number; returnRate?: number; rim?: HTMLElement | null } = {}): TouchAxis {
  const max = ((options.maxAngle ?? 135) * Math.PI) / 180;
  const rate = options.returnRate ?? 10; // 1/s spring back
  let angle = 0;
  let pointer: number | null = null;
  let lastFinger = 0;
  let raf = 0;
  let lastT = 0;
  if (!el) return { value: () => 0, dispose: () => {} };
  const rim = options.rim ?? el;
  const draw = (): void => {
    rim.style.transform = `rotate(${angle}rad)`;
  };
  const fingerAngle = (e: PointerEvent): number => {
    const r = el.getBoundingClientRect();
    return Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2)));
  };
  const spring = (t: number): void => {
    const dt = lastT ? Math.min(0.05, (t - lastT) / 1000) : 0.016;
    lastT = t;
    angle *= Math.exp(-rate * dt);
    if (Math.abs(angle) < 0.002) angle = 0;
    draw();
    raf = angle !== 0 && pointer === null ? requestAnimationFrame(spring) : 0;
  };
  const down = (e: PointerEvent): void => {
    if (pointer !== null || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.preventDefault();
    pointer = e.pointerId;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* already gone */
    }
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    lastFinger = fingerAngle(e);
    el.classList.add("active");
  };
  const move = (e: PointerEvent): void => {
    if (e.pointerId !== pointer) return;
    e.preventDefault();
    const a = fingerAngle(e);
    let d = a - lastFinger;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    lastFinger = a;
    angle = Math.max(-max, Math.min(max, angle + d));
    draw();
  };
  const up = (e: PointerEvent): void => {
    if (e.pointerId !== pointer) return;
    pointer = null;
    el.classList.remove("active");
    lastT = 0;
    raf = requestAnimationFrame(spring);
  };
  el.addEventListener("pointerdown", down);
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
  el.addEventListener("lostpointercapture", up);
  const unblock = blockTouch(el);
  draw();
  return {
    value: () => angle / max,
    dispose: () => {
      if (raf) cancelAnimationFrame(raf);
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("lostpointercapture", up);
      for (const u of unblock) u();
    },
  };
}

export function attachPedal(el: HTMLElement | null): TouchAxis {
  let pointer: number | null = null;
  let amount = 0;
  if (!el) return { value: () => 0, dispose: () => {} };
  const press = (e: PointerEvent): void => {
    const r = el.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientY - r.top) / Math.max(1, r.height)));
    amount = 0.35 + 0.65 * t;
    el.style.setProperty("--press", amount.toFixed(2));
  };
  const down = (e: PointerEvent): void => {
    if (pointer !== null || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.preventDefault();
    pointer = e.pointerId;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* already gone */
    }
    el.classList.add("pressed");
    press(e);
  };
  const move = (e: PointerEvent): void => {
    if (e.pointerId !== pointer) return;
    e.preventDefault();
    press(e);
  };
  const up = (e: PointerEvent): void => {
    if (e.pointerId !== pointer) return;
    pointer = null;
    amount = 0;
    el.classList.remove("pressed");
    el.style.setProperty("--press", "0");
  };
  el.addEventListener("pointerdown", down);
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
  el.addEventListener("lostpointercapture", up);
  const unblock = blockTouch(el);
  return {
    value: () => amount,
    dispose: () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("lostpointercapture", up);
      for (const u of unblock) u();
    },
  };
}
