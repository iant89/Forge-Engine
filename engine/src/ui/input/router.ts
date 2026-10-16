/**
 * `InputRouter` — turns device input into UI events.
 *
 * The router is device-independent: something calls `pointerDown/Move/Up/Cancel`, `wheel`, `keyDown/
 * keyUp`, `text`, `gamepadButton`, `gamepadAxis` with positions in **logical units** (the DOM adapter in
 * `domAdapter.ts` does this for the browser; tests call it directly). Every method returns whether the
 * UI consumed the input, so a game can ignore clicks and keys the UI handled.
 *
 * Pointer semantics (each pinned by `tests/ui/uiInput.test.ts`):
 *  * **Implicit capture**: the element that received `pointerdown` receives that pointer's moves and
 *    its `pointerup`, wherever the pointer goes. `releaseCapture(pointerId)` ends it early.
 *  * **Click** = down and up on the same captured element with the pointer still inside it (press
 *    inside + release outside is not a click; a drag is not a click). A second click within
 *    `doubleClickTime` and `doubleClickDistance` has `clickCount 2` and also fires `dblclick`.
 *  * **Pressed state** follows the pointer: it is on while the captured pointer is inside the target.
 *  * **Disabled targets** receive nothing, but still block what is underneath (no click-through).
 *  * **Hover** sets the `hovered` state on the hit element and its ancestors, with non-bubbling
 *    `pointerenter`/`pointerleave` for the elements entered/left. Touch hovers only while pressed.
 *  * **Drag & drop**: moving a pressed pointer beyond `dragThreshold` fires `dragstart` at the source;
 *    if a listener sets `event.payload`, elements under the pointer get `dragenter`/`dragover`/
 *    `dragleave` and the release fires `drop` (then `dragend` at the source).
 *  * **One pointer stream**: there is no separate mouse and touch path, so a tap cannot click twice.
 *  * **Disposal mid-gesture**: if the captured element is disposed or detached, the gesture is
 *    cancelled silently; nothing dispatches to a dead element.
 *
 * Keyboard and gamepad go to the focused element (or the top modal, or the root): `navigate`,
 * `activate` and `cancel` events carry the default actions (move focus / press / close), which a
 * listener can `preventDefault` — a slider consumes left/right this way. Held d-pad/stick directions
 * repeat after `repeatDelay` every `repeatInterval` seconds, driven by `update(dt)`.
 */

import type { UIElement } from "../core/element.js";
import { UIState } from "../style/types.js";
import type { FocusManager } from "./focus.js";
import {
  NO_MODIFIERS,
  UIActionEvent,
  UIDragEvent,
  UIKeyEvent,
  UINavigateEvent,
  UIPointerEvent,
  UITextEvent,
  UIWheelEvent,
  type Modifiers,
  type NavigationDirection,
  type PointerType,
  type UIEvent,
} from "./events.js";

export interface RouterHost {
  readonly root: UIElement;
  readonly topModal: UIElement | null;
  readonly focus: FocusManager;
  /** Topmost element under a point, after modal blocking. */
  hitTest(x: number, y: number): UIElement | null;
  dispatch(event: UIEvent, target: UIElement): boolean;
  /** Before a press is routed (light-dismiss of popups). */
  beforePointerDown?(x: number, y: number, hit: UIElement | null): void;
  /** Current UI time in seconds. */
  readonly time: number;
}

export type GamepadButton = "a" | "b" | "x" | "y" | "up" | "down" | "left" | "right" | "lb" | "rb" | "start" | "select";

interface PointerState {
  id: number;
  type: PointerType;
  x: number;
  y: number;
  button: number;
  capture: UIElement | null;
  downX: number;
  downY: number;
  pressed: boolean;
  inside: boolean;
  dragging: boolean;
  payload: unknown;
  dropTarget: UIElement | null;
}

export interface InputTraceEntry {
  time: number;
  input: string;
  target: string | null;
  consumed: boolean;
}

export class InputRouter {
  private readonly pointers = new Map<number, PointerState>();
  private hoverChain: UIElement[] = [];
  private lastClick: { target: UIElement; time: number; x: number; y: number; count: number } | null = null;
  doubleClickTime = 0.4;
  doubleClickDistance = 6;
  dragThreshold = 4;
  touchDragThreshold = 8;
  repeatDelay = 0.45;
  repeatInterval = 0.12;
  axisDeadZone = 0.5;
  private held: { dir: NavigationDirection; source: "gamepad"; time: number; next: number } | null = null;
  private axisDir: NavigationDirection | null = null;
  /** Ring buffer of recent inputs when `traceEnabled`. */
  traceEnabled = false;
  readonly trace: InputTraceEntry[] = [];
  traceCapacity = 256;
  readonly stats = { hitTests: 0, events: 0 };

  constructor(private readonly host: RouterHost) {}

  // ------------------------------------------------------------------ helpers

  private record(input: string, target: UIElement | null, consumed: boolean): boolean {
    if (this.traceEnabled) {
      this.trace.push({ time: this.host.time, input, target: target?.debugName ?? null, consumed });
      if (this.trace.length > this.traceCapacity) this.trace.splice(0, this.trace.length - this.traceCapacity);
    }
    return consumed;
  }

  private send(event: UIEvent, target: UIElement): boolean {
    this.stats.events++;
    return this.host.dispatch(event, target);
  }

  private hit(x: number, y: number): UIElement | null {
    this.stats.hitTests++;
    return this.host.hitTest(x, y);
  }

  private live(el: UIElement | null): el is UIElement {
    return el !== null && !el.disposed && el.attached;
  }

  /** The topmost element at a point (no events, no hover change). */
  hitTestAt(x: number, y: number): UIElement | null {
    return this.hit(x, y);
  }

  /** The element that currently captures `pointerId`, if any. */
  captureOf(pointerId: number): UIElement | null {
    return this.pointers.get(pointerId)?.capture ?? null;
  }

  /** Stop delivering this pointer to its capture target (no click on release). */
  releaseCapture(pointerId: number): void {
    const p = this.pointers.get(pointerId);
    if (!p?.capture) return;
    p.capture.setStateBit(UIState.Pressed, false);
    p.capture = null;
  }

  /** Redirect a pressed pointer to `el` (scroll views taking over a drag from a button). */
  setCapture(pointerId: number, el: UIElement): void {
    const p = this.pointers.get(pointerId);
    if (!p || !p.pressed) return;
    if (p.capture && p.capture !== el) p.capture.setStateBit(UIState.Pressed, false);
    p.capture = el;
  }

  get hovered(): UIElement | null {
    return this.hoverChain[0] ?? null;
  }

  /** True when any pointer is pressed over the UI. */
  get busy(): boolean {
    for (const p of this.pointers.values()) if (p.pressed && p.capture) return true;
    return false;
  }

  // ------------------------------------------------------------------ hover

  private updateHover(target: UIElement | null, p: PointerState | null): void {
    const chain: UIElement[] = [];
    for (let e = target; e; e = e.parent) chain.push(e);
    const old = this.hoverChain;
    for (const e of old) {
      if (chain.includes(e)) continue;
      e.setStateBit(UIState.Hovered, false);
      if (this.live(e) && p) this.send(this.pointerEvent("pointerleave", p, false), e);
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      const e = chain[i]!;
      if (old.includes(e)) continue;
      e.setStateBit(UIState.Hovered, true);
      if (p && this.live(e)) this.send(this.pointerEvent("pointerenter", p, false), e);
    }
    this.hoverChain = chain;
  }

  private pointerEvent(type: string, p: PointerState, bubbles = true, clickCount = 0, mods: Readonly<Modifiers> = NO_MODIFIERS): UIPointerEvent {
    return new UIPointerEvent(type, p.x, p.y, p.id, p.type, p.button, mods, clickCount, p.x - p.downX, p.y - p.downY, bubbles);
  }

  private dragEvent(type: string, p: PointerState, bubbles = true): UIDragEvent {
    const e = new UIDragEvent(type, p.x, p.y, p.id, p.type, p.button, NO_MODIFIERS, 0, p.x - p.downX, p.y - p.downY, bubbles);
    e.payload = p.payload;
    return e;
  }

  // ------------------------------------------------------------------ pointer

  pointerMove(x: number, y: number, pointerId = 0, type: PointerType = "mouse", mods: Readonly<Modifiers> = NO_MODIFIERS): boolean {
    let p = this.pointers.get(pointerId);
    if (!p) {
      p = { id: pointerId, type, x, y, button: -1, capture: null, downX: x, downY: y, pressed: false, inside: false, dragging: false, payload: null, dropTarget: null };
      this.pointers.set(pointerId, p);
    }
    p.x = x;
    p.y = y;
    const hit = this.hit(x, y);
    if (type !== "touch" || p.pressed) this.updateHover(hit, p);
    const cap = p.capture;
    if (p.pressed && cap) {
      if (!this.live(cap)) {
        this.endGesture(p);
        return this.record("pointermove", null, false);
      }
      const inside = cap === hit || (hit !== null && cap.isAncestorOf(hit));
      if (inside !== p.inside) {
        p.inside = inside;
        cap.setStateBit(UIState.Pressed, inside);
      }
      const threshold = type === "touch" ? this.touchDragThreshold : this.dragThreshold;
      if (!p.dragging && Math.hypot(x - p.downX, y - p.downY) > threshold) {
        p.dragging = true;
        const start = this.dragEvent("dragstart", p);
        this.send(start, cap);
        p.payload = start.payload;
      }
      this.send(this.pointerEvent("pointermove", p, true, 0, mods), cap);
      if (p.dragging && this.live(p.capture)) {
        this.send(this.dragEvent("drag", p), p.capture);
        if (p.payload !== null) this.updateDropTarget(p, hit);
      }
      return this.record("pointermove", cap, true);
    }
    if (hit && hit.effectivelyEnabled) this.send(this.pointerEvent("pointermove", p, true, 0, mods), hit);
    return this.record("pointermove", hit, hit !== null);
  }

  private updateDropTarget(p: PointerState, hit: UIElement | null): void {
    const target = hit && hit.effectivelyEnabled ? hit : null;
    if (target !== p.dropTarget) {
      if (this.live(p.dropTarget)) this.send(this.dragEvent("dragleave", p), p.dropTarget);
      p.dropTarget = target;
      if (target) this.send(this.dragEvent("dragenter", p), target);
    }
    if (target) this.send(this.dragEvent("dragover", p), target);
  }

  pointerDown(x: number, y: number, pointerId = 0, type: PointerType = "mouse", button = 0, mods: Readonly<Modifiers> = NO_MODIFIERS): boolean {
    let p = this.pointers.get(pointerId);
    if (!p) {
      p = { id: pointerId, type, x, y, button, capture: null, downX: x, downY: y, pressed: false, inside: false, dragging: false, payload: null, dropTarget: null };
      this.pointers.set(pointerId, p);
    }
    if (p.pressed) this.endGesture(p);
    p.type = type;
    p.x = p.downX = x;
    p.y = p.downY = y;
    p.button = button;
    p.dragging = false;
    p.payload = null;
    p.dropTarget = null;
    let hit = this.hit(x, y);
    this.host.beforePointerDown?.(x, y, hit);
    // The light-dismiss hook may have closed what was under the pointer.
    if (hit && !this.live(hit)) hit = this.hit(x, y);
    this.updateHover(hit, p);
    if (!hit) return this.record("pointerdown", null, false);
    p.pressed = true;
    if (!hit.effectivelyEnabled) {
      // Blocks click-through; delivers nothing.
      p.capture = null;
      return this.record("pointerdown", hit, true);
    }
    p.capture = hit;
    p.inside = true;
    hit.setStateBit(UIState.Pressed, true);
    const ev = this.pointerEvent("pointerdown", p, true, 0, mods);
    this.send(ev, hit);
    if (!ev.defaultPrevented) {
      let focusable: UIElement | null = null;
      for (let e: UIElement | null = hit; e; e = e.parent) {
        if (e.focusable) {
          focusable = e;
          break;
        }
      }
      if (focusable && focusable.canFocus) this.host.focus.focus(focusable, false);
      else if (!focusable) this.host.focus.blur();
    }
    if (button === 2 && this.live(hit)) this.send(this.pointerEvent("contextmenu", p, true, 0, mods), hit);
    return this.record("pointerdown", hit, true);
  }

  pointerUp(x: number, y: number, pointerId = 0, type: PointerType = "mouse", button = 0, mods: Readonly<Modifiers> = NO_MODIFIERS): boolean {
    const p = this.pointers.get(pointerId);
    if (!p || !p.pressed) return this.record("pointerup", null, this.hit(x, y) !== null);
    p.x = x;
    p.y = y;
    p.button = button;
    const cap = p.capture;
    const hit = this.hit(x, y);
    p.pressed = false;
    if (!this.live(cap)) {
      this.endGesture(p);
      if (type === "touch") this.updateHover(null, p);
      return this.record("pointerup", hit, hit !== null);
    }
    cap.setStateBit(UIState.Pressed, false);
    this.send(this.pointerEvent("pointerup", p, true, 0, mods), cap);
    if (p.dragging) {
      if (p.payload !== null && this.live(p.dropTarget) && hit === p.dropTarget) this.send(this.dragEvent("drop", p), p.dropTarget);
      else if (this.live(p.dropTarget)) this.send(this.dragEvent("dragleave", p), p.dropTarget);
      if (this.live(cap)) this.send(this.dragEvent("dragend", p), cap);
    } else if (this.live(cap) && hit !== null && (hit === cap || cap.isAncestorOf(hit)) && cap.effectivelyEnabled) {
      const now = this.host.time;
      const last = this.lastClick;
      let count = 1;
      if (last && last.target === cap && now - last.time <= this.doubleClickTime && Math.hypot(x - last.x, y - last.y) <= this.doubleClickDistance) count = last.count + 1;
      this.lastClick = { target: cap, time: now, x, y, count };
      this.send(this.pointerEvent("click", p, true, count, mods), cap);
      if (count === 2 && this.live(cap)) this.send(this.pointerEvent("dblclick", p, true, 2, mods), cap);
    }
    p.capture = null;
    p.dragging = false;
    p.payload = null;
    p.dropTarget = null;
    if (type === "touch") {
      this.updateHover(null, p);
      this.pointers.delete(pointerId);
    }
    return this.record("pointerup", cap, true);
  }

  /** The platform cancelled the pointer (touch stolen by a gesture, window blur). */
  pointerCancel(pointerId = 0): boolean {
    const p = this.pointers.get(pointerId);
    if (!p) return false;
    const cap = p.capture;
    this.endGesture(p);
    if (this.live(cap)) this.send(this.pointerEvent("pointercancel", p), cap);
    this.pointers.delete(pointerId);
    if (p.type === "touch") this.updateHover(null, null);
    return this.record("pointercancel", cap, cap !== null);
  }

  private endGesture(p: PointerState): void {
    const cap = p.capture;
    if (cap) cap.setStateBit(UIState.Pressed, false);
    if (p.dragging && this.live(cap)) {
      if (this.live(p.dropTarget)) this.send(this.dragEvent("dragleave", p), p.dropTarget);
      this.send(this.dragEvent("dragend", p), cap);
    }
    p.capture = null;
    p.pressed = false;
    p.dragging = false;
    p.payload = null;
    p.dropTarget = null;
  }

  /** Cancel gestures whose target became disabled, hidden, disposed or detached (per frame). */
  validate(): void {
    for (const p of this.pointers.values()) {
      const cap = p.capture;
      if (cap && (!this.live(cap) || !cap.effectivelyEnabled || !cap.effectivelyVisible)) {
        const wasLive = this.live(cap);
        this.endGesture(p);
        if (wasLive) this.send(this.pointerEvent("pointercancel", p), cap);
      }
    }
    if (this.hoverChain.some((e) => !this.live(e))) this.hoverChain = this.hoverChain.filter((e) => this.live(e));
  }

  /** Forget an element that left the tree. */
  elementDetached(el: UIElement): void {
    if (this.hoverChain.includes(el)) this.hoverChain = this.hoverChain.filter((e) => e !== el);
    if (this.lastClick?.target === el) this.lastClick = null;
    for (const p of this.pointers.values()) {
      if (p.capture === el) {
        p.capture = null;
        p.pressed = false;
        p.dragging = false;
      }
      if (p.dropTarget === el) p.dropTarget = null;
    }
  }

  wheel(x: number, y: number, deltaX: number, deltaY: number, mods: Readonly<Modifiers> = NO_MODIFIERS): boolean {
    const hit = this.hit(x, y);
    if (!hit) return this.record("wheel", null, false);
    if (!hit.effectivelyEnabled) return this.record("wheel", hit, true);
    const ev = new UIWheelEvent(x, y, deltaX, deltaY, mods);
    this.send(ev, hit);
    return this.record("wheel", hit, true);
  }

  // ------------------------------------------------------------------ keyboard / gamepad

  private keyTarget(): UIElement {
    return this.host.focus.focused ?? this.host.topModal ?? this.host.root;
  }

  keyDown(key: string, code = key, mods: Readonly<Modifiers> = NO_MODIFIERS, repeat = false): boolean {
    const target = this.keyTarget();
    const ev = new UIKeyEvent("keydown", key, code, mods, repeat);
    this.send(ev, target);
    const focusedBefore = this.host.focus.focused !== null;
    if (ev.defaultPrevented) return this.record(`keydown ${key}`, target, true);
    switch (key) {
      case "Tab":
        this.navigate(mods.shift ? "previous" : "next", "keyboard");
        return this.record(`keydown ${key}`, target, true);
      case "ArrowUp":
      case "ArrowDown":
      case "ArrowLeft":
      case "ArrowRight": {
        const dir = key === "ArrowUp" ? "up" : key === "ArrowDown" ? "down" : key === "ArrowLeft" ? "left" : "right";
        // Arrows only belong to the UI when something in it has focus.
        if (!focusedBefore && !this.host.topModal) return this.record(`keydown ${key}`, target, false);
        this.navigate(dir, "keyboard");
        return this.record(`keydown ${key}`, target, true);
      }
      case "Enter":
      case " ":
        if (!focusedBefore) return this.record(`keydown ${key}`, target, false);
        this.action("activate", "keyboard");
        return this.record(`keydown ${key}`, target, true);
      case "Escape":
        return this.record(`keydown ${key}`, target, this.action("cancel", "keyboard"));
      default:
        return this.record(`keydown ${key}`, target, focusedBefore);
    }
  }

  keyUp(key: string, code = key, mods: Readonly<Modifiers> = NO_MODIFIERS): boolean {
    const target = this.keyTarget();
    this.send(new UIKeyEvent("keyup", key, code, mods), target);
    return this.record(`keyup ${key}`, target, this.host.focus.focused !== null);
  }

  text(text: string): boolean {
    const f = this.host.focus.focused;
    if (!f) return this.record("textinput", null, false);
    this.send(new UITextEvent(text), f);
    return this.record("textinput", f, true);
  }

  /** Dispatch `navigate`; its default action moves focus. */
  navigate(direction: NavigationDirection, source: "keyboard" | "gamepad"): void {
    const target = this.keyTarget();
    const ev = new UINavigateEvent(direction, source);
    this.send(ev, target);
    if (!ev.defaultPrevented) this.host.focus.move(direction, true);
  }

  /** Dispatch `activate`/`cancel`; returns true when something handled it (default prevented). */
  action(type: "activate" | "cancel", source: "keyboard" | "gamepad"): boolean {
    const target = this.keyTarget();
    const ev = new UIActionEvent(type, source);
    this.send(ev, target);
    return ev.defaultPrevented;
  }

  gamepadButton(button: GamepadButton, pressed: boolean): boolean {
    if (!pressed) {
      if (this.held?.source === "gamepad" && this.held.dir === button) this.held = null;
      return false;
    }
    switch (button) {
      case "up":
      case "down":
      case "left":
      case "right":
        this.held = { dir: button, source: "gamepad", time: 0, next: this.repeatDelay };
        this.navigate(button, "gamepad");
        return this.record(`gamepad ${button}`, this.host.focus.focused, true);
      case "lb":
      case "rb":
        this.navigate(button === "lb" ? "pageprevious" : "pagenext", "gamepad");
        return this.record(`gamepad ${button}`, this.host.focus.focused, true);
      case "a":
        if (!this.host.focus.focused) {
          this.host.focus.move("next", true);
          return this.record("gamepad a", this.host.focus.focused, true);
        }
        this.action("activate", "gamepad");
        return this.record("gamepad a", this.host.focus.focused, true);
      case "b":
        return this.record("gamepad b", this.host.focus.focused, this.action("cancel", "gamepad"));
      default:
        return false;
    }
  }

  /** Left stick (−1..1). Crossing the dead zone navigates once, then repeats while held. */
  gamepadAxis(x: number, y: number): boolean {
    let dir: NavigationDirection | null = null;
    if (Math.abs(x) >= Math.abs(y)) {
      if (x > this.axisDeadZone) dir = "right";
      else if (x < -this.axisDeadZone) dir = "left";
    } else if (y > this.axisDeadZone) dir = "down";
    else if (y < -this.axisDeadZone) dir = "up";
    if (dir === this.axisDir) return dir !== null;
    this.axisDir = dir;
    if (!dir) {
      if (this.held?.source === "gamepad") this.held = null;
      return false;
    }
    this.held = { dir, source: "gamepad", time: 0, next: this.repeatDelay };
    this.navigate(dir, "gamepad");
    return true;
  }

  /** Drives held-direction repeat. */
  update(dt: number): void {
    const h = this.held;
    if (!h) return;
    h.time += dt;
    while (h.time >= h.next && this.held === h) {
      h.next += this.repeatInterval;
      // Keyboard repeat comes from the OS key-repeat (keyDown with repeat=true); only the pad repeats here.
      this.navigate(h.dir, "gamepad");
    }
  }
}
