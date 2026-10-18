/**
 * Skin and theme vocabulary.
 *
 * Two independent axes describe appearance:
 *
 *  * A **theme** is a set of design tokens — colours, spacing, radii, font sizes, durations. Light,
 *    dark and high-contrast are themes. Themes can `extend` another theme.
 *  * A **skin** is the visual construction of each component type (what is filled, bordered, rounded,
 *    padded, which state changes what) written mostly in token references (`"$color.accent"`). Flat,
 *    rounded, sprite-based and "terminal" looks are skins. Skins can `extend` another skin.
 *
 * Switching the theme recolours every skin; switching the skin restyles every theme. Neither ever
 * touches component behaviour. Values are resolved into an immutable {@link ResolvedStyle}.
 */

import type { UIColor } from "../core/color.js";
import type { CornersInput, InsetsInput, UICorners, UIInsets } from "../core/geometry.js";

/** Visual interaction states. Bits so a state *set* is one number (and one cache-key component). */
export const enum UIState {
  None = 0,
  Hovered = 1 << 0,
  Focused = 1 << 1,
  Pressed = 1 << 2,
  Selected = 1 << 3,
  Checked = 1 << 4,
  Expanded = 1 << 5,
  Invalid = 1 << 6,
  Loading = 1 << 7,
  /** Needs attention (low health, ability ready, unread). */
  Alert = 1 << 8,
  Disabled = 1 << 9,
}

/** Built-in state names in **application order** (later wins per property). */
export const BUILTIN_STATES: readonly { name: string; bit: number }[] = [
  { name: "hovered", bit: UIState.Hovered },
  { name: "focused", bit: UIState.Focused },
  { name: "pressed", bit: UIState.Pressed },
  { name: "selected", bit: UIState.Selected },
  { name: "checked", bit: UIState.Checked },
  { name: "expanded", bit: UIState.Expanded },
  { name: "invalid", bit: UIState.Invalid },
  { name: "loading", bit: UIState.Loading },
  { name: "alert", bit: UIState.Alert },
  { name: "disabled", bit: UIState.Disabled },
];

/** First bit available to application-defined states (`StateRegistry.define`). */
export const FIRST_CUSTOM_STATE_BIT = 10;

export type Easing = "linear" | "easeIn" | "easeOut" | "easeInOut" | "easeOutBack" | "easeInCubic" | "easeOutCubic" | "easeInOutCubic" | "step";

export type GradientDirection = "none" | "vertical" | "horizontal";
export type TextAlign = "start" | "center" | "end";

/** Display-only case transform; the element's text (and its accessible label) keep their own case. */
export type TextTransform = "none" | "uppercase";

/** Animated state transition for a set of style properties. */
export interface TransitionDefinition {
  /** Which properties animate; `"all"` animates every interpolable property. */
  properties: readonly TransitionProperty[] | "all";
  duration: number;
  easing?: Easing;
  delay?: number;
}

export type TransitionProperty = "background" | "backgroundEnd" | "borderColor" | "foreground" | "accent" | "track" | "opacity" | "borderWidth" | "radius" | "shadowColor" | "imageTint";

export const TRANSITION_PROPERTIES: readonly TransitionProperty[] = [
  "background",
  "backgroundEnd",
  "borderColor",
  "foreground",
  "accent",
  "track",
  "opacity",
  "borderWidth",
  "radius",
  "shadowColor",
  "imageTint",
];

/** The fully resolved, immutable appearance of one element in one state. */
export interface ResolvedStyle {
  readonly background: UIColor;
  readonly backgroundEnd: UIColor;
  readonly gradient: GradientDirection;
  readonly borderColor: UIColor;
  readonly borderWidth: number;
  readonly radius: Readonly<UICorners>;
  readonly padding: Readonly<UIInsets>;
  readonly foreground: UIColor;
  readonly accent: UIColor;
  readonly track: UIColor;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly fontWeight: number;
  /** Multiplier of the font size. */
  readonly lineHeight: number;
  readonly letterSpacing: number;
  readonly textAlign: TextAlign;
  readonly textTransform: TextTransform;
  readonly opacity: number;
  readonly shadowColor: UIColor;
  readonly shadowOffsetX: number;
  readonly shadowOffsetY: number;
  readonly shadowBlur: number;
  /** Texture/sprite name drawn as the background (stretched or nine-sliced). */
  readonly image: string | null;
  /** Nine-slice border in source pixels; `null` stretches the image. */
  readonly imageSlice: Readonly<UIInsets> | null;
  readonly imageTint: UIColor;
  readonly icon: string | null;
  readonly iconSize: number;
  /** Gap between parts inside a widget (icon ↔ text, box ↔ label). */
  readonly spacing: number;
  /** Skin-provided minimum size (interaction-target guidance); layout `min*` overrides it. */
  readonly minWidth: number;
  readonly minHeight: number;
  readonly transition: readonly TransitionDefinition[];
  /** Free-form values for custom components (numbers, colours as packed numbers, strings). */
  readonly custom: Readonly<Record<string, number | string>>;
}

/** A style value: a literal, or a `$group.name` token reference resolved against the active theme. */
export type TokenRef = `$${string}`;
export type ColorValue = string | number;
export type NumberValue = number | TokenRef;

/** Authoring form of a style: any subset of properties, token references allowed. */
export interface StyleBlock {
  background?: ColorValue;
  backgroundEnd?: ColorValue;
  gradient?: GradientDirection;
  borderColor?: ColorValue;
  borderWidth?: NumberValue;
  radius?: CornersInput | TokenRef;
  padding?: InsetsInput | TokenRef;
  foreground?: ColorValue;
  accent?: ColorValue;
  track?: ColorValue;
  fontFamily?: string;
  fontSize?: NumberValue;
  fontWeight?: NumberValue;
  lineHeight?: NumberValue;
  letterSpacing?: NumberValue;
  textAlign?: TextAlign;
  textTransform?: TextTransform;
  opacity?: NumberValue;
  shadowColor?: ColorValue;
  shadowOffsetX?: NumberValue;
  shadowOffsetY?: NumberValue;
  shadowBlur?: NumberValue;
  image?: string | null;
  imageSlice?: InsetsInput | null;
  imageTint?: ColorValue;
  icon?: string | null;
  iconSize?: NumberValue;
  spacing?: NumberValue;
  minWidth?: NumberValue;
  minHeight?: NumberValue;
  transition?: readonly TransitionDefinition[];
  custom?: Record<string, number | string>;
}

export interface StatefulStyleBlock extends StyleBlock {
  /** Per-state overrides, keyed by state name (`hovered`, `pressed`, … or a custom state). */
  states?: Record<string, StyleBlock>;
}

export interface ComponentSkin extends StatefulStyleBlock {
  /** Named variants (`primary`, `danger`, `heading`, …) layered over the base block. */
  variants?: Record<string, StatefulStyleBlock>;
}

export interface SkinDefinition {
  name: string;
  version: number;
  /** Parent skin; its component styles are the base for this skin's. */
  extends?: string;
  /** Component styles keyed by style-chain name (`Button`, `Panel`, `HealthBar`, …). */
  components?: Record<string, ComponentSkin>;
}

/** Token groups. Keys are referenced as `$<group>.<name>` (e.g. `$color.accent`). */
export interface ThemeTokens {
  color?: Record<string, ColorValue>;
  space?: Record<string, number>;
  radius?: Record<string, number>;
  font?: Record<string, string>;
  fontSize?: Record<string, number>;
  duration?: Record<string, number>;
  number?: Record<string, number>;
}

export interface ThemeDefinition {
  name: string;
  extends?: string;
  tokens: ThemeTokens;
  /** Informational: `light`, `dark`, `high-contrast`. Exposed to the app; does not change resolution. */
  kind?: string;
}
