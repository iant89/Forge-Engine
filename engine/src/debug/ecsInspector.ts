/**
 * Read-only ECS inspection data (Phase 21.2).
 *
 * This module deliberately has no DOM/UI dependency: editor panels, debug consoles and tests can
 * consume the same bounded plain-data snapshot. It never edits entities, components or systems.
 */

import { UsageError } from "../core/errors.js";
import type { Profiler } from "./profiler.js";
import type { EntityId } from "../scene/entityId.js";
import type { EntityWorld } from "../scene/world.js";
import type { ISystem } from "../scene/systems.js";

export interface EcsSystemInfo {
  name: string;
  /** Scheduler band. `runIndex` is the resolved order after before/after constraints. */
  order: number;
  runIndex: number;
  enabled: boolean;
  /** EWMA for a matching profiler scope, or null if this build has not recorded one. */
  ms: number | null;
  stats?: Record<string, number | string | boolean>;
}

export type EcsFieldValue = number | string | boolean | null | readonly number[];

export interface EcsComponentInfo {
  type: string;
  enabled: boolean;
  fields: Record<string, EcsFieldValue>;
}

export interface EcsEntityInfo {
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
  systems: EcsSystemInfo[];
  byComponent: { name: string; count: number }[];
  /** Matching entities, in world iteration order, capped by `limit`. */
  list: EcsEntityInfo[];
  truncated: boolean;
}

export interface EcsInspectOptions {
  profiler?: Profiler | null;
  /** Case-insensitive entity-name substring or component-type exact match. */
  filter?: string;
  /** Maximum number of listed entities. Defaults to 200; zero is allowed. */
  limit?: number;
}

/** Return a bounded summary of entity, component-population and system state. */
export function inspectEcs(world: EntityWorld, options: EcsInspectOptions = {}): EcsSnapshot {
  const worldStats = world.stats();
  const systems = resolveSystemOrder(world.systems).map((system, runIndex): EcsSystemInfo => {
    const scope = options.profiler?.scopeStats(system.name);
    const info: EcsSystemInfo = {
      name: system.name,
      order: system.order,
      runIndex,
      enabled: system.enabled,
      ms: scope ? scope.ewmaMs : null,
    };
    const systemStats = system.stats?.();
    if (systemStats) info.stats = { ...systemStats };
    return info;
  });

  const requestedLimit = options.limit ?? 200;
  const limit = Number.isFinite(requestedLimit) ? Math.max(0, Math.floor(requestedLimit)) : 200;
  const needle = options.filter?.trim().toLowerCase() ?? "";
  const list: EcsEntityInfo[] = [];
  let truncated = false;
  for (const id of world.liveEntityIds()) {
    const name = world.name(id);
    const types = world.componentTypesOf(id);
    if (needle && !name.toLowerCase().includes(needle) && !types.some((type) => type.toLowerCase() === needle)) continue;
    if (list.length >= limit) {
      truncated = true;
      break;
    }
    list.push(describeEntity(world, id, name, types));
  }

  return {
    generation: world.generation,
    entities: worldStats.entities,
    components: worldStats.components,
    hierarchyDepth: worldStats.hierarchyDepth,
    systems,
    byComponent: worldStats.byComponent.map((entry) => ({ ...entry })),
    list,
    truncated,
  };
}

/** Detailed component field view for one live entity; returns null for a stale/destroyed id. */
export function inspectEntity(world: EntityWorld, id: EntityId): EcsEntityInfo & { detail: EcsComponentInfo[] } | null {
  if (!world.exists(id)) return null;
  const types = world.componentTypesOf(id);
  const detail = world.componentsOf(id).map((component, index): EcsComponentInfo => ({
    type: types[index] ?? component.constructor.name,
    enabled: component.enabled,
    fields: summariseEcsFields(component),
  }));
  return { ...describeEntity(world, id, world.name(id), types), detail };
}

/**
 * Keep scalar values, short numeric arrays and common vector/quaternion shapes; skip engine
 * internals and arbitrary object graphs. This avoids exposing mutable component objects to tools.
 */
export function summariseEcsFields(value: object, maxArray = 16): Record<string, EcsFieldValue> {
  const arrayLimit = Number.isFinite(maxArray) ? Math.max(0, Math.floor(maxArray)) : 16;
  const out: Record<string, EcsFieldValue> = {};
  for (const [key, field] of Object.entries(value)) {
    if (key === "enabled" || key === "entity" || key.startsWith("_")) continue;
    if (field === null || typeof field === "number" || typeof field === "string" || typeof field === "boolean") {
      out[key] = field;
    } else if (ArrayBuffer.isView(field) && !(field instanceof DataView) && (field as unknown as ArrayLike<number>).length <= arrayLimit) {
      out[key] = Array.from(field as unknown as ArrayLike<number>, Number);
    } else if (Array.isArray(field) && field.length <= arrayLimit && field.every((item) => typeof item === "number")) {
      out[key] = [...field] as number[];
    } else if (isVectorLike(field)) {
      out[key] = typeof field.w === "number"
        ? [field.x, field.y, field.z!, field.w]
        : typeof field.z === "number"
          ? [field.x, field.y, field.z]
          : [field.x, field.y];
    }
  }
  return out;
}

function isVectorLike(value: unknown): value is { x: number; y: number; z?: number; w?: number } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { x?: unknown; y?: unknown; z?: unknown; w?: unknown };
  return typeof v.x === "number" && typeof v.y === "number" && (v.z === undefined || typeof v.z === "number") && (v.w === undefined || (typeof v.z === "number" && typeof v.w === "number"));
}

function resolveSystemOrder(systems: readonly ISystem[]): ISystem[] {
  const list = [...systems].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  let changed = true;
  let passes = 0;
  while (changed) {
    changed = false;
    if (++passes > list.length * list.length + 4) {
      throw new UsageError(`System ordering cycle among: ${list.map((system) => system.name).join(", ")}`);
    }
    outer: for (let i = 0; i < list.length; i++) {
      for (const dependency of list[i]!.after ?? []) {
        const j = list.findIndex((system) => system.name === dependency);
        if (j > i) {
          moveSystem(list, j, i);
          changed = true;
          break outer;
        }
      }
      for (const dependency of list[i]!.before ?? []) {
        const j = list.findIndex((system) => system.name === dependency);
        if (j >= 0 && j < i) {
          moveSystem(list, i, j);
          changed = true;
          break outer;
        }
      }
    }
  }
  return list;
}

function moveSystem(list: ISystem[], from: number, to: number): void {
  const [system] = list.splice(from, 1);
  list.splice(to, 0, system!);
}

function describeEntity(world: EntityWorld, id: EntityId, name: string, components: string[]): EcsEntityInfo {
  let position: EcsEntityInfo["position"] = null;
  if (world.hasTransform(id)) {
    const p = world.worldPosition(id);
    position = [p.x, p.y, p.z];
  }
  return { id, name, parent: world.parentOf(id), children: world.childrenOf(id).length, position, components };
}
