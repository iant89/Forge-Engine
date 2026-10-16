/**
 * Component registry and factory.
 *
 * Built-in widgets and third-party components register the same way:
 *
 * ```ts
 * ui.components.register("InventorySlot", { create: (o) => new InventorySlot(o), properties: InventorySlot.properties });
 * const slot = ui.create("InventorySlot", { item: sword });
 * ```
 *
 * A registration is a plain factory (no reflection, no code generation) plus optional metadata:
 * property descriptors (types, defaults, validation, what a change affects, whether it animates —
 * consumed by `setProperty`, the declarative loader, the binder, the animator and the inspector),
 * a category/description for tooling, a version, aliases and the registering plugin's name.
 *
 * Collisions are errors by default; `{ onConflict: "replace" }` lets a mod override a built-in and
 * `"ignore"` keeps the first. Unregistering only affects future `create` calls — live instances
 * never reference the registry.
 */

import { UsageError } from "../../core/errors.js";
import { tryParseColor } from "./color.js";
import type { UIElement } from "./element.js";

export type PropertyType = "string" | "number" | "boolean" | "color" | "enum" | "object" | "array" | "length" | "any";

export interface PropertyDescriptor {
  name: string;
  type: PropertyType;
  default?: unknown;
  description?: string;
  /** Allowed values for `enum`. */
  values?: readonly (string | number)[];
  min?: number;
  max?: number;
  /** Extra validation; return an error message or null. */
  validate?: (value: unknown) => string | null;
  /** What a change invalidates (informational for tools; setters perform the invalidation). */
  affects?: readonly ("layout" | "style" | "render")[];
  /** May be targeted by `UIAnimator.animate` (numbers and colours). */
  animatable?: boolean;
  /** Included in declarative definitions / serialization (default true). */
  serializable?: boolean;
  /** Inspector hints. */
  editor?: { label?: string; group?: string; step?: number };
}

export interface ComponentRegistration<O = Record<string, unknown>> {
  create: (options: O) => UIElement;
  properties?: readonly PropertyDescriptor[];
  description?: string;
  category?: string;
  version?: number;
  /** Whether declarative definitions may give it `children`. */
  acceptsChildren?: boolean;
  aliases?: readonly string[];
  plugin?: string;
}

export interface RegisteredComponent {
  readonly name: string;
  readonly registration: ComponentRegistration<never>;
  readonly properties: ReadonlyMap<string, PropertyDescriptor>;
}

export type ConflictPolicy = "error" | "replace" | "ignore";

/** Options every element constructor understands (always valid in `create`). */
export const BASE_OPTION_KEYS: ReadonlySet<string> = new Set(["id", "name", "variant", "style", "layout", "visible", "enabled", "tooltip", "accessibility", "children", "strategy", "clipChildren"]);

export class ComponentRegistry {
  private readonly entries = new Map<string, RegisteredComponent>();
  private readonly aliases = new Map<string, string>();

  register<O>(name: string, registration: ComponentRegistration<O>, options: { onConflict?: ConflictPolicy } = {}): boolean {
    if (!/^[A-Za-z_][\w.-]*$/.test(name)) throw new UsageError(`ui registry: "${name}" is not a valid component name`);
    const policy = options.onConflict ?? "error";
    if (this.entries.has(name) || this.aliases.has(name)) {
      if (policy === "ignore") return false;
      if (policy === "error") throw new UsageError(`ui registry: component "${name}" is already registered${this.entries.get(name)?.registration.plugin ? ` (by ${this.entries.get(name)!.registration.plugin})` : ""}; pass { onConflict: "replace" } to override it`);
      this.unregister(this.aliases.get(name) ?? name);
    }
    const props = new Map<string, PropertyDescriptor>();
    for (const p of registration.properties ?? []) {
      if (props.has(p.name)) throw new UsageError(`ui registry: ${name} declares property "${p.name}" twice`);
      if (p.default !== undefined) {
        const err = validateProperty(p, p.default);
        if (err) throw new UsageError(`ui registry: ${name}.${p.name} default is invalid: ${err}`);
      }
      props.set(p.name, p);
    }
    for (const alias of registration.aliases ?? []) {
      if (this.entries.has(alias) || this.aliases.has(alias)) throw new UsageError(`ui registry: alias "${alias}" for ${name} collides with an existing component`);
    }
    this.entries.set(name, { name, registration: registration as ComponentRegistration<never>, properties: props });
    for (const alias of registration.aliases ?? []) this.aliases.set(alias, name);
    return true;
  }

  /** Remove a registration (and its aliases). Existing instances are unaffected. */
  unregister(name: string): boolean {
    const canonical = this.aliases.get(name) ?? name;
    const entry = this.entries.get(canonical);
    if (!entry) return false;
    this.entries.delete(canonical);
    for (const [a, target] of this.aliases) if (target === canonical) this.aliases.delete(a);
    return true;
  }

  has(name: string): boolean {
    return this.entries.has(name) || this.aliases.has(name);
  }

  get(name: string): RegisteredComponent | undefined {
    return this.entries.get(this.aliases.get(name) ?? name);
  }

  /** Construct a registered component. Unknown option keys are errors (typos fail loudly). */
  create<T extends UIElement = UIElement>(name: string, options: Record<string, unknown> = {}): T {
    const entry = this.get(name);
    if (!entry) {
      const known = [...this.entries.keys()].sort();
      const near = known.filter((k) => k.toLowerCase() === name.toLowerCase());
      throw new UsageError(`ui registry: unknown component type "${name}"${near.length ? ` (did you mean "${near[0]}"?)` : ""}; registered: ${known.join(", ")}`);
    }
    for (const [key, value] of Object.entries(options)) {
      if (BASE_OPTION_KEYS.has(key) || key.startsWith("on")) continue;
      const desc = entry.properties.get(key);
      if (!desc) {
        if (entry.properties.size > 0) throw new UsageError(`ui registry: ${entry.name} has no property "${key}" (known: ${[...entry.properties.keys()].join(", ")})`);
        continue;
      }
      const err = validateProperty(desc, value);
      if (err) throw new UsageError(`ui registry: ${entry.name}.${key}: ${err}`);
    }
    const el = entry.registration.create(options as never) as T;
    el._typeName = entry.name;
    return el;
  }

  /** Every registration, sorted by name (tooling / palettes). */
  list(): RegisteredComponent[] {
    return [...this.entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Property descriptor lookup for an instance (by its registered type). */
  propertyOf(el: UIElement, name: string): PropertyDescriptor | undefined {
    return this.get(el.typeName)?.properties.get(name);
  }

  /** Validated generic property write (declarative loader, binder, inspector). */
  setProperty(el: UIElement, name: string, value: unknown): void {
    const entry = this.get(el.typeName);
    const desc = entry?.properties.get(name);
    if (!desc) throw new UsageError(`ui registry: ${el.typeName} has no registered property "${name}"`);
    const err = validateProperty(desc, value);
    if (err) throw new UsageError(`ui registry: ${el.typeName}.${name}: ${err}`);
    (el as unknown as Record<string, unknown>)[name] = value;
  }
}

/** Validate one value against a descriptor. Returns an error message or null. */
export function validateProperty(desc: PropertyDescriptor, value: unknown): string | null {
  if (value === undefined) return null;
  switch (desc.type) {
    case "string":
      if (typeof value !== "string") return `expected a string, got ${typeof value}`;
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return `expected a finite number, got ${String(value)}`;
      if (desc.min !== undefined && value < desc.min) return `${value} is below the minimum ${desc.min}`;
      if (desc.max !== undefined && value > desc.max) return `${value} is above the maximum ${desc.max}`;
      break;
    case "boolean":
      if (typeof value !== "boolean") return `expected a boolean, got ${typeof value}`;
      break;
    case "color":
      if (typeof value === "number") break;
      if (typeof value !== "string" || tryParseColor(value) === null) return `"${String(value)}" is not a colour`;
      break;
    case "enum":
      if (!desc.values?.includes(value as string | number)) return `"${String(value)}" is not one of ${desc.values?.join(", ")}`;
      break;
    case "array":
      if (!Array.isArray(value)) return "expected an array";
      break;
    case "object":
      if (typeof value !== "object" || value === null) return "expected an object";
      break;
    case "length":
      if (typeof value === "number" ? value < 0 : typeof value !== "string" || !/^(auto|[\d.]+(%|vw|vh)?)$/.test(value)) return `"${String(value)}" is not a length`;
      break;
    default:
      break;
  }
  return desc.validate ? desc.validate(value) : null;
}
