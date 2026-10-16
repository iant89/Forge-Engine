/**
 * UI events and their propagation.
 *
 * Model (the DOM's, minus its legacy): an event has a target; listeners registered with
 * `{ capture: true }` run on the way down (root → target's parent), then the target's capture and
 * bubble listeners run, then — if the event bubbles — bubble listeners from the target's parent up to
 * the root. `stopPropagation()` ends the walk after the current element's listeners;
 * `stopImmediatePropagation()` ends it immediately; `preventDefault()` cancels the router's/widget's
 * default action (focus traversal on `navigate`, activation on `activate`, …).
 *
 * Robustness rules (each pinned by `tests/ui/uiInput.test.ts`):
 *  * The path is snapshotted before dispatch; an element disposed or detached by an earlier listener
 *    is skipped, so callbacks may destroy or reparent anything without corrupting the walk.
 *  * Listener lists are copy-on-write; a listener removed during dispatch does not run afterwards,
 *    one added during dispatch runs from the next event on.
 *  * A throwing listener is reported (manager diagnostics, else `console.error`) and the walk goes on.
 */

import type { Disposable } from "../../core/events.js";
import type { UIElement } from "../core/element.js";

export const enum EventPhase {
  None = 0,
  Capture = 1,
  Target = 2,
  Bubble = 3,
}

export interface Modifiers {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
}

export const NO_MODIFIERS: Readonly<Modifiers> = Object.freeze({ shift: false, ctrl: false, alt: false, meta: false });

export class UIEvent {
  target: UIElement | null = null;
  currentTarget: UIElement | null = null;
  phase: EventPhase = EventPhase.None;
  defaultPrevented = false;
  propagationStopped = false;
  immediatePropagationStopped = false;

  constructor(
    readonly type: string,
    readonly bubbles = true,
    readonly cancelable = true,
  ) {}

  preventDefault(): void {
    if (this.cancelable) this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.propagationStopped = true;
  }

  stopImmediatePropagation(): void {
    this.propagationStopped = true;
    this.immediatePropagationStopped = true;
  }
}

export type PointerType = "mouse" | "touch" | "pen";

export class UIPointerEvent extends UIEvent {
  constructor(
    type: string,
    readonly x: number,
    readonly y: number,
    readonly pointerId: number,
    readonly pointerType: PointerType,
    readonly button: number,
    readonly modifiers: Readonly<Modifiers>,
    /** 1 for a single click, 2 for the second click of a double click. */
    readonly clickCount = 0,
    /** Movement since the press (drag events) — 0 otherwise. */
    readonly dx = 0,
    readonly dy = 0,
    bubbles = true,
  ) {
    super(type, bubbles);
  }

  /** Position relative to the listener's element (its border box's top-left). */
  get localX(): number {
    return this.x - (this.currentTarget?.bounds.x ?? 0);
  }

  get localY(): number {
    return this.y - (this.currentTarget?.bounds.y ?? 0);
  }
}

export class UIWheelEvent extends UIEvent {
  constructor(
    readonly x: number,
    readonly y: number,
    readonly deltaX: number,
    readonly deltaY: number,
    readonly modifiers: Readonly<Modifiers>,
  ) {
    super("wheel");
  }
}

export class UIKeyEvent extends UIEvent {
  constructor(
    type: "keydown" | "keyup",
    /** `KeyboardEvent.key` vocabulary: "a", "Enter", "ArrowLeft", "Tab", "Escape", "Backspace", … */
    readonly key: string,
    readonly code: string,
    readonly modifiers: Readonly<Modifiers>,
    readonly repeat = false,
  ) {
    super(type);
  }
}

/** Committed text (a typed character, a paste). IME composition is not modelled. */
export class UITextEvent extends UIEvent {
  constructor(readonly text: string) {
    super("textinput");
  }
}

export class UIFocusEvent extends UIEvent {
  constructor(
    type: "focus" | "blur" | "focusin" | "focusout",
    readonly relatedTarget: UIElement | null,
    /** True when focus moved by keyboard/gamepad (show a focus ring), false for pointer focus. */
    readonly visible: boolean,
  ) {
    // focus/blur do not bubble; focusin/focusout do (DOM semantics).
    super(type, type === "focusin" || type === "focusout", false);
  }
}

/** `pagenext`/`pageprevious` come from gamepad shoulder buttons (tab pages); default: like next/previous. */
export type NavigationDirection = "up" | "down" | "left" | "right" | "next" | "previous" | "pagenext" | "pageprevious";
export type InputSource = "keyboard" | "gamepad" | "pointer" | "program";

/** Directional/sequential navigation request. Default action: move focus. */
export class UINavigateEvent extends UIEvent {
  constructor(
    readonly direction: NavigationDirection,
    readonly source: InputSource,
  ) {
    super("navigate");
  }
}

/** `activate` (Enter/Space/gamepad A) and `cancel` (Escape/gamepad B). */
export class UIActionEvent extends UIEvent {
  constructor(
    type: "activate" | "cancel",
    readonly source: InputSource,
  ) {
    super(type);
  }
}

/** Drag-and-drop between elements; `payload` is whatever the drag source put in `dragstart`. */
export class UIDragEvent extends UIPointerEvent {
  payload: unknown = null;
}

/** Application/widget event with a typed detail (`change`, `select`, `toggle`, `close`, …). */
export class UICustomEvent<T = unknown> extends UIEvent {
  constructor(
    type: string,
    readonly detail: T,
    bubbles = true,
  ) {
    super(type, bubbles);
  }
}

export type UIEventListener<E extends UIEvent = UIEvent> = (event: E) => void;

export interface ListenerRecord {
  readonly fn: UIEventListener;
  readonly capture: boolean;
  active: boolean;
}

/** Map event type → event class for typed `on()` overloads. */
export interface UIEventMap {
  pointerdown: UIPointerEvent;
  pointerup: UIPointerEvent;
  pointermove: UIPointerEvent;
  pointerenter: UIPointerEvent;
  pointerleave: UIPointerEvent;
  pointercancel: UIPointerEvent;
  click: UIPointerEvent;
  dblclick: UIPointerEvent;
  contextmenu: UIPointerEvent;
  dragstart: UIDragEvent;
  drag: UIDragEvent;
  dragend: UIDragEvent;
  dragenter: UIDragEvent;
  dragleave: UIDragEvent;
  dragover: UIDragEvent;
  drop: UIDragEvent;
  wheel: UIWheelEvent;
  keydown: UIKeyEvent;
  keyup: UIKeyEvent;
  textinput: UITextEvent;
  focus: UIFocusEvent;
  blur: UIFocusEvent;
  focusin: UIFocusEvent;
  focusout: UIFocusEvent;
  navigate: UINavigateEvent;
  activate: UIActionEvent;
  cancel: UIActionEvent;
  /** Widget value changed (two-way bindings listen to this). */
  change: UICustomEvent<{ property: string; value: unknown }>;
  /** A control was pressed (pointer, keyboard, gamepad or program). */
  press: UICustomEvent<{ source: InputSource }>;
  select: UICustomEvent<unknown>;
  toggle: UICustomEvent<unknown>;
  /** An overlay closed (dialogs, popups, menus). */
  close: UICustomEvent<null>;
  submit: UICustomEvent<{ value: string }>;
}

/** Where listener exceptions go; the manager installs its diagnostics sink. */
export type ListenerErrorSink = (error: unknown, event: UIEvent, element: UIElement) => void;

const pathScratch: UIElement[][] = [];

/**
 * Dispatch `event` at `target`. Returns `!event.defaultPrevented`.
 *
 * Re-entrant: a listener may dispatch another event (each dispatch takes its own path array from a
 * small stack, so nested dispatch never clobbers the outer walk).
 */
export function dispatchUIEvent(event: UIEvent, target: UIElement, onError?: ListenerErrorSink): boolean {
  if (target.disposed) return false;
  const path = pathScratch.pop() ?? [];
  path.length = 0;
  for (let e: UIElement | null = target; e; e = e.parent) path.push(e);
  event.target = target;
  try {
    // Capture: root → parent of target.
    event.phase = EventPhase.Capture;
    for (let i = path.length - 1; i >= 1 && !event.propagationStopped; i--) {
      invoke(path[i]!, event, true, onError);
    }
    if (!event.propagationStopped) {
      event.phase = EventPhase.Target;
      invoke(target, event, true, onError);
      if (!event.immediatePropagationStopped) invoke(target, event, false, onError);
    }
    if (event.bubbles) {
      event.phase = EventPhase.Bubble;
      for (let i = 1; i < path.length && !event.propagationStopped; i++) invoke(path[i]!, event, false, onError);
    }
  } finally {
    event.phase = EventPhase.None;
    event.currentTarget = null;
    path.length = 0;
    pathScratch.push(path);
  }
  return !event.defaultPrevented;
}

function invoke(el: UIElement, event: UIEvent, capture: boolean, onError?: ListenerErrorSink): void {
  if (el.disposed) return;
  const list = el._listeners(event.type);
  if (!list) return;
  event.currentTarget = el;
  for (let i = 0; i < list.length; i++) {
    const rec = list[i]!;
    if (!rec.active || rec.capture !== capture) continue;
    if (event.immediatePropagationStopped) return;
    try {
      rec.fn(event);
    } catch (e) {
      if (onError) onError(e, event, el);
      else if (typeof console !== "undefined") console.error(`[forge.ui] "${event.type}" listener on ${el.debugName} threw`, e);
    }
    if (el.disposed) return;
  }
}

/** A disposable that removes one listener record (shared by `UIElement.on`). */
export function listenerHandle(remove: () => void): Disposable {
  let active = true;
  return {
    dispose() {
      if (!active) return;
      active = false;
      remove();
    },
  };
}
