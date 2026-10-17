/**
 * Scene save files (Phase 19.1 + 19.2): a versioned JSON document for a scene's entities, their
 * components and transforms, the scene settings (environment) and the state of its scene objects
 * (day/night, weather, terrain settings).
 *
 * The contract:
 *
 *  - **Component types are saved by registered name** (`registerComponent(..., { name })`), never by
 *    `constructor.name`, which a minifier renames. A component is written by its registration's
 *    `serialize` hook, else its own `serialize()` method, else field capture: numbers, strings,
 *    booleans, `Vec3`, `Quat`, `Double3`, `Color`, number arrays and `null`. Matrices are derived
 *    state and skipped; any other object field is either an **asset reference** (when the save's
 *    `assetId` names it — a mesh or material) or reported as dropped, never silently lost.
 *  - **Entities are keyed by their index in the file.** Parent links use the key, so duplicate or
 *    empty names round-trip. Ids are not saved: a loaded entity gets whatever id its world assigns.
 *  - **Scene objects are code, not data.** The scene that loads a save builds its own systems; the
 *    save carries their *state* (`SceneObject.saveState`) and loading hands it to the object with the
 *    same name and type (`loadState`). Missing or mismatched objects are reported.
 *  - **Loading never throws on content it cannot use.** An unregistered component type, a
 *    constructor that throws, an unresolved asset, a duplicate singleton: each is listed in the
 *    `SceneLoadReport` and the rest of the scene still loads. Only the document's own shape (not a
 *    save, a version newer than this build, no migration path) is an error.
 *  - **Versions migrate forward one step at a time** (19.2). `SCENE_SAVE_VERSION` is what this build
 *    writes; `registerSceneSaveMigration(from, fn)` upgrades a version-`from` document to `from + 1`,
 *    and `migrateSceneSave` chains them. The built-in 1 → 2 step converts the original format
 *    (parents by name, no format tag) to this one.
 */

import { UsageError } from "../core/errors.js";
import { Color } from "../math/color.js";
import { Double3 } from "../math/double3.js";
import { Mat4, Quat } from "../math/mat.js";
import { Vec3 } from "../math/vec.js";
import { tryComponentInfo, tryComponentInfoByName, type Component, type DeserializationContext, type SerializationContext } from "./components.js";
import type { Entity } from "./world.js";
import type { Scene } from "./scene.js";

export const SCENE_SAVE_FORMAT = "forge.scene";
/** The version this build writes. Older documents are migrated on load; newer ones are refused. */
export const SCENE_SAVE_VERSION = 2;

export interface SceneSaveComponent {
  /** Registered component type name. */
  type: string;
  data: Record<string, unknown>;
}

export interface SceneSaveEntity {
  /** Index of this entity in `entities`; parents refer to it. */
  key: number;
  name?: string;
  /** Key of the parent entity. */
  parent?: number;
  components: SceneSaveComponent[];
}

export interface SceneSaveObject {
  name: string;
  /** The object's class name — a check on load, not a constructor lookup (objects are built by code). */
  type: string;
  state?: Record<string, unknown>;
}

export interface SceneSave {
  format: typeof SCENE_SAVE_FORMAT;
  version: typeof SCENE_SAVE_VERSION;
  name: string;
  /** Scene settings: lighting, fog, sky, clouds, water, surface weather, shadows, post. */
  settings: Record<string, unknown>;
  objects: SceneSaveObject[];
  entities: SceneSaveEntity[];
}

/** A field that refers to a shared asset: written as `{ "$asset": { kind, id } }`. */
export interface AssetRef {
  kind: string;
  id: string;
}

export interface SceneSaveOptions {
  /** Name a shared object (geometry, material, texture) so components can refer to it. */
  assetId?(value: object, field: string, owner: object): AssetRef | undefined;
}

export interface SceneSaveReport {
  entities: number;
  components: number;
  /** Fields that could not be written (one entry per type and field). */
  dropped: { type: string; field: string; reason: string }[];
}

export interface SceneLoadOptions extends DeserializationContext {
  /**
   * Override type lookup (default: the component registry). Return undefined to fall back to the
   * registry, `null` to skip the type.
   */
  resolveType?(typeName: string): (new () => Component) | null | undefined;
}

export interface SceneLoadReport {
  /** The document's version before migration. */
  from: number;
  entities: number;
  components: number;
  skipped: { entity: number; name?: string; type: string; reason: string }[];
  unresolvedAssets: AssetRef[];
  objects: { applied: string[]; missing: string[]; mismatched: { name: string; saved: string; actual: string }[]; warnings: string[] };
}

// ------------------------------------------------------------------ migrations (19.2)

export type SceneSaveMigration = (doc: Record<string, unknown>) => Record<string, unknown>;

const migrations = new Map<number, SceneSaveMigration>();

/**
 * Register the step that upgrades a version-`from` document to `from + 1`. A later registration for
 * the same version replaces the earlier one (a fix to a shipped migration).
 */
export function registerSceneSaveMigration(from: number, migrate: SceneSaveMigration): void {
  if (!Number.isInteger(from) || from < 1 || from >= SCENE_SAVE_VERSION) {
    throw new UsageError(`registerSceneSaveMigration: version ${from} has no successor below ${SCENE_SAVE_VERSION}`);
  }
  migrations.set(from, migrate);
}

/** Bring any supported document up to `SCENE_SAVE_VERSION`. Throws on a non-save or an unsupported version. */
export function migrateSceneSave(input: unknown): { save: SceneSave; from: number } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new UsageError("Scene save: expected a JSON object");
  let doc = input as Record<string, unknown>;
  const version = doc["version"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new UsageError(`Scene save: missing or invalid version (${String(version)})`);
  }
  if (version > SCENE_SAVE_VERSION) {
    throw new UsageError(`Scene save: version ${version} was written by a newer build (this build reads up to ${SCENE_SAVE_VERSION})`);
  }
  if (version >= 2 && doc["format"] !== SCENE_SAVE_FORMAT) throw new UsageError(`Scene save: format is not "${SCENE_SAVE_FORMAT}"`);
  for (let v = version; v < SCENE_SAVE_VERSION; v++) {
    const step = migrations.get(v);
    if (!step) throw new UsageError(`Scene save: no migration from version ${v} to ${v + 1}`);
    doc = step(doc);
    if (doc["version"] !== v + 1) throw new UsageError(`Scene save: the migration from version ${v} produced version ${String(doc["version"])}`);
  }
  if (!Array.isArray(doc["entities"])) throw new UsageError("Scene save: entities is not an array");
  return { save: doc as unknown as SceneSave, from: version };
}

// Version 1 (Phase 3): { version: 1, name, settings, objects: [{name, type}], entities: [{ name?, id?,
// parent?: <parent's name>, components }] }. Parents were matched by name with the last entity of a
// name winning, so the migration resolves them the same way.
export const migrateSceneSaveV1: SceneSaveMigration = (doc) => {
  const old = (doc["entities"] as Record<string, unknown>[] | undefined) ?? [];
  const lastByName = new Map<string, number>();
  old.forEach((e, i) => {
    if (typeof e["name"] === "string" && e["name"]) lastByName.set(e["name"], i);
  });
  const entities: SceneSaveEntity[] = old.map((e, key) => {
    const parentName = e["parent"];
    const parent = typeof parentName === "string" ? lastByName.get(parentName) : undefined;
    const out: SceneSaveEntity = { key, components: (e["components"] as SceneSaveComponent[] | undefined) ?? [] };
    if (typeof e["name"] === "string" && e["name"]) out.name = e["name"];
    if (parent !== undefined && parent !== key) out.parent = parent;
    return out;
  });
  const objects = ((doc["objects"] as SceneSaveObject[] | undefined) ?? []).map((o) => ({ name: o.name, type: o.type }));
  return { format: SCENE_SAVE_FORMAT, version: 2, name: doc["name"] ?? "", settings: doc["settings"] ?? {}, objects, entities };
};
registerSceneSaveMigration(1, migrateSceneSaveV1);

// ------------------------------------------------------------------ save

export function saveScene(scene: Scene, options: SceneSaveOptions = {}): { save: SceneSave; report: SceneSaveReport } {
  const world = scene.world;
  const report: SceneSaveReport = { entities: 0, components: 0, dropped: [] };
  const droppedSeen = new Set<string>();
  const drop = (type: string, field: string, reason: string): void => {
    const k = `${type}.${field}`;
    if (droppedSeen.has(k)) return;
    droppedSeen.add(k);
    report.dropped.push({ type, field, reason });
  };
  const ctx: SerializationContext = { capture: (obj, label) => captureFields(obj, label, options, drop) };
  const ids = world.liveEntityIds();
  const keyOf = new Map<number, number>();
  ids.forEach((id, i) => keyOf.set(id as number, i));
  const entities: SceneSaveEntity[] = [];
  for (const [key, id] of ids.entries()) {
    const facade = world.facade(id)!;
    const components: SceneSaveComponent[] = [];
    for (const c of facade.components) {
      // The world only attaches registered types, so every component has a stable name.
      const info = tryComponentInfo(c.constructor)!;
      const own = (c as { serialize?: () => Record<string, unknown> }).serialize;
      const data = info.serialize ? info.serialize(c, ctx) : own ? own.call(c) : captureFields(c, info.name, options, drop);
      if ((c as { enabled?: boolean }).enabled === false) data["!disabled"] = true;
      components.push({ type: info.name, data });
      report.components++;
    }
    const entry: SceneSaveEntity = { key, components };
    const name = world.name(id);
    if (name) entry.name = name;
    const parent = keyOf.get(world.parentOf(id) as number);
    if (parent !== undefined) entry.parent = parent;
    entities.push(entry);
    report.entities++;
  }
  const objects: SceneSaveObject[] = scene.objects.map((o) => {
    const out: SceneSaveObject = { name: o.name, type: o.constructor.name };
    const state = o.saveState?.();
    if (state) out.state = state;
    return out;
  });
  return {
    save: { format: SCENE_SAVE_FORMAT, version: SCENE_SAVE_VERSION, name: scene.name, settings: scene.exportSettings(), objects, entities },
    report,
  };
}

function captureFields(
  c: object,
  type: string,
  options: SceneSaveOptions,
  drop: (type: string, field: string, reason: string) => void,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(c as unknown as Record<string, unknown>)) {
    if (key.startsWith("_") || key === "entity" || key === "enabled") continue;
    if (value === undefined || typeof value === "function") continue;
    if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "string") out[key] = value;
    else if (value instanceof Vec3) out[key] = [value.x, value.y, value.z];
    else if (value instanceof Quat) out[key] = [value.x, value.y, value.z, value.w];
    else if (value instanceof Double3) out[key] = value.toArray();
    else if (value instanceof Color) out[key] = [value.r, value.g, value.b, value.a];
    else if (value instanceof Mat4 || ArrayBuffer.isView(value)) continue; // derived (matrices, caches)
    else if (Array.isArray(value) && value.every((v) => typeof v === "number")) out[key] = [...value];
    else if (typeof value === "object") {
      const ref = options.assetId?.(value, key, c);
      if (ref) out[key] = { $asset: { kind: ref.kind, id: ref.id } };
      else drop(type, key, options.assetId ? "an object the save's assetId did not name" : "an object field and no assetId was given");
    }
  }
  return out;
}

// ------------------------------------------------------------------ load

/**
 * Apply a save onto `scene`: its settings, the state of its matching scene objects, and its
 * entities (created after any the scene already has — load into a fresh scene for a pure load).
 */
export function loadScene(scene: Scene, input: unknown, options: SceneLoadOptions = {}): SceneLoadReport {
  const { save, from } = migrateSceneSave(input);
  const report: SceneLoadReport = {
    from,
    entities: 0,
    components: 0,
    skipped: [],
    unresolvedAssets: [],
    objects: { applied: [], missing: [], mismatched: [], warnings: [] },
  };
  if (typeof save.name === "string" && save.name) scene.name = save.name;
  if (save.settings && typeof save.settings === "object") scene.importSettings(save.settings);

  for (const so of save.objects ?? []) {
    if (!so.state) continue;
    const obj = scene.object(so.name);
    if (!obj) {
      report.objects.missing.push(so.name);
      continue;
    }
    if (obj.constructor.name !== so.type) {
      report.objects.mismatched.push({ name: so.name, saved: so.type, actual: obj.constructor.name });
      continue;
    }
    if (!obj.loadState) {
      report.objects.warnings.push(`${so.name}: saved state but ${so.type} has no loadState`);
      continue;
    }
    const warnings = obj.loadState(so.state);
    if (Array.isArray(warnings)) for (const w of warnings) report.objects.warnings.push(`${so.name}: ${w}`);
    report.objects.applied.push(so.name);
  }

  const ctx: DeserializationContext = { resolveAsset: options.resolveAsset, defer: options.defer };
  ctx.apply = (target, data) => applyFields(target, data, ctx, report);
  const created = new Map<number, Entity>();
  for (const se of save.entities) {
    const entity = scene.createEntity(se.name ?? "");
    created.set(se.key, entity);
    report.entities++;
    for (const sc of se.components ?? []) {
      const skip = (reason: string): void => {
        report.skipped.push({ entity: se.key, name: se.name, type: sc.type, reason });
      };
      const info = tryComponentInfoByName(sc.type);
      const override = options.resolveType?.(sc.type);
      if (override === null) {
        skip("skipped by resolveType");
        continue;
      }
      const ctor = override ?? info?.ctor;
      if (!ctor) {
        skip("type is not registered in this build");
        continue;
      }
      let component: Component;
      try {
        component = !override && info?.create ? info.create(sc.data ?? {}) : new ctor();
        const data = sc.data ?? {};
        if (data["!disabled"] === true) (component as { enabled?: boolean }).enabled = false;
        if (!override && info?.deserialize) info.deserialize(component, data, ctx);
        else applyFields(component, data, ctx, report);
        entity.add(component);
      } catch (e) {
        skip(e instanceof Error ? e.message : String(e));
        continue;
      }
      report.components++;
    }
  }
  for (const se of save.entities) {
    if (se.parent === undefined) continue;
    const child = created.get(se.key);
    const parent = created.get(se.parent);
    if (child && parent && child !== parent) child.parent = parent;
  }
  return report;
}

function applyFields(c: object, data: Record<string, unknown>, ctx: DeserializationContext, report: SceneLoadReport): void {
  const target = c as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(data)) {
    if (key === "!disabled" || key.startsWith("_") || key === "entity") continue;
    const existing = target[key];
    const nums = Array.isArray(value) && value.every((v) => typeof v === "number") ? (value as number[]) : null;
    if (existing instanceof Vec3 && nums && nums.length >= 3) existing.set(nums[0]!, nums[1]!, nums[2]!);
    else if (existing instanceof Quat && nums && nums.length >= 4) existing.set(nums[0]!, nums[1]!, nums[2]!, nums[3]!);
    else if (existing instanceof Double3 && nums && nums.length >= 3) existing.set(nums[0]!, nums[1]!, nums[2]!);
    else if (existing instanceof Color && nums && nums.length >= 3) existing.set(nums[0]!, nums[1]!, nums[2]!, nums[3] ?? 1);
    else if (isAssetRef(value)) {
      const ref = value.$asset;
      const resolved = ctx.resolveAsset?.(ref.kind, ref.id);
      if (resolved === undefined) report.unresolvedAssets.push({ kind: ref.kind, id: ref.id });
      else target[key] = resolved;
    } else if (nums && Array.isArray(existing)) target[key] = [...nums];
    else if (existing === undefined || existing === null || value === null || typeof existing === typeof value) target[key] = value;
  }
  const hook = (c as { onDeserialized?: (data: Record<string, unknown>) => void }).onDeserialized;
  hook?.call(c, data);
}

function isAssetRef(value: unknown): value is { $asset: AssetRef } {
  if (value === null || typeof value !== "object") return false;
  const ref = (value as { $asset?: unknown }).$asset;
  return ref !== null && typeof ref === "object" && typeof (ref as AssetRef).kind === "string" && typeof (ref as AssetRef).id === "string";
}
