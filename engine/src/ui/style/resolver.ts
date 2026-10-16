/**
 * Theme + skin registries and the style resolver.
 *
 * Resolution order (docs/UI.md §6), deterministic and pinned by `tests/ui/uiStyle.test.ts`:
 *
 *  1. framework defaults (`DEFAULT_STYLE`)
 *  2. the active skin's component block for each name in the element's style chain, most generic
 *     first, each applied level by level through the skin's `extends` chain (parent skin first)
 *  3. the element's variant block, again for each chain name
 *  4. for each active state in fixed order (hovered, focused, pressed, selected, checked, expanded,
 *     invalid, loading, disabled, then custom states in definition order): the chain's base state
 *     block, then the chain's variant state block
 *  5. per-instance overrides
 *
 * Token references (`"$color.accent"`) resolve against the active theme (flattened through its own
 * `extends` chain). A missing token or an unparsable colour produces one diagnostic per
 * (skin, property, value) and the property keeps the value from the previous step — the parent
 * skin's value for the same component when there is one — never an unrelated style. Resolved styles are frozen and cached by
 * (style chain, variant, state set, skin epoch, theme epoch); elements with instance overrides are
 * resolved individually. Nothing is resolved per frame: only elements marked style-dirty are.
 */

import { UsageError } from "../../core/errors.js";
import { tryParseColor, type UIColor } from "../core/color.js";
import { toCorners, toInsets, type CornersInput, type InsetsInput, type UICorners, type UIInsets } from "../core/geometry.js";
import { DETACHED_STYLE, type UIElement } from "../core/element.js";
import {
  BUILTIN_STATES,
  FIRST_CUSTOM_STATE_BIT,
  type ComponentSkin,
  type ResolvedStyle,
  type SkinDefinition,
  type StatefulStyleBlock,
  type StyleBlock,
  type ThemeDefinition,
} from "./types.js";

export const DEFAULT_STYLE: ResolvedStyle = DETACHED_STYLE;

export type Mutable<T> = { -readonly [K in keyof T]: T[K] };
export type DiagnosticSink = (level: "info" | "warn" | "error", message: string) => void;

const NO_LEVELS: readonly ComponentSkin[] = Object.freeze([]);
const insetsIntern = new Map<string, Readonly<UIInsets>>();
const cornersIntern = new Map<string, Readonly<UICorners>>();

export function internInsets(i: UIInsets): Readonly<UIInsets> {
  const key = `${i.top},${i.right},${i.bottom},${i.left}`;
  let v = insetsIntern.get(key);
  if (!v) {
    v = Object.freeze({ ...i });
    if (insetsIntern.size < 8192) insetsIntern.set(key, v);
  }
  return v;
}

export function internCorners(c: UICorners): Readonly<UICorners> {
  const key = `${c.topLeft},${c.topRight},${c.bottomRight},${c.bottomLeft}`;
  let v = cornersIntern.get(key);
  if (!v) {
    v = Object.freeze({ ...c });
    if (cornersIntern.size < 8192) cornersIntern.set(key, v);
  }
  return v;
}

interface FlatTheme {
  def: ThemeDefinition;
  tokens: Map<string, number | string>;
}

interface FlatSkin {
  def: SkinDefinition;
  /** Merged view per component (tooling). */
  components: Map<string, ComponentSkin>;
  /**
   * The component's blocks at each skin level, parent skin first. Resolution applies them in order,
   * so a child value that fails to resolve (a missing token) leaves the parent skin's value in place.
   */
  levels: Map<string, ComponentSkin[]>;
}

/** Named application-defined visual states (bits after the built-ins). */
export class StateRegistry {
  private readonly custom: { name: string; bit: number }[] = [];

  define(name: string): number {
    const existing = this.bitOf(name);
    if (existing !== 0) return existing;
    const index = FIRST_CUSTOM_STATE_BIT + this.custom.length;
    if (index > 30) throw new UsageError("ui: at most 21 custom visual states can be defined");
    const bit = 1 << index;
    this.custom.push({ name, bit });
    return bit;
  }

  bitOf(name: string): number {
    return BUILTIN_STATES.find((s) => s.name === name)?.bit ?? this.custom.find((s) => s.name === name)?.bit ?? 0;
  }

  /** All states in application order. */
  get ordered(): readonly { name: string; bit: number }[] {
    return this.custom.length === 0 ? BUILTIN_STATES : [...BUILTIN_STATES, ...this.custom];
  }

  names(mask: number): string[] {
    return this.ordered.filter((s) => (mask & s.bit) !== 0).map((s) => s.name);
  }
}

export class StyleResolver {
  private readonly themes = new Map<string, ThemeDefinition>();
  private readonly skins = new Map<string, SkinDefinition>();
  private flatTheme: FlatTheme | null = null;
  private flatSkin: FlatSkin | null = null;
  private activeTheme = "";
  private activeSkin = "";
  private readonly cache = new Map<string, ResolvedStyle>();
  private readonly reported = new Set<string>();
  /** Bumped whenever the active theme or skin (or one of their definitions) changes. */
  epoch = 0;
  readonly states = new StateRegistry();
  /** Cache statistics for diagnostics. */
  readonly stats = { resolves: 0, cacheHits: 0, cacheSize: 0, uniqueResolves: 0 };
  /** Max cached entries; the cache is cleared (not grown) past it. */
  maxCacheEntries = 4096;
  /** Invoked after the theme or skin changes (the manager restyles the tree). */
  onChange: (() => void) | null = null;

  constructor(private readonly diagnostic: DiagnosticSink = () => {}) {}

  // ------------------------------------------------------------------ registration

  registerTheme(def: ThemeDefinition, options: { replace?: boolean } = {}): void {
    if (!def.name) throw new UsageError("ui theme: a theme needs a name");
    if (this.themes.has(def.name) && !options.replace) throw new UsageError(`ui theme: "${def.name}" is already registered (pass { replace: true })`);
    const problems = validateTheme(def);
    if (problems.length > 0) throw new UsageError(`ui theme "${def.name}": ${problems.join("; ")}`);
    const previous = this.themes.get(def.name);
    this.themes.set(def.name, def);
    try {
      this.themeChain(def.name);
    } catch (e) {
      if (previous) this.themes.set(def.name, previous);
      else this.themes.delete(def.name);
      throw e;
    }
    if (this.activeTheme !== "" && this.themeChain(this.activeTheme).includes(def.name)) this.setTheme(this.activeTheme);
  }

  registerSkin(def: SkinDefinition, options: { replace?: boolean } = {}): void {
    if (!def.name) throw new UsageError("ui skin: a skin needs a name");
    if (!Number.isInteger(def.version) || def.version < 1) throw new UsageError(`ui skin "${def.name}": version must be an integer >= 1`);
    if (this.skins.has(def.name) && !options.replace) throw new UsageError(`ui skin: "${def.name}" is already registered (pass { replace: true })`);
    const problems = validateSkin(def, this.states);
    if (problems.length > 0) throw new UsageError(`ui skin "${def.name}": ${problems.join("; ")}`);
    const previous = this.skins.get(def.name);
    this.skins.set(def.name, def);
    try {
      this.skinChain(def.name);
    } catch (e) {
      if (previous) this.skins.set(def.name, previous);
      else this.skins.delete(def.name);
      throw e;
    }
    if (this.activeSkin !== "" && this.skinChain(this.activeSkin).includes(def.name)) this.setSkin(this.activeSkin);
  }

  unregisterSkin(name: string): boolean {
    if (name === this.activeSkin) throw new UsageError(`ui skin: "${name}" is active; switch skins before unloading it`);
    for (const s of this.skins.values()) if (s.extends === name) throw new UsageError(`ui skin: "${s.name}" extends "${name}"; unload it first`);
    return this.skins.delete(name);
  }

  unregisterTheme(name: string): boolean {
    if (name === this.activeTheme) throw new UsageError(`ui theme: "${name}" is active; switch themes before unloading it`);
    for (const t of this.themes.values()) if (t.extends === name) throw new UsageError(`ui theme: "${t.name}" extends "${name}"; unload it first`);
    return this.themes.delete(name);
  }

  get themeNames(): string[] {
    return [...this.themes.keys()];
  }

  get skinNames(): string[] {
    return [...this.skins.keys()];
  }

  get theme(): string {
    return this.activeTheme;
  }

  get skin(): string {
    return this.activeSkin;
  }

  getTheme(name: string): ThemeDefinition | undefined {
    return this.themes.get(name);
  }

  /** Parent-first chain of theme names; throws on unknown parents and cycles. */
  themeChain(name: string): string[] {
    return chainOf(name, (n) => this.themes.get(n)?.extends, (n) => this.themes.has(n), "theme");
  }

  skinChain(name: string): string[] {
    return chainOf(name, (n) => this.skins.get(n)?.extends, (n) => this.skins.has(n), "skin");
  }

  setTheme(name: string): void {
    const chain = this.themeChain(name);
    const tokens = new Map<string, number | string>();
    for (const n of chain) {
      const t = this.themes.get(n)!.tokens;
      for (const [group, values] of Object.entries(t)) {
        for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
          if (group === "color") {
            const c = typeof value === "number" ? value >>> 0 : tryParseColor(String(value));
            tokens.set(`color.${key}`, c ?? 0);
          } else tokens.set(`${group}.${key}`, value as number | string);
        }
      }
    }
    this.flatTheme = { def: this.themes.get(name)!, tokens };
    this.activeTheme = name;
    this.invalidateAll();
  }

  setSkin(name: string): void {
    const chain = this.skinChain(name);
    const components = new Map<string, ComponentSkin>();
    const levels = new Map<string, ComponentSkin[]>();
    for (const n of chain) {
      const comps = this.skins.get(n)!.components ?? {};
      for (const [comp, block] of Object.entries(comps)) {
        components.set(comp, mergeComponent(components.get(comp), block));
        let list = levels.get(comp);
        if (!list) levels.set(comp, (list = []));
        list.push(block);
      }
    }
    this.flatSkin = { def: this.skins.get(name)!, components, levels };
    this.activeSkin = name;
    this.invalidateAll();
  }

  private invalidateAll(): void {
    this.epoch++;
    this.cache.clear();
    this.reported.clear();
    this.onChange?.();
  }

  /** Look up a theme token (`"color.accent"`) in the active theme. */
  token(path: string): number | string | undefined {
    return this.flatTheme?.tokens.get(path);
  }

  /** Effective component block (flattened) for tooling. */
  componentSkin(name: string): ComponentSkin | undefined {
    return this.flatSkin?.components.get(name);
  }

  // ------------------------------------------------------------------ resolution

  resolve(el: UIElement): ResolvedStyle {
    this.stats.resolves++;
    const chain = el.styleChain;
    const overrides = el.style;
    const key = overrides ? "" : `${chain.join(">")}|${el.variant ?? ""}|${el.state}`;
    if (key) {
      const hit = this.cache.get(key);
      if (hit) {
        this.stats.cacheHits++;
        return hit;
      }
    }
    this.stats.uniqueResolves++;
    const draft: Mutable<ResolvedStyle> = { ...DEFAULT_STYLE };
    const skin = this.flatSkin;
    const where = el.typeName;
    if (skin) {
      const levelsOf = (name: string): readonly ComponentSkin[] => skin.levels.get(name) ?? NO_LEVELS;
      for (const name of chain) for (const block of levelsOf(name)) this.apply(draft, block, name);
      const variant = el.variant;
      if (variant) {
        let found = false;
        for (const name of chain) {
          for (const block of levelsOf(name)) {
            const v = block.variants?.[variant];
            if (v) {
              found = true;
              this.apply(draft, v, `${name}.variants.${variant}`);
            }
          }
        }
        if (!found) this.report(`variant:${chain.join(">")}:${variant}`, "warn", `skin "${this.activeSkin}" has no variant "${variant}" for ${where}`);
      }
      const state = el.state;
      if (state !== 0) {
        for (const s of this.states.ordered) {
          if ((state & s.bit) === 0) continue;
          for (const name of chain) {
            for (const block of levelsOf(name)) {
              const b = block.states?.[s.name];
              if (b) this.apply(draft, b, `${name}.states.${s.name}`);
            }
          }
          if (variant) {
            for (const name of chain) {
              for (const block of levelsOf(name)) {
                const b = block.variants?.[variant]?.states?.[s.name];
                if (b) this.apply(draft, b, `${name}.variants.${variant}.states.${s.name}`);
              }
            }
          }
        }
      }
    }
    if (overrides) this.apply(draft, overrides, `${el.debugName}.style`);
    draft.padding = internInsets(draft.padding as UIInsets);
    draft.radius = internCorners(draft.radius as UICorners);
    const resolved = Object.freeze(draft) as ResolvedStyle;
    if (key) {
      if (this.cache.size >= this.maxCacheEntries) this.cache.clear();
      this.cache.set(key, resolved);
      this.stats.cacheSize = this.cache.size;
    }
    return resolved;
  }

  private report(key: string, level: "warn" | "error", message: string): void {
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.diagnostic(level, message);
  }

  private tokenValue(ref: string, where: string, prop: string): number | string | undefined {
    const path = ref.slice(1);
    const v = this.flatTheme?.tokens.get(path);
    if (v === undefined) this.report(`token:${where}:${prop}:${ref}`, "warn", `${where}.${prop}: token "${ref}" is not defined by theme "${this.activeTheme || "(none)"}"`);
    return v;
  }

  private color(v: string | number, where: string, prop: string): UIColor | undefined {
    if (typeof v === "number") return v >>> 0;
    if (v.startsWith("$")) {
      const t = this.tokenValue(v, where, prop);
      return typeof t === "number" ? t : undefined;
    }
    const c = tryParseColor(v);
    if (c === null) this.report(`color:${where}:${prop}:${v}`, "warn", `${where}.${prop}: "${v}" is not a colour`);
    return c ?? undefined;
  }

  private num(v: number | string, where: string, prop: string): number | undefined {
    if (typeof v === "number") return v;
    if (v.startsWith("$")) {
      const t = this.tokenValue(v, where, prop);
      if (typeof t === "number") return t;
      if (t !== undefined) this.report(`num:${where}:${prop}:${v}`, "warn", `${where}.${prop}: token "${v}" is not a number`);
      return undefined;
    }
    this.report(`num:${where}:${prop}:${v}`, "warn", `${where}.${prop}: "${v}" is not a number or token`);
    return undefined;
  }

  private apply(draft: Mutable<ResolvedStyle>, block: StyleBlock, where: string): void {
    for (const k in block) {
      const raw = (block as Record<string, unknown>)[k];
      if (raw === undefined || k === "states" || k === "variants") continue;
      switch (k) {
        case "background":
        case "backgroundEnd":
        case "borderColor":
        case "foreground":
        case "accent":
        case "track":
        case "shadowColor":
        case "imageTint": {
          const c = this.color(raw as string | number, where, k);
          if (c !== undefined) (draft as Record<string, unknown>)[k] = c;
          break;
        }
        case "borderWidth":
        case "fontSize":
        case "fontWeight":
        case "lineHeight":
        case "letterSpacing":
        case "opacity":
        case "shadowOffsetX":
        case "shadowOffsetY":
        case "shadowBlur":
        case "iconSize":
        case "spacing":
        case "minWidth":
        case "minHeight": {
          const n = this.num(raw as number | string, where, k);
          if (n !== undefined) (draft as Record<string, unknown>)[k] = n;
          break;
        }
        case "padding": {
          if (typeof raw === "string") {
            const n = this.num(raw, where, k);
            if (n !== undefined) draft.padding = toInsets(n);
          } else draft.padding = toInsets(raw as InsetsInput);
          break;
        }
        case "radius": {
          if (typeof raw === "string") {
            const n = this.num(raw, where, k);
            if (n !== undefined) draft.radius = toCorners(n);
          } else draft.radius = toCorners(raw as CornersInput);
          break;
        }
        case "fontFamily": {
          const s = raw as string;
          const v = s.startsWith("$") ? this.tokenValue(s, where, k) : s;
          if (typeof v === "string") draft.fontFamily = v;
          break;
        }
        case "imageSlice":
          draft.imageSlice = raw === null ? null : internInsets(toInsets(raw as InsetsInput));
          break;
        case "custom":
          draft.custom = { ...draft.custom, ...(raw as Record<string, number | string>) };
          break;
        case "gradient":
        case "textAlign":
        case "image":
        case "icon":
        case "transition":
          (draft as Record<string, unknown>)[k] = raw;
          break;
        default:
          this.report(`prop:${where}:${k}`, "warn", `${where}: unknown style property "${k}"`);
      }
    }
  }
}

function chainOf(name: string, parentOf: (n: string) => string | undefined, exists: (n: string) => boolean, what: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = name;
  while (cur !== undefined) {
    if (!exists(cur)) throw new UsageError(`ui ${what}: "${cur}" is not registered${chain.length > 0 ? ` (extended by "${chain[0]}")` : ""}`);
    if (seen.has(cur)) throw new UsageError(`ui ${what}: inheritance cycle ${[...chain.reverse(), cur].join(" -> ")}`);
    seen.add(cur);
    chain.unshift(cur);
    cur = parentOf(cur);
  }
  return chain;
}

function mergeBlock<T extends StatefulStyleBlock>(base: T | undefined, over: T): T {
  if (!base) return over;
  const out = { ...base, ...over } as T;
  if (base.states || over.states) {
    const states: Record<string, StyleBlock> = { ...(base.states ?? {}) };
    for (const [k, v] of Object.entries(over.states ?? {})) states[k] = { ...(states[k] ?? {}), ...v };
    out.states = states;
  }
  if (base.custom || over.custom) out.custom = { ...(base.custom ?? {}), ...(over.custom ?? {}) };
  return out;
}

function mergeComponent(base: ComponentSkin | undefined, over: ComponentSkin): ComponentSkin {
  const out = mergeBlock(base, over);
  if (base?.variants || over.variants) {
    const variants: Record<string, StatefulStyleBlock> = { ...(base?.variants ?? {}) };
    for (const [k, v] of Object.entries(over.variants ?? {})) variants[k] = mergeBlock(variants[k], v);
    out.variants = variants;
  }
  return out;
}

const STYLE_KEYS = new Set([
  "background",
  "backgroundEnd",
  "gradient",
  "borderColor",
  "borderWidth",
  "radius",
  "padding",
  "foreground",
  "accent",
  "track",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "textAlign",
  "opacity",
  "shadowColor",
  "shadowOffsetX",
  "shadowOffsetY",
  "shadowBlur",
  "image",
  "imageSlice",
  "imageTint",
  "icon",
  "iconSize",
  "spacing",
  "minWidth",
  "minHeight",
  "transition",
  "custom",
]);

/** Structural validation of a theme definition (types and colour syntax). */
export function validateTheme(def: ThemeDefinition): string[] {
  const problems: string[] = [];
  if (typeof def.tokens !== "object" || def.tokens === null) return ["tokens must be an object"];
  const groups = new Set(["color", "space", "radius", "font", "fontSize", "duration", "number"]);
  for (const [group, values] of Object.entries(def.tokens)) {
    if (!groups.has(group)) {
      problems.push(`unknown token group "${group}" (known: ${[...groups].join(", ")})`);
      continue;
    }
    for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
      if (group === "color") {
        if (typeof value !== "number" && (typeof value !== "string" || tryParseColor(value) === null)) problems.push(`color.${key}: "${String(value)}" is not a colour`);
      } else if (group === "font") {
        if (typeof value !== "string") problems.push(`font.${key} must be a string`);
      } else if (typeof value !== "number" || !Number.isFinite(value)) problems.push(`${group}.${key} must be a finite number`);
    }
  }
  return problems;
}

/** Structural validation of a skin (unknown properties, unknown states, transition shape). */
export function validateSkin(def: SkinDefinition, states: StateRegistry): string[] {
  const problems: string[] = [];
  const checkBlock = (block: StatefulStyleBlock, where: string, allowStates: boolean): void => {
    for (const [k, v] of Object.entries(block)) {
      if (k === "states" && allowStates) {
        for (const [s, sb] of Object.entries(v as Record<string, StyleBlock>)) {
          if (states.bitOf(s) === 0) problems.push(`${where}.states: unknown state "${s}" (define custom states with ui.states.define before registering the skin)`);
          checkBlock(sb, `${where}.states.${s}`, false);
        }
      } else if (k === "variants" && where.split(".").length === 1) {
        for (const [vn, vb] of Object.entries(v as Record<string, StatefulStyleBlock>)) checkBlock(vb, `${where}.variants.${vn}`, true);
      } else if (!STYLE_KEYS.has(k)) problems.push(`${where}: unknown style property "${k}"`);
      else if (k === "transition") {
        for (const t of v as { duration?: unknown }[]) if (typeof t.duration !== "number" || t.duration < 0) problems.push(`${where}.transition: duration must be a number >= 0`);
      }
    }
  };
  for (const [name, comp] of Object.entries(def.components ?? {})) checkBlock(comp, name, true);
  return problems;
}
