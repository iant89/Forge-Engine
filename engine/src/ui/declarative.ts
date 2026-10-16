/**
 * Declarative UI definitions (JSON).
 *
 * ```json
 * { "version": 1, "type": "Panel", "id": "status", "layout": { "width": 320 }, "props": { "gap": 8 },
 *   "children": [
 *     { "type": "Label", "props": { "textKey": "hud.status" }, "variant": "heading" },
 *     { "type": "HealthBar", "bind": { "value": "player.health", "max": "player.maxHealth" } },
 *     { "type": "Button", "props": { "text": "Respawn" }, "on": { "press": "respawn" } } ] }
 * ```
 *
 * Safety: definitions are data. Event handlers are **names** looked up in a handler table the code
 * supplies; bindings name stores the code supplies; converters are named functions the code
 * supplies. Nothing in a definition is ever evaluated, so a definition from a mod or a file cannot
 * run code.
 *
 * Validation (`validateUIDefinition`) collects every problem with a JSON path before anything is
 * built: unknown types (with a "did you mean"), properties not declared by the component (types,
 * ranges and enum values checked against its descriptors), children on components that take none,
 * unknown handlers/stores/fields/converters, malformed layout or style, unsupported versions.
 * Missing assets are reported as warnings (they may load later). `buildUI` throws a `UsageError`
 * listing all errors, or returns the tree, an id map, its bindings and a `replace()` for hot reload.
 */

import { UsageError } from "../core/errors.js";
import type { Disposable } from "../core/events.js";
import type { UIElement } from "./core/element.js";
import { UIContainer } from "./core/container.js";
import { BASE_OPTION_KEYS, validateProperty } from "./core/registry.js";
import { applyLayoutInput, defaultLayoutProps, type LayoutPropsInput } from "./layout/types.js";
import type { StyleBlock } from "./style/types.js";
import { validateSkin } from "./style/resolver.js";
import type { FieldSource } from "./data/binding.js";
import type { UIManager } from "./manager.js";
import type { UIEvent } from "./input/events.js";
import type { ResponsiveRules } from "./responsive.js";

export const UI_DEFINITION_VERSION = 1;

export interface UIDefinition {
  version?: number;
  type: string;
  id?: string;
  name?: string;
  variant?: string;
  props?: Record<string, unknown>;
  layout?: LayoutPropsInput;
  style?: StyleBlock;
  children?: UIDefinition[];
  /** event type → handler name (`press`, `click`, `change`, `select`, …). */
  on?: Record<string, string>;
  /** property → `"store.field"` or `{ source, mode, convert, convertBack }` (converter names). */
  bind?: Record<string, string | { source: string; mode?: "one-way" | "two-way"; convert?: string; convertBack?: string }>;
  /** Per-breakpoint rules (layout/visible/variant/style only). */
  responsive?: ResponsiveRules;
}

export interface UIBuildContext {
  ui: UIManager;
  handlers?: Record<string, (event: UIEvent, element: UIElement) => void>;
  stores?: Record<string, FieldSource>;
  converters?: Record<string, (value: unknown) => unknown>;
}

export interface ValidationReport {
  errors: string[];
  warnings: string[];
}

export interface UIBuildResult {
  root: UIElement;
  byId: Map<string, UIElement>;
  /** Subscriptions created for `on`/`bind`/`responsive` (also owned by their elements). */
  disposables: Disposable[];
  warnings: string[];
  /** Hot reload: build `next` and swap it in at the same place in the tree. */
  replace(next: UIDefinition): UIBuildResult;
  dispose(): void;
}

const ASSET_PROPS = new Set(["icon", "source", "map"]);

/** Levenshtein distance (typo suggestions for unknown component names). */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

export function validateUIDefinition(def: unknown, ctx: UIBuildContext): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();
  const registry = ctx.ui.components;
  const visit = (node: unknown, path: string): void => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      errors.push(`${path}: expected an object`);
      return;
    }
    const d = node as UIDefinition;
    const known = new Set(["version", "type", "id", "name", "variant", "props", "layout", "style", "children", "on", "bind", "responsive"]);
    for (const k of Object.keys(d)) if (!known.has(k)) errors.push(`${path}.${k}: unknown key (allowed: ${[...known].join(", ")})`);
    if (d.version !== undefined && d.version > UI_DEFINITION_VERSION) errors.push(`${path}.version: ${d.version} is newer than this engine supports (${UI_DEFINITION_VERSION})`);
    if (typeof d.type !== "string") {
      errors.push(`${path}.type: required string`);
      return;
    }
    const entry = registry.get(d.type);
    if (!entry) {
      const want = d.type.toLowerCase();
      const near = registry
        .list()
        .map((r) => ({ name: r.name, d: editDistance(r.name.toLowerCase(), want) }))
        .filter((x) => x.d <= Math.max(1, Math.floor(want.length / 4)))
        .sort((a, b) => a.d - b.d)
        .map((x) => x.name);
      errors.push(`${path}.type: unknown component "${d.type}"${near.length ? ` (did you mean ${near.slice(0, 3).map((n) => `"${n}"`).join(", ")}?)` : ""}`);
      return;
    }
    if (d.id !== undefined) {
      if (typeof d.id !== "string" || !d.id) errors.push(`${path}.id: must be a non-empty string`);
      else if (ids.has(d.id)) errors.push(`${path}.id: duplicate id "${d.id}"`);
      else ids.add(d.id);
    }
    for (const [k, v] of Object.entries(d.props ?? {})) {
      if (BASE_OPTION_KEYS.has(k)) {
        errors.push(`${path}.props.${k}: set "${k}" at the node level, not in props`);
        continue;
      }
      const desc = entry.properties.get(k);
      if (!desc) {
        errors.push(`${path}.props.${k}: ${entry.name} has no property "${k}"`);
        continue;
      }
      if (typeof v === "function") errors.push(`${path}.props.${k}: functions are not allowed in definitions (use "on" with a handler name)`);
      const err = validateProperty(desc, v);
      if (err) errors.push(`${path}.props.${k}: ${err}`);
      if (ASSET_PROPS.has(k) && typeof v === "string" && v && !ctx.ui.assets.resolve(v) && !ctx.ui.assets.glyphIcon(v)) warnings.push(`${path}.props.${k}: asset "${v}" is not registered (yet)`);
    }
    if (d.layout !== undefined) {
      try {
        applyLayoutInput(defaultLayoutProps(), d.layout);
      } catch (e) {
        errors.push(`${path}.layout: ${(e as Error).message}`);
      }
    }
    if (d.style !== undefined) {
      for (const p of validateSkin({ name: "inline", version: 1, components: { [d.type]: d.style } }, ctx.ui.resolver.states)) errors.push(`${path}.style: ${p}`);
    }
    for (const [ev, handler] of Object.entries(d.on ?? {})) {
      if (typeof handler !== "string") errors.push(`${path}.on.${ev}: handler must be a name`);
      else if (!ctx.handlers?.[handler]) errors.push(`${path}.on.${ev}: no handler named "${handler}" was supplied`);
    }
    for (const [prop, b] of Object.entries(d.bind ?? {})) {
      const spec = typeof b === "string" ? { source: b } : b;
      const [store, field] = spec.source.split(".");
      if (!store || !field) errors.push(`${path}.bind.${prop}: source must be "store.field"`);
      else if (!ctx.stores?.[store]) errors.push(`${path}.bind.${prop}: no store named "${store}" was supplied`);
      else if (!ctx.stores[store]!.has(field)) errors.push(`${path}.bind.${prop}: store "${store}" has no field "${field}"`);
      if (!entry.properties.has(prop)) errors.push(`${path}.bind.${prop}: ${entry.name} has no bindable property "${prop}"`);
      for (const c of [typeof b === "object" ? b.convert : undefined, typeof b === "object" ? b.convertBack : undefined]) if (c && !ctx.converters?.[c]) errors.push(`${path}.bind.${prop}: no converter named "${c}"`);
    }
    if (d.children !== undefined) {
      if (!Array.isArray(d.children)) errors.push(`${path}.children: must be an array`);
      else if (!entry.registration.acceptsChildren) errors.push(`${path}.children: ${entry.name} does not accept children`);
      else d.children.forEach((c, i) => visit(c, `${path}.children[${i}]`));
    }
  };
  visit(def, "$");
  return { errors, warnings };
}

export function buildUI(def: UIDefinition, ctx: UIBuildContext): UIBuildResult {
  const report = validateUIDefinition(def, ctx);
  if (report.errors.length > 0) throw new UsageError(`ui definition is invalid:\n  ${report.errors.join("\n  ")}`, report);
  const byId = new Map<string, UIElement>();
  const disposables: Disposable[] = [];
  const ui = ctx.ui;

  const build = (d: UIDefinition): UIElement => {
    const options: Record<string, unknown> = { ...(d.props ?? {}) };
    if (d.id) options.id = d.id;
    if (d.name) options.name = d.name;
    if (d.variant) options.variant = d.variant;
    if (d.layout) options.layout = d.layout;
    if (d.style) options.style = d.style;
    const el = ui.create(d.type, options);
    if (d.id) byId.set(d.id, el);
    for (const [ev, name] of Object.entries(d.on ?? {})) {
      const fn = ctx.handlers![name]!;
      disposables.push(el.on(ev, (e) => fn(e, el)));
    }
    for (const [prop, b] of Object.entries(d.bind ?? {})) {
      const spec = typeof b === "string" ? { source: b } : b;
      const [store, field] = spec.source.split(".") as [string, string];
      const convert = spec.convert ? ctx.converters![spec.convert] : undefined;
      const convertBack = spec.convertBack ? ctx.converters![spec.convertBack] : undefined;
      disposables.push(ui.bind(el, prop, [ctx.stores![store]!, field], { mode: spec.mode ?? "one-way", convert, convertBack }));
    }
    if (d.responsive) disposables.push(ui.responsive(el, d.responsive));
    for (const child of d.children ?? []) {
      const c = build(child);
      const adder = (el as unknown as { add?: (c: UIElement) => UIElement }).add;
      if (el instanceof UIContainer || typeof adder === "function") (adder ?? (el as UIContainer).add).call(el, c);
    }
    return el;
  };

  const root = build(def);
  const result: UIBuildResult = {
    root,
    byId,
    disposables,
    warnings: report.warnings,
    replace(next: UIDefinition): UIBuildResult {
      const parent = root.parent;
      const index = parent ? parent.children.indexOf(root) : -1;
      const rebuilt = buildUI(next, ctx);
      if (parent instanceof UIContainer) parent.insert(rebuilt.root, index);
      result.dispose();
      return rebuilt;
    },
    dispose(): void {
      for (const d of disposables) d.dispose();
      disposables.length = 0;
      root.dispose();
    },
  };
  for (const w of report.warnings) ui.diagnostic("warn", `ui definition: ${w}`);
  return result;
}
