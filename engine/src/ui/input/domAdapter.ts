/**
 * Browser input adapter: DOM Pointer/Keyboard/Clipboard events and the Gamepad API → `InputRouter`.
 *
 * This is the only place the UI touches the DOM, and only to *read input*. It listens to Pointer
 * Events exclusively (never mouse *and* touch), so one physical tap produces one press. Positions are
 * mapped through the element's bounding rectangle to physical pixels and then through the UI
 * viewport's scale — the same scale the GPU backend draws with — so hit testing matches what is drawn
 * even when the canvas is CSS-scaled.
 *
 * When the router reports an input as consumed the DOM event's default is prevented (Tab does not
 * leave the canvas, a wheel over a scroll view does not scroll the page); unconsumed input passes
 * through untouched, so the game and orbit controls still receive clicks on empty space.
 *
 * Typed text is taken from `keydown` (printable keys) and `paste`; IME composition is not modelled.
 * Gamepads are polled by `handle.pollGamepads()` (call it once per frame) using the standard mapping.
 */

import type { InputRouter, GamepadButton } from "./router.js";
import type { UIViewport } from "../core/geometry.js";
import type { Modifiers, PointerType } from "./events.js";

export interface DomInputOptions {
  /** Where keyboard events are read (default: `window`). */
  keyboardTarget?: { addEventListener(type: string, fn: EventListener, opts?: AddEventListenerOptions | boolean): void; removeEventListener(type: string, fn: EventListener, opts?: EventListenerOptions | boolean): void };
  /** Poll gamepads (default true). */
  gamepad?: boolean;
  /** Called with copied text (system clipboard write); default uses `navigator.clipboard`. */
  writeClipboard?: (text: string) => void;
  /**
   * Listen in the capture phase and stop consumed events from reaching other listeners on the same
   * element/window (default true): a click on a UI button must not also orbit the camera.
   */
  exclusive?: boolean;
}

export interface DomInputHandle {
  pollGamepads(): void;
  dispose(): void;
}

/** The element input is read from (an `HTMLCanvasElement` in practice; tests pass a stand-in). */
export interface DomEventTargetLike {
  addEventListener(type: string, fn: EventListener, opts?: AddEventListenerOptions | boolean): void;
  removeEventListener(type: string, fn: EventListener, opts?: EventListenerOptions | boolean): void;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  setPointerCapture?(id: number): void;
  releasePointerCapture?(id: number): void;
  width?: number;
  height?: number;
}

interface PointerLike {
  stopImmediatePropagation?(): void;
  clientX: number;
  clientY: number;
  pointerId: number;
  pointerType: string;
  button: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  preventDefault(): void;
}

interface KeyLike {
  stopImmediatePropagation?(): void;
  key: string;
  code: string;
  repeat: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  preventDefault(): void;
  target?: { tagName?: string } | null;
}

const GAMEPAD_BUTTONS: [number, GamepadButton][] = [
  [0, "a"],
  [1, "b"],
  [2, "x"],
  [3, "y"],
  [4, "lb"],
  [5, "rb"],
  [8, "select"],
  [9, "start"],
  [12, "up"],
  [13, "down"],
  [14, "left"],
  [15, "right"],
];

function mods(e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): Modifiers {
  return { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey };
}

/**
 * Attach DOM input on `element` (usually the canvas) to a router. `viewport` converts positions.
 * Copy/cut text is written to the system clipboard through `writeClipboard`; use the returned
 * `clipboard` with `TextInput.clipboard = handle.clipboard` (paste arrives as text events).
 */
export function attachDomInput(element: DomEventTargetLike, router: InputRouter, viewport: UIViewport, options: DomInputOptions = {}): DomInputHandle & { clipboard: { read(): string | null; write(t: string): void } } {
  const win = (globalThis as { window?: DomInputOptions["keyboardTarget"] }).window;
  const keys = options.keyboardTarget ?? win;
  const toLogical = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = element.getBoundingClientRect();
    const sx = (element.width ?? r.width) / Math.max(1, r.width);
    const sy = (element.height ?? r.height) / Math.max(1, r.height);
    const s = viewport.scale;
    return [((e.clientX - r.left) * sx) / s, ((e.clientY - r.top) * sy) / s];
  };
  const kind = (t: string): PointerType => (t === "touch" ? "touch" : t === "pen" ? "pen" : "mouse");
  const exclusive = options.exclusive ?? true;
  const consume = (e: { preventDefault(): void; stopImmediatePropagation?(): void }): void => {
    e.preventDefault();
    if (exclusive) e.stopImmediatePropagation?.();
  };

  const onDown = (e: PointerLike): void => {
    const [x, y] = toLogical(e);
    if (router.pointerDown(x, y, e.pointerId, kind(e.pointerType), e.button, mods(e))) {
      consume(e);
      try {
        element.setPointerCapture?.(e.pointerId);
      } catch {
        // The pointer may already be gone (fast taps); the router still has the press.
      }
    }
  };
  const onMove = (e: PointerLike): void => {
    const [x, y] = toLogical(e);
    // Moves are only exclusive while the UI holds the pointer (a drag that started on a widget).
    const captured = router.captureOf(e.pointerId) !== null;
    router.pointerMove(x, y, e.pointerId, kind(e.pointerType), mods(e));
    if (captured) consume(e);
  };
  const onUp = (e: PointerLike): void => {
    const [x, y] = toLogical(e);
    const captured = router.captureOf(e.pointerId) !== null;
    router.pointerUp(x, y, e.pointerId, kind(e.pointerType), e.button, mods(e));
    if (captured) consume(e);
    try {
      element.releasePointerCapture?.(e.pointerId);
    } catch {
      // Already released.
    }
  };
  const onCancel = (e: PointerLike): void => {
    router.pointerCancel(e.pointerId);
  };
  const onWheel = (e: PointerLike & { deltaX: number; deltaY: number; deltaMode: number }): void => {
    const [x, y] = toLogical(e);
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    if (router.wheel(x, y, e.deltaX * k, e.deltaY * k, mods(e))) consume(e);
  };
  const onContextMenu = (e: PointerLike): void => {
    const [x, y] = toLogical(e);
    // Suppress the browser menu only over the UI (a ContextMenu widget handles button 2 there).
    if (router.hitTestAt(x, y) !== null) e.preventDefault();
  };
  const isEditableDom = (e: KeyLike): boolean => {
    const tag = e.target?.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  };
  const onKeyDown = (e: KeyLike): void => {
    if (isEditableDom(e)) return;
    const consumed = router.keyDown(e.key, e.code, mods(e), e.repeat);
    let textConsumed = false;
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) textConsumed = router.text(e.key);
    if (consumed || textConsumed) consume(e);
  };
  const onKeyUp = (e: KeyLike): void => {
    if (isEditableDom(e)) return;
    if (router.keyUp(e.key, e.code, mods(e))) consume(e);
  };
  const onPaste = (e: { clipboardData?: { getData(t: string): string } | null; preventDefault(): void }): void => {
    const text = e.clipboardData?.getData("text") ?? "";
    if (text && router.text(text)) e.preventDefault();
  };

  // DOM listeners are typed loosely here: each handler reads only the fields it declares above.
  const add = (t: DomInputOptions["keyboardTarget"] | DomEventTargetLike | undefined, type: string, fn: (e: never) => void, opts?: AddEventListenerOptions): void =>
    t?.addEventListener(type, fn as unknown as EventListener, opts);
  const remove = (t: DomInputOptions["keyboardTarget"] | DomEventTargetLike | undefined, type: string, fn: (e: never) => void): void =>
    t?.removeEventListener(type, fn as unknown as EventListener, { capture: exclusive });
  const capture = exclusive;
  add(element, "pointerdown", onDown as never, { capture });
  add(element, "pointermove", onMove as never, { capture });
  add(element, "pointerup", onUp as never, { capture });
  add(element, "pointercancel", onCancel as never, { capture });
  add(element, "wheel", onWheel as never, { passive: false, capture });
  add(element, "contextmenu", onContextMenu as never, { capture });
  add(keys, "keydown", onKeyDown as never, { capture });
  add(keys, "keyup", onKeyUp as never, { capture });
  add(keys, "paste", onPaste as never, { capture });

  const prev = new Map<number, boolean[]>();
  const writeClipboard =
    options.writeClipboard ??
    ((text: string) => {
      const nav = (globalThis as { navigator?: { clipboard?: { writeText(t: string): Promise<void> } } }).navigator;
      nav?.clipboard?.writeText(text).catch(() => {
        // Permission denied: the in-app clipboard still works through `read` returning null → paste events.
      });
    });

  return {
    clipboard: {
      // Paste comes from the DOM `paste` event, so Ctrl+V must not paste a second time.
      read: () => null,
      write: writeClipboard,
    },
    pollGamepads(): void {
      if (options.gamepad === false) return;
      const nav = (globalThis as { navigator?: { getGamepads?: () => ({ index: number; buttons: { pressed: boolean }[]; axes: number[] } | null)[] } }).navigator;
      const pads = nav?.getGamepads?.() ?? [];
      for (const pad of pads) {
        if (!pad) continue;
        const was = prev.get(pad.index) ?? [];
        const now: boolean[] = [];
        for (const [i, name] of GAMEPAD_BUTTONS) {
          const pressed = pad.buttons[i]?.pressed ?? false;
          now[i] = pressed;
          if (pressed !== (was[i] ?? false)) router.gamepadButton(name, pressed);
        }
        prev.set(pad.index, now);
        router.gamepadAxis(pad.axes[0] ?? 0, pad.axes[1] ?? 0);
      }
    },
    dispose(): void {
      remove(element, "pointerdown", onDown as never);
      remove(element, "pointermove", onMove as never);
      remove(element, "pointerup", onUp as never);
      remove(element, "pointercancel", onCancel as never);
      remove(element, "wheel", onWheel as never);
      remove(element, "contextmenu", onContextMenu as never);
      remove(keys, "keydown", onKeyDown as never);
      remove(keys, "keyup", onKeyUp as never);
      remove(keys, "paste", onPaste as never);
    },
  };
}
