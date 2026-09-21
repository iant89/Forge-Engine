/**
 * `Scene` — the thing you put in an `Engine`.
 *
 * It owns an `EntityWorld` (entities/components/systems), a `CoordinateSpace` (large-world origin),
 * scene-level settings the renderer reads (ambient, fog, shadows, exposure), and a list of
 * `SceneObject`s: subsystems that are not entities (a terrain world, a particle simulation, a
 * vehicle controller group). The distinction matters: an entity is *in* the scene and gets
 * transform/culling treatment, while a scene object *runs part of the scene* and manages its own
 * entities, meshes and GPU buffers, with a lifecycle the scene drives.
 *
 * A scene is attachable to exactly one engine at a time and is safe to reuse after `onUnload`.
 */

import { EventTarget2, type Disposable } from "../core/events.js";
import { UsageError, assert } from "../core/errors.js";
import { Color } from "../math/color.js";
import { Double3 } from "../math/double3.js";
import { Vec3 } from "../math/vec.js";
import { Mat4 } from "../math/mat.js";
import { AABB, Ray, RayHit } from "../math/geometry.js";
import { CoordinateSpace } from "./coordinateSpace.js";
import { EntityWorld, type Entity } from "./world.js";
import { Camera, Light, Renderable, Transform } from "./components/index.js";
import type { SystemContext } from "./systems.js";
import type { Query } from "./stores.js";
import type { Component } from "./components.js";

export type FogMode = "none" | "linear" | "exp2" | "height";
export type ToneMapping = "none" | "reinhard" | "aces" | "filmic";

export interface SceneFogSettings {
  mode: FogMode;
  /** Linear RGB (already in the renderer's working space). */
  color: Color;
  density: number;
  start: number;
  end: number;
  /** Height fog: falloff exponent + base altitude. */
  heightFalloff: number;
  heightBase: number;
}

export interface SceneShadowSettings {
  enabled: boolean;
  /** Directional cascade count (1..4). More cascades = more shadow passes = more cost. */
  cascades: number;
  mapSize: number;
  /** Maximum distance from the camera that receives shadows. */
  distance: number;
  /** Re-render the shadow map only when the scene's shadow-relevant state changed. */
  adaptive: boolean;
}

export interface SceneSettings {
  ambientColor: Color;
  ambientIntensity: number;
  fog: SceneFogSettings;
  shadow: SceneShadowSettings;
  exposure: number;
  toneMapping: ToneMapping;
  /** Background: solid colour when `skyEnabled` is false. */
  backgroundColor: Color;
  skyEnabled: boolean;
  /** Image-based lighting intensity multiplier (0 disables IBL contribution). */
  iblIntensity: number;
  /** 0.5-1.0; below 1 the 3D pass renders at reduced resolution into an HDR target. */
  renderScale: number;
  hdr: boolean;
  postProcessing: boolean;
  /** Vertical sync / frame pacing hint for the engine loop. */
  vsync: boolean;
  /**
   * Recenter the render origin when the camera is farther than this from it (0 disables).
   * Keep this near a multiple of the terrain chunk size so recenters align with chunk loads.
   */
  recenterDistance: number;
}

export function defaultSceneSettings(): SceneSettings {
  return {
    ambientColor: new Color(0.18, 0.2, 0.24),
    ambientIntensity: 1,
    fog: {
      mode: "exp2",
      color: new Color(0.42, 0.52, 0.62),
      density: 0.0035,
      start: 40,
      end: 900,
      heightFalloff: 0.28,
      heightBase: 0,
    },
    shadow: { enabled: true, cascades: 2, mapSize: 2048, distance: 160, adaptive: true },
    exposure: 1,
    toneMapping: "aces",
    backgroundColor: new Color(0.02, 0.03, 0.05),
    skyEnabled: true,
    iblIntensity: 1,
    renderScale: 1,
    hdr: true,
    postProcessing: true,
    vsync: true,
    recenterDistance: 0,
  };
}

/**
 * A non-entity participant in a scene. The scene calls `update` after its systems run, in
 * registration order, and `dispose` when the object is removed or the scene is unloaded.
 */
export abstract class SceneObject {
  abstract readonly name: string;
  /** Set when added to a scene. */
  scene: Scene | null = null;
  enabled = true;

  onAttach?(scene: Scene): void;
  onDetach?(scene: Scene): void;
  update?(context: SystemContext, dt: number): void;
  fixedUpdate?(context: SystemContext, fixedDt: number, step: number): void;
  /** Called after the render camera's matrices are final, before the frame is submitted. */
  onPreRender?(context: SystemContext): void;
  dispose?(): void;
  stats?(): Record<string, number | string | boolean>;

  /** Raycast against this object's geometry. Return `false` when nothing was hit. */
  raycast?(_ray: Ray, _hit: RayHit): boolean;

  /** Optional: objects that want the scene to skip their entities in the default query. */
  exclusive?: boolean;
}

export interface SceneEvents {
  loaded: void;
  unloaded: void;
  settingsChanged: keyof SceneSettings | "fog" | "shadow";
}

export interface RaycastResult {
  entity: Entity | null;
  object: SceneObject | null;
  hit: RayHit;
  distance: number;
  material: unknown;
}

export class Scene {
  name: string;
  readonly world: EntityWorld;
  readonly settings: SceneSettings;
  readonly coordinateSpace: CoordinateSpace;
  readonly objects: SceneObject[] = [];
  readonly events = {
    loaded: new EventTarget2<void>(),
    unloaded: new EventTarget2<void>(),
    objectAdded: new EventTarget2<SceneObject>(),
    objectRemoved: new EventTarget2<SceneObject>(),
    settingsChanged: new EventTarget2<string>(),
  };
  /** Bumped whenever something the renderer caches (settings/objects) changes. */
  revision = 1;
  private loaded = false;
  private engineRef: object | null = null;
  private readonly disposables: Disposable[] = [];

  constructor(options: { name?: string; initialCapacity?: number; maxEntities?: number; settings?: Partial<SceneSettings> } = {}) {
    this.name = options.name ?? "Scene";
    this.world = new EntityWorld({ initialCapacity: options.initialCapacity, maxEntities: options.maxEntities });
    this.settings = { ...defaultSceneSettings(), ...options.settings, fog: { ...defaultSceneSettings().fog, ...options.settings?.fog }, shadow: { ...defaultSceneSettings().shadow, ...options.settings?.shadow } };
    this.coordinateSpace = new CoordinateSpace({ recenterDistance: this.settings.recenterDistance });
    this.coordinateSpace.bind(this.world);
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  /** @internal Set by the engine when the scene becomes active. */
  attachToEngine(engine: object | null): void {
    this.engineRef = engine;
  }

  get engine(): object | null {
    return this.engineRef;
  }

  // ------------------------------------------------------------------ entities

  createEntity(name?: string): Entity {
    return this.world.createEntity(name);
  }

  destroyEntity(entity: Entity | { id: number }): boolean {
    return this.world.destroyEntity("id" in entity ? (entity.id as never) : (entity as never));
  }

  get entityCount(): number {
    return this.world.liveEntityCount;
  }

  /** Convenience used by demos: an entity with a Transform at `position`. */
  createTransformedEntity(name: string, position: Vec3): Entity {
    const e = this.createEntity(name);
    e.add(new Transform()).setPosition(position.x, position.y, position.z);
    return e;
  }

  // ------------------------------------------------------------------ scene objects

  /** Add a scene object (terrain, particle sim, vehicle manager…). Alias: `scene.add(obj)`. */
  addObject(object: SceneObject): this {
    if (object.scene) throw new UsageError(`SceneObject "${object.name}" is already attached to a scene (remove it first)`);
    object.scene = this;
    this.objects.push(object);
    object.onAttach?.(this);
    this.revision++;
    this.events.objectAdded.emit(object);
    return this;
  }

  removeObject(object: SceneObject): boolean {
    const i = this.objects.indexOf(object);
    if (i < 0) return false;
    this.objects.splice(i, 1);
    object.onDetach?.(this);
    try {
      object.dispose?.();
    } catch (e) {
      reportSceneError(`dispose ${object.name}`, e);
    }
    object.scene = null;
    this.revision++;
    this.events.objectRemoved.emit(object);
    return true;
  }

  object<T extends SceneObject>(name: string): T | undefined {
    return this.objects.find((o) => o.name === name) as T | undefined;
  }

  /** `scene.add(terrainWorld)` reads better in demos and matches the documented API sketch. */
  add(item: SceneObject | Entity): this {
    if (item instanceof SceneObject) return this.addObject(item);
    // An entity from *another* world must not be spliced in silently — its ids would resolve
    // against the wrong store.
    throw new UsageError("Scene.add(entity) is not supported: entities are created by this scene (scene.createEntity()). Use scene.addObject() for subsystems.");
  }

  // ------------------------------------------------------------------ cameras + lights

  /** Highest-priority enabled camera entity, or null. */
  findCamera(): { entity: Entity; camera: Camera } | null {
    let best: { entity: Entity; camera: Camera } | null = null;
    const store = this.world.store(Camera);
    for (const c of store.liveValues()) {
      if (!c.enabled) continue;
      const entity = this.world.facade(c.entity);
      if (!entity) continue;
      if (!best || c.priority > best.camera.priority) best = { entity, camera: c };
    }
    return best;
  }

  /** All enabled lights (order-stable so shadow-caster assignment is deterministic). */
  collectLights(out: Light[] = []): Light[] {
    out.length = 0;
    for (const l of this.world.store(Light).liveValues()) if (l.enabled) out.push(l);
    return out;
  }

  // ------------------------------------------------------------------ settings

  setFog(mode: FogMode, options: Partial<Omit<SceneFogSettings, "mode">> = {}): this {
    const fog = this.settings.fog;
    fog.mode = mode;
    Object.assign(fog, options);
    this.onSettingsChanged("fog");
    return this;
  }

  setExposure(exposure: number): this {
    this.settings.exposure = exposure;
    this.onSettingsChanged("exposure");
    return this;
  }

  setAmbient(color: Color, intensity = 1): this {
    this.settings.ambientColor.copyFrom(color);
    this.settings.ambientIntensity = intensity;
    this.onSettingsChanged("ambientColor");
    return this;
  }

  setBackgroundColor(color: Color | number): this {
    if (typeof color === "number") this.settings.backgroundColor.setSrgbHex(color);
    else this.settings.backgroundColor.copyFrom(color);
    this.settings.skyEnabled = false;
    this.onSettingsChanged("backgroundColor");
    return this;
  }

  setShadowSettings(options: Partial<SceneShadowSettings>): this {
    Object.assign(this.settings.shadow, options);
    this.onSettingsChanged("shadow");
    return this;
  }

  private onSettingsChanged(key: keyof SceneSettings | "fog" | "shadow"): void {
    this.revision++;
    this.events.settingsChanged.emit(key);
  }

  // ------------------------------------------------------------------ queries

  query(ctors: (new (...args: never[]) => Component)[]): Query {
    return this.world.query(ctors);
  }

  // ------------------------------------------------------------------ frame

  /** @internal Called by the engine once, when this scene becomes active. */
  load(context: SystemContext): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.onLoad(context);
    } catch (e) {
      reportSceneError("onLoad", e);
    }
    this.events.loaded.emit(undefined);
  }

  /** @internal Called by the engine when switching away. */
  unload(context: SystemContext): void {
    if (!this.loaded) return;
    try {
      this.onUnload(context);
    } catch (e) {
      reportSceneError("onUnload", e);
    }
    this.loaded = false;
    this.events.unloaded.emit(undefined);
  }

  /** Override for setup: build entities, add scene objects, register systems. */
  onLoad(_context: SystemContext): void {}

  /** Override for teardown: everything added in onLoad should be released here. */
  onUnload(_context: SystemContext): void {}

  /** Track a disposable that must be released when the scene unloads (helper for onLoad code). */
  track<T extends Disposable>(d: T): T {
    this.disposables.push(d);
    return d;
  }

  update(context: SystemContext, dt: number): void {
    // Fixed-step substeps run inside the simulation systems (see systems.ts), so the scene only
    // needs one pass here; scene objects get their own fixedUpdate hook.
    for (const o of this.objects) {
      if (!o.enabled) continue;
      try {
        o.fixedUpdate?.(context, context.fixedDt, 0);
      } catch (e) {
        reportSceneError(`${o.name}.fixedUpdate`, e);
      }
    }
    this.world.runSystems(context);
    for (const o of this.objects) {
      if (!o.enabled) continue;
      try {
        o.update?.(context, dt);
      } catch (e) {
        reportSceneError(`${o.name}.update`, e);
      }
    }
  }

  /** Frame-boundary work: apply a pending origin recenter before anything reads render coords. */
  beginFrame(cameraWorldPosition: Double3 | null): void {
    if (cameraWorldPosition) this.coordinateSpace.maybeRecenter(cameraWorldPosition);
    const moved = this.coordinateSpace.applyPending();
    if (moved) {
      this.revision++;
      this.events.settingsChanged.emit("coordinateSpace");
    }
  }

  // ------------------------------------------------------------------ picking

  /**
   * Raycast scene objects first (terrain can answer much cheaper than brute-forcing triangles),
   * then entity Renderables via their world AABBs. `results` is sorted by distance.
   */
  raycast(origin: Vec3, direction: Vec3, maxDistance = Infinity, results: RaycastResult[] = []): RaycastResult[] {
    results.length = 0;
    const ray = new Ray(origin, direction, maxDistance);
    const invDir = new Vec3(1 / (direction.x || 1e-9), 1 / (direction.y || 1e-9), 1 / (direction.z || 1e-9));
    for (const o of this.objects) {
      if (!o.enabled || !o.raycast) continue;
      const hit = new RayHit();
      if (o.raycast(ray, hit)) {
        results.push({ entity: null, object: o, hit, distance: hit.distance, material: null });
      }
    }
    const local = SCRATCH_BOX;
    const worldBox = SCRATCH_BOX2;
    const query = this.world.query([Renderable]);
    query.refresh();
    for (let r = 0; r < query.count; r++) {
      const entity = this.world.facade(query.entity(r));
      const renderable = query.value(0, r) as Renderable;
      if (!renderable.visible || !entity) continue;
      renderable.resolveBounds(local);
      local.transformByMatrix(this.world.getWorldMatrix(entity.id, SCRATCH_MAT), worldBox);
      const hit = new RayHit();
      if (worldBox.intersectsRay(origin, invDir, T_MINMAX, hit) && hit.distance <= maxDistance) {
        results.push({ entity, object: null, hit, distance: hit.distance, material: renderable.material });
      }
    }
    results.sort((a, b) => a.distance - b.distance);
    return results;
  }

  // ------------------------------------------------------------------ serialization

  /**
   * Serialize to plain JSON. Entities are referenced by *name* (not id) and component types by
   * registered name, so a save file survives component reordering between builds.
   */
  serialize(): SerializedScene {
    const entities: SerializedEntity[] = [];
    for (const id of this.world.liveEntityIds()) {
      const facade = this.world.facade(id)!;
      const components: SerializedComponent[] = [];
      for (const c of facade.components) {
        components.push({ type: c.constructor.name, data: serializeComponent(c) });
      }
      const parentId = this.world.parentOf(id);
      entities.push({
        name: this.world.name(id) || undefined,
        id: id as number,
        parent: parentId === 0 ? undefined : this.world.name(parentId) || undefined,
        components,
      });
    }
    return {
      version: 1,
      name: this.name,
      settings: serializeSettings(this.settings),
      objects: this.objects.map((o) => ({ name: o.name, type: o.constructor.name })),
      entities,
    };
  }

  /**
   * Load a serialized scene. Entities are created in list order and parent links are resolved in a
   * second pass, so a parent may appear after its child in the file.
   */
  applySerialized(data: SerializedScene, resolve?: (typeName: string) => (new (...args: never[]) => Component) | undefined): void {
    assert(data.version === 1, `Scene.applySerialized: unsupported version ${data.version}`);
    if (data.name) this.name = data.name;
    if (data.settings) applySettings(this.settings, data.settings, (key) => this.onSettingsChanged(key as never));
    const byName = new Map<string, Entity>();
    const pendingParents: { child: Entity; parentName: string }[] = [];
    for (const se of data.entities) {
      const entity = this.createEntity(se.name ?? `entity${this.world.liveEntityCount}`);
      if (se.name) byName.set(se.name, entity);
      for (const sc of se.components) {
        const ctor = resolve?.(sc.type);
        if (!ctor) continue;
        const component = new ctor();
        applyComponentData(component, sc.data);
        entity.add(component);
      }
      if (se.parent) pendingParents.push({ child: entity, parentName: se.parent });
    }
    for (const p of pendingParents) {
      const parent = byName.get(p.parentName);
      if (parent) p.child.parent = parent;
    }
  }

  stats(): Record<string, number | string | boolean> {
    const out: Record<string, number | string | boolean> = {
      name: this.name,
      entities: this.world.liveEntityCount,
      components: this.world.componentCountValue,
      sceneObjects: this.objects.length,
      origin: this.coordinateSpace.origin.toString(),
      recenters: this.coordinateSpace.recenterCount,
    };
    for (const o of this.objects) {
      const s = o.stats?.();
      if (!s) continue;
      for (const [k, v] of Object.entries(s)) out[`${o.name}.${k}`] = v;
    }
    return out;
  }

  dispose(): void {
    for (const o of [...this.objects]) this.removeObject(o);
    for (const d of this.disposables.splice(0)) {
      try {
        d.dispose();
      } catch (e) {
        reportSceneError("disposable", e);
      }
    }
    for (const key of Object.keys(this.events) as (keyof typeof this.events)[]) this.events[key].clear();
    this.world.dispose();
  }
}

export interface SerializedComponent {
  type: string;
  data: Record<string, unknown>;
}

export interface SerializedEntity {
  name?: string;
  id?: number;
  parent?: string;
  components: SerializedComponent[];
}

export interface SerializedScene {
  version: 1;
  name: string;
  settings: Record<string, unknown>;
  objects: { name: string; type: string }[];
  entities: SerializedEntity[];
}

/** Fields that are safe to auto-capture: primitives and plain vectors/colours. */
function serializeComponent(c: Component): Record<string, unknown> {
  const explicit = (c as { serialize?: () => Record<string, unknown> }).serialize;
  if (explicit) return explicit.call(c);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(c as unknown as Record<string, unknown>)) {
    if (key.startsWith("_") || key === "entity" || key === "enabled") continue;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") out[key] = value;
    else if (value instanceof Vec3) out[key] = [value.x, value.y, value.z];
    else if (value instanceof Double3) out[key] = value.toArray();
    else if (value instanceof Color) out[key] = [value.r, value.g, value.b, value.a];
    // Objects (geometry, material, node refs) are resolved by the loader through `resolveAsset`.
  }
  if ((c as { enabled?: boolean }).enabled === false) out["!disabled"] = true;
  return out;
}

function applyComponentData(c: Component, data: Record<string, unknown>): void {
  const target = c as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(data)) {
    if (key === "!disabled") {
      (c as { enabled?: boolean }).enabled = false;
      continue;
    }
    const existing = target[key];
    if (existing instanceof Vec3 && Array.isArray(value) && value.length >= 3) existing.set(value[0] as number, value[1] as number, value[2] as number);
    else if (existing instanceof Color && Array.isArray(value) && value.length >= 3) existing.set(value[0] as number, value[1] as number, value[2] as number, (value[3] as number) ?? 1);
    else if (typeof existing === typeof value || existing === undefined) target[key] = value;
  }
  const hook = (c as { onDeserialized?: (data: Record<string, unknown>) => void }).onDeserialized;
  hook?.call(c, data);
}

function serializeSettings(s: SceneSettings): Record<string, unknown> {
  return {
    ambient: [s.ambientColor.r, s.ambientColor.g, s.ambientColor.b],
    ambientIntensity: s.ambientIntensity,
    exposure: s.exposure,
    toneMapping: s.toneMapping,
    skyEnabled: s.skyEnabled,
    hdr: s.hdr,
    postProcessing: s.postProcessing,
    renderScale: s.renderScale,
    iblIntensity: s.iblIntensity,
    recenterDistance: s.recenterDistance,
    fog: { mode: s.fog.mode, color: [s.fog.color.r, s.fog.color.g, s.fog.color.b], density: s.fog.density, start: s.fog.start, end: s.fog.end },
    shadow: { ...s.shadow },
  };
}

function applySettings(target: SceneSettings, data: Record<string, unknown>, changed: (key: keyof SceneSettings) => void): void {
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const vec = (v: unknown): number[] | null => (Array.isArray(v) && v.length >= 3 ? (v as number[]).slice(0, 3) : null);
  if (vec(data["ambient"])) {
    const a = vec(data["ambient"])!;
    target.ambientColor.set(a[0]!, a[1]!, a[2]!);
  }
  target.ambientIntensity = num(data["ambientIntensity"], target.ambientIntensity);
  target.exposure = num(data["exposure"], target.exposure);
  if (typeof data["toneMapping"] === "string") target.toneMapping = data["toneMapping"] as ToneMapping;
  if (typeof data["skyEnabled"] === "boolean") target.skyEnabled = data["skyEnabled"];
  if (typeof data["hdr"] === "boolean") target.hdr = data["hdr"];
  if (typeof data["postProcessing"] === "boolean") target.postProcessing = data["postProcessing"];
  target.renderScale = num(data["renderScale"], target.renderScale);
  target.iblIntensity = num(data["iblIntensity"], target.iblIntensity);
  target.recenterDistance = num(data["recenterDistance"], target.recenterDistance);
  const fog = data["fog"] as Record<string, unknown> | undefined;
  if (fog) {
    if (typeof fog["mode"] === "string") target.fog.mode = fog["mode"] as FogMode;
    const c = vec(fog["color"]);
    if (c) target.fog.color.set(c[0]!, c[1]!, c[2]!);
    target.fog.density = num(fog["density"], target.fog.density);
    target.fog.start = num(fog["start"], target.fog.start);
    target.fog.end = num(fog["end"], target.fog.end);
  }
  const shadow = data["shadow"] as Record<string, unknown> | undefined;
  if (shadow) {
    if (typeof shadow["enabled"] === "boolean") target.shadow.enabled = shadow["enabled"];
    target.shadow.cascades = Math.min(4, Math.max(1, num(shadow["cascades"], target.shadow.cascades)));
    target.shadow.mapSize = num(shadow["mapSize"], target.shadow.mapSize);
    target.shadow.distance = num(shadow["distance"], target.shadow.distance);
  }
  changed("exposure");
}

const SCRATCH_BOX = new AABB();
const SCRATCH_BOX2 = new AABB();
const SCRATCH_MAT = new Mat4();
const T_MINMAX = new Float32Array(2);

function reportSceneError(context: string, error: unknown): void {
  if (typeof console !== "undefined") console.error(`[forge:scene] ${context} failed`, error);
}

/** Re-exported so demos can set up a scene without importing the math barrel. */
export { Vec3, Color, Double3, AABB };
