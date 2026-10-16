/**
 * `FocusManager` — keyboard/gamepad focus.
 *
 * * **Sequential** (Tab / Shift+Tab, shoulder buttons): focusables in the active scope ordered by
 *   positive `tabIndex` ascending, then `tabIndex 0` in tree (paint) order; wraps around.
 * * **Directional** (arrow keys, d-pad, stick): spatial navigation from the focused element's centre —
 *   candidates must lie in the requested half-plane; the score is the distance along the direction
 *   plus twice the perpendicular offset (prefers aligned neighbours over closer diagonal ones). No
 *   candidate → focus stays (edges do not wrap; that is what Tab is for).
 * * **Scopes**: the top modal is the scope while one is open (focus cannot leave it); otherwise the
 *   nearest ancestor of the focused element with `focusScope` set; otherwise the whole UI.
 * * **Restoration**: opening a modal remembers the focused element; closing it restores that element
 *   if it can still take focus.
 * * **Robustness**: focus changes made by `blur`/`focus` listeners win (a token detects re-entrancy);
 *   `validate()` runs every frame and recovers when the focused element was hidden, disabled, disposed
 *   or detached — to the scope's first focusable if focus was keyboard-driven, else nowhere.
 */

import type { UIElement } from "../core/element.js";
import type { UIFocusService } from "../core/context.js";
import { UIState } from "../style/types.js";
import { UIFocusEvent, type NavigationDirection } from "./events.js";

export interface FocusHost {
  readonly root: UIElement;
  readonly topModal: UIElement | null;
  dispatch(event: UIFocusEvent, target: UIElement): boolean;
}

export class FocusManager implements UIFocusService {
  private _focused: UIElement | null = null;
  private _visible = false;
  private token = 0;
  /** Keyboard focus was lost to a detach; `validate` moves it somewhere sensible. */
  private recoverVisible = false;
  private readonly restoreStack: { modal: UIElement; previous: UIElement | null }[] = [];
  /** Focus changes since creation (diagnostics). */
  changes = 0;

  constructor(private readonly host: FocusHost) {}

  get focused(): UIElement | null {
    return this._focused;
  }

  /** Focus was moved by keyboard/gamepad (draw a focus ring). */
  get focusVisible(): boolean {
    return this._visible;
  }

  /** The element focus traversal is confined to right now. */
  get scope(): UIElement {
    const modal = this.host.topModal;
    if (modal) return modal;
    for (let e = this._focused?.parent ?? null; e; e = e.parent) if (e.focusScope) return e;
    return this.host.root;
  }

  focus(el: UIElement, visible = false): boolean {
    if (!el.canFocus) return false;
    const modal = this.host.topModal;
    if (modal && !modal.isAncestorOf(el)) return false;
    if (el === this._focused) {
      if (visible !== this._visible) {
        this._visible = visible;
        el.invalidateRender();
      }
      return true;
    }
    const token = ++this.token;
    const old = this._focused;
    if (old) {
      old.setStateBit(UIState.Focused, false);
      this._focused = null;
      if (!old.disposed) {
        this.host.dispatch(new UIFocusEvent("blur", el, visible), old);
        this.host.dispatch(new UIFocusEvent("focusout", el, visible), old);
      }
      if (token !== this.token) return this._focused === el;
    }
    if (!el.canFocus) return false;
    this._focused = el;
    this._visible = visible;
    this.changes++;
    el.setStateBit(UIState.Focused, true);
    this.host.dispatch(new UIFocusEvent("focus", old, visible), el);
    if (token !== this.token) return this._focused === el;
    this.host.dispatch(new UIFocusEvent("focusin", old, visible), el);
    return this._focused === el;
  }

  blur(el?: UIElement): void {
    const cur = this._focused;
    if (!cur || (el && el !== cur)) return;
    ++this.token;
    this._focused = null;
    this._visible = false;
    this.changes++;
    cur.setStateBit(UIState.Focused, false);
    if (!cur.disposed) {
      this.host.dispatch(new UIFocusEvent("blur", null, false), cur);
      this.host.dispatch(new UIFocusEvent("focusout", null, false), cur);
    }
  }

  /** Focusables in sequential order inside `scope`. */
  sequence(scope: UIElement = this.scope): UIElement[] {
    const positive: UIElement[] = [];
    const zero: UIElement[] = [];
    const visit = (e: UIElement): void => {
      if (!e.visible) return;
      if (e !== scope && e.canFocus && e.tabIndex >= 0) (e.tabIndex > 0 ? positive : zero).push(e);
      for (const c of e.paintOrder) visit(c);
    };
    visit(scope);
    if (scope.canFocus && scope.tabIndex >= 0) zero.unshift(scope);
    positive.sort((a, b) => a.tabIndex - b.tabIndex);
    return [...positive, ...zero];
  }

  /** Move focus sequentially (`+1` next, `-1` previous). Returns the newly focused element. */
  moveSequential(step: 1 | -1, visible = true): UIElement | null {
    const list = this.sequence();
    if (list.length === 0) return null;
    const at = this._focused ? list.indexOf(this._focused) : -1;
    const next = at < 0 ? (step > 0 ? list[0]! : list[list.length - 1]!) : list[(at + step + list.length) % list.length]!;
    this.focus(next, visible);
    return this._focused;
  }

  /** Spatial navigation. Sequential directions delegate to `moveSequential`. */
  move(direction: NavigationDirection, visible = true): UIElement | null {
    if (direction === "next" || direction === "pagenext") return this.moveSequential(1, visible);
    if (direction === "previous" || direction === "pageprevious") return this.moveSequential(-1, visible);
    const list = this.sequence();
    const cur = this._focused;
    if (!cur || !list.includes(cur)) {
      if (list.length > 0) this.focus(list[0]!, visible);
      return this._focused;
    }
    const cb = cur.bounds;
    const cx = cb.x + cb.width / 2;
    const cy = cb.y + cb.height / 2;
    let best: UIElement | null = null;
    let bestScore = Infinity;
    for (const e of list) {
      if (e === cur) continue;
      const b = e.bounds;
      const ex = b.x + b.width / 2;
      const ey = b.y + b.height / 2;
      let along: number;
      let across: number;
      switch (direction) {
        case "left":
          along = cb.x - (b.x + b.width);
          across = Math.abs(ey - cy);
          if (ex >= cx) continue;
          break;
        case "right":
          along = b.x - (cb.x + cb.width);
          across = Math.abs(ey - cy);
          if (ex <= cx) continue;
          break;
        case "up":
          along = cb.y - (b.y + b.height);
          across = Math.abs(ex - cx);
          if (ey >= cy) continue;
          break;
        default:
          along = b.y - (cb.y + cb.height);
          across = Math.abs(ex - cx);
          if (ey <= cy) continue;
          break;
      }
      const score = Math.max(0, along) + across * 2;
      if (score < bestScore) {
        bestScore = score;
        best = e;
      }
    }
    if (best) this.focus(best, visible);
    else if (visible !== this._visible) {
      this._visible = visible;
      cur.invalidateRender();
    }
    return this._focused;
  }

  /** Called when a modal opens: remember focus and move it inside. */
  enterModal(modal: UIElement, initial: UIElement | null): void {
    this.restoreStack.push({ modal, previous: this._focused });
    const target = initial && initial.canFocus && modal.isAncestorOf(initial) ? initial : this.sequence(modal)[0] ?? null;
    if (target) this.focus(target, this._visible);
    else if (this._focused && !modal.isAncestorOf(this._focused)) this.blur();
  }

  /** Called when a modal closes: restore the focus it displaced. */
  exitModal(modal: UIElement): void {
    const i = this.restoreStack.findIndex((r) => r.modal === modal);
    if (i < 0) return;
    const { previous } = this.restoreStack[i]!;
    this.restoreStack.splice(i, 1);
    if (this._focused && modal.isAncestorOf(this._focused)) this.blur();
    if (previous && previous.canFocus) this.focus(previous, this._visible);
  }

  /** Per-frame recovery when the focused element can no longer hold focus. */
  validate(): void {
    const cur = this._focused;
    if (!cur && this.recoverVisible) {
      this.recoverVisible = false;
      const first = this.sequence()[0];
      if (first) this.focus(first, true);
      return;
    }
    if (!cur || cur.canFocus) return;
    const wasVisible = this._visible;
    this.blur();
    if (wasVisible) {
      const first = this.sequence()[0];
      if (first) this.focus(first, true);
    }
  }

  /** Forget an element that left the tree (called on detach). */
  elementDetached(el: UIElement): void {
    if (this._focused === el) {
      this._focused = null;
      this.recoverVisible = this._visible;
      el.setStateBit(UIState.Focused, false);
      this.changes++;
    }
    for (const r of this.restoreStack) if (r.previous === el) r.previous = null;
  }
}
