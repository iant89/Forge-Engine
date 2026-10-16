/**
 * Shared helpers for the UI suites: a manager at a known viewport, frame stepping, and pointer /
 * keyboard / gamepad input aimed at elements by their laid-out bounds (exactly what the DOM adapter
 * feeds the router, minus the DOM).
 */

import { UIManager, type Modifiers, type UIElement, type UIManagerOptions } from "@forge/engine";

export const NO_MODS: Modifiers = { shift: false, ctrl: false, alt: false, meta: false };

export function mods(m: Partial<Modifiers> = {}): Modifiers {
  return { ...NO_MODS, ...m };
}

export function makeUI(options: UIManagerOptions = {}): UIManager {
  return new UIManager({ width: 1280, height: 720, ...options });
}

/** Update + render one frame. */
export function frame(ui: UIManager, dt = 1 / 60): void {
  ui.update(dt);
  ui.render();
}

/** Run frames for `seconds` at 60 Hz. */
export function advance(ui: UIManager, seconds: number, dt = 1 / 60): void {
  const n = Math.max(1, Math.round(seconds / dt));
  for (let i = 0; i < n; i++) frame(ui, dt);
}

export function center(el: UIElement): { x: number; y: number } {
  const b = el.bounds;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** Move, press and release the mouse at `el`'s centre (or an offset from its top-left). */
export function click(ui: UIManager, el: UIElement, at?: { x: number; y: number }, pointerId = 1, type: "mouse" | "touch" | "pen" = "mouse"): void {
  const p = at ?? center(el);
  ui.router.pointerMove(p.x, p.y, pointerId, type);
  ui.router.pointerDown(p.x, p.y, pointerId, type, 0);
  ui.router.pointerUp(p.x, p.y, pointerId, type, 0);
  frame(ui);
}

/** Press, move in `steps`, release — a drag from `a` to `b`. */
export function drag(ui: UIManager, a: { x: number; y: number }, b: { x: number; y: number }, steps = 6, pointerId = 1, type: "mouse" | "touch" = "mouse"): void {
  ui.router.pointerMove(a.x, a.y, pointerId, type);
  ui.router.pointerDown(a.x, a.y, pointerId, type, 0);
  for (let i = 1; i <= steps; i++) ui.router.pointerMove(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps, pointerId, type);
  ui.router.pointerUp(b.x, b.y, pointerId, type, 0);
  frame(ui);
}

export function key(ui: UIManager, k: string, m: Partial<Modifiers> = {}): boolean {
  const consumed = ui.router.keyDown(k, k, mods(m));
  ui.router.keyUp(k, k, mods(m));
  frame(ui);
  return consumed;
}

export function type(ui: UIManager, text: string): void {
  for (const ch of text) ui.router.text(ch);
  frame(ui);
}

/** Debug names of the focus sequence (assert focus order readably). */
export function focusNames(ui: UIManager): string[] {
  return ui.focus.sequence().map((e) => e.name || e.debugName);
}
