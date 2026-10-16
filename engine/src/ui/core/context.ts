/**
 * `UIContext` — the services an attached element can reach. The `UIManager` implements it; elements
 * hold it only while attached (`element.context`), so a detached subtree cannot schedule work on a
 * manager it no longer belongs to. Widgets depend on this interface, never on the manager's internals,
 * which keeps `widgets/` free of a dependency on `manager.ts`.
 */

import type { UIViewport } from "./geometry.js";
import type { UIElement } from "./element.js";
import type { ResolvedStyle } from "../style/types.js";
import type { TextEngine } from "../text/textEngine.js";
import type { UIAnimator } from "../anim/animator.js";
import type { Localizer } from "../text/localization.js";
import type { UIEvent } from "../input/events.js";
import type { UIAssets } from "../render/assets.js";

export interface UIFocusService {
  readonly focused: UIElement | null;
  /** Focus `el` if it is focusable; `visible` = keyboard/gamepad initiated (show a ring). */
  focus(el: UIElement, visible?: boolean): boolean;
  blur(el?: UIElement): void;
  readonly focusVisible: boolean;
}

/** Named stacking layers, painted (and hit-tested in reverse) in this order. */
export type UILayerName = "base" | "hud" | "modal" | "popup" | "tooltip" | "toast" | "debug";
export const UI_LAYERS: readonly UILayerName[] = ["base", "hud", "modal", "popup", "tooltip", "toast", "debug"];

export interface UIOverlayService {
  /**
   * Add `el` to a layer (popups, menus, tooltips, toasts, dialogs). `lightDismiss` closes it when the
   * user presses outside it and its `owner`; opening a modal closes light-dismiss popups whose owner
   * is outside the modal.
   */
  show(el: UIElement, layer: UILayerName, options?: { owner?: UIElement | null; lightDismiss?: boolean }): void;
  /** Open `el` as a modal: blocks input below it, traps focus, restores focus on close. */
  showModal(el: UIElement, options?: { initialFocus?: UIElement | null; closeOnCancel?: boolean }): void;
  close(el: UIElement): void;
  isOpen(el: UIElement): boolean;
  readonly topModal: UIElement | null;
}

export interface UIStyleService {
  resolve(el: UIElement): ResolvedStyle;
  /** A token of the active theme (`"color.accent"`), packed colours as numbers. */
  token(path: string): number | string | undefined;
}

export interface UIContext {
  readonly viewport: UIViewport;
  readonly styles: UIStyleService;
  readonly text: TextEngine;
  readonly assets: UIAssets;
  readonly animator: UIAnimator;
  readonly localizer: Localizer;
  readonly focus: UIFocusService;
  readonly overlays: UIOverlayService;
  /** Current breakpoint name (`compact` / `medium` / `expanded` or the app's own). */
  readonly breakpoint: string;
  /** Monotonic UI time in seconds (scaled; frozen while paused). */
  readonly time: number;
  readonly reducedMotion: boolean;
  markStyleDirty(el: UIElement): void;
  markLayoutDirty(el: UIElement): void;
  markRenderDirty(): void;
  setTicking(el: UIElement, on: boolean): void;
  elementAttached(el: UIElement): void;
  elementDetached(el: UIElement): void;
  /** Dispatch through the router's propagation (diagnostics + error sink included). */
  dispatch(event: UIEvent, target: UIElement): boolean;
  /** Record a diagnostic (`warn` for author mistakes the UI recovered from). */
  diagnostic(level: "info" | "warn" | "error", message: string, el?: UIElement): void;
}
