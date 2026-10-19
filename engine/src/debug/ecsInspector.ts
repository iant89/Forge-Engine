/**
 * ECS inspector (Phase 21.2): a plain-data view of an `EntityWorld` for overlays, the console and
 * tests — systems in run order with their profiler time, component populations, and entities with
 * their name, hierarchy, world position and components.
 *
 * Read-only by contract: nothing here mutates the world (toggling a system is the caller's
 * `system.enabled = false`). Component fields are summarised from own enumerable values (internal
 * `_`-prefixed ones skipped) — numbers,
 * strings, booleans, short typed arrays and `{x,y,z}` vectors — so the view works for user
 * components without each one implementing a describe hook.
 */

import type { Profiler } from "./profiler.js";
import { profileLabel } from "./frameBreakdown.js";
import type { EntityWorld } from "../scene/world.js";
import type { EntityId } from "../scene/entityId.js";

export interface SystemInfo {
  name: string;
  order: number;
  enabled: boolean;
  /** Profiler scope label, `<category>:<name>`. */
  label: string;
  /** EWMA ms of the last runs; 0 when no profiler or never run. */
  ms: number;
  stats?: Record<string, number | string | boolean>;
}

export type FieldValue = number | string | boolean | null | readonly number[];

export interface ComponentInfo {
  type: string;
  enabled: boolean;
  fields: Record<string, FieldValue>;
}

export interface EntityInfo {
  id: EntityId;
  name: string;
  parent: EntityId;
  children: number;
  position: [number, number, number] | null;
  components: string[];
}

export interface EcsSnapshot {
  generation: number;
  entities: number;
  components: number;
  hierarchyDepth: number;
  systems: SystemInfo[];
  byComponent: { name: string; count: number }[];
  /** The listed entities (filtered, capped at `limit`). */
  list: EntityInfo[];
  /** True when `limit` cut the list. */
  truncated: boolean;
}

export interface EcsInspectOptions {
  profiler?: Profiler | null;
  /** Keep entities whose name contains this (case-insensitive) or that carry this component type. */
  filter?: string;
  /** Max entities listed. Default 200. */
  limit?: number;
}

/** Systems, populations and an entity list. Cost is O(entities) for the list. */
export function inspectEcs(world: EntityWorld, options: EcsInspectOptions = {}): EcsSnapshot {
  world.sortSystems();
  const stats = world.stats();
  const systems = world.systems.map((s): SystemInfo => {
    const label = profileLabel(s);
    const info: SystemInfo = { name: s.name, order: s.order, enabled: s.enabled, label, ms: options.profiler?.scopeStats(label)?.ewmaMs ?? 0 };
    const extra = s.stats?.();
    if (extra) info.stats = extra;
    return info;
  });
  const limit = options.limit ?? 200;
  const needle = options.filter?.toLowerCase() ?? "";
  const list: EntityInfo[] = [];
  let truncated = false;
  for (const id of world.liveEntityIds()) {
    const name = world.name(id);
    const types = world.componentTypesOf(id);
    if (needle && !name.toLowerCase().includes(needle) && !types.some((t) => t.toLowerCase() === needle)) continue;
    if (list.length >= limit) {
      truncated = true;
      break;
    }
    list.push(describeEntity(world, id, name, types));
  }
  return { generation: world.generation, entities: stats.entities, components: stats.components, hierarchyDepth: stats.hierarchyDepth, systems, byComponent: stats.byComponent, list, truncated };
}

function describeEntity(world: EntityWorld, id: EntityId, name: string, types: string[]): EntityInfo {
  let position: EntityInfo["position"] = null;
  if (world.hasTransform(id)) {
    const p = world.worldPosition(id);
    position = [p.x, p.y, p.z];
  }
  return { id, name, parent: world.parentOf(id), children: world.childrenOf(id).length, position, components: types };
}

/** One entity in detail: its summary plus every component's fields. Null when it is gone. */
export function inspectEntity(world: EntityWorld, id: EntityId): (EntityInfo & { detail: ComponentInfo[] }) | null {
  if (!world.exists(id)) return null;
  const types = world.componentTypesOf(id);
  const detail = world.componentsOf(id).map((c, i): ComponentInfo => ({ type: types[i] ?? c.constructor.name, enabled: c.enabled, fields: summariseFields(c) }));
  return { ...describeEntity(world, id, world.name(id), types), detail };
}

/** Own enumerable fields reduced to displayable values; objects and long arrays are skipped. */
export function summariseFields(value: object, maxArray = 16): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === "enabled" || key === "entity" || key.startsWith("_")) continue;
    if (v === null || typeof v === "number" || typeof v === "string" || typeof v === "boolean") out[key] = v;
    else if (ArrayBuffer.isView(v) && !(v instanceof DataView) && (v as unknown as ArrayLike<number>).length <= maxArray) out[key] = Array.from(v as unknown as ArrayLike<number>, Number);
    else if (Array.isArray(v) && v.length <= maxArray && v.every((x) => typeof x === "number")) out[key] = v as number[];
    else if (typeof v === "object" && v !== null && typeof (v as { x?: unknown }).x === "number" && typeof (v as { y?: unknown }).y === "number") {
      const o = v as { x: number; y: number; z?: unknown; w?: unknown };
      out[key] = typeof o.z === "number" ? (typeof o.w === "number" ? [o.x, o.y, o.z, o.w] : [o.x, o.y, o.z]) : [o.x, o.y];
    }
  }
  return out;
}
