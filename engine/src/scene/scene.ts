/**
 * `Scene` — the thing you put in an `Engine`.
 *
 * It owns an `EntityWorld` (entities/components/systems), a `CoordinateSpace` (large-world origin),
 * scene-level settings the renderer reads (ambient, fog, sky, shadows, exposure), and a list of
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
import type { AtmosphereParams } from "../environment/atmosphere.js";

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
  /** Requested resolution per cascade; the engine's quality profile caps it. */
  mapSize: number;
  /** Maximum distance from the camera that receives shadows. */
  distance: number;
  /** Re-render the shadow map only when the scene's shadow-relevant state changed. */
  adaptive: boolean;
  /** Cascade split scheme: 0 = uniform, 1 = logarithmic (practical split blend). */
  splitLambda: number;
  /** Tint surfaces by the cascade that shadows them (red, green, blue, yellow). */
  debugCascades: boolean;
}

export interface SceneBloomSettings {
  enabled: boolean;
  /** Brightness (after exposure) above which light bleeds; 1 = display white. */
  threshold: number;
  /** Soft-knee width as a fraction of the threshold (0 = hard cut). */
  softKnee: number;
  /** Strength of the bloom added at composite. */
  intensity: number;
  /** Upsample filter radius in source texels (1 = classic tent). */
  radius: number;
}

/**
 * Screen-space ambient occlusion (`forge.ssao`): contact darkening in creases and under objects,
 * estimated from the depth prepass at half resolution and applied to the ambient term only.
 */
export interface SceneSsaoSettings {
  enabled: boolean;
  /** World-space sampling radius in metres: how far away an occluder can still darken a point. */
  radius: number;
  /** Strength multiplier (1 = the estimator's natural scale). */
  intensity: number;
  /** Occluders closer than this (metres) to a point's tangent plane are ignored; fights self-occlusion. */
  bias: number;
  /** Taps per pixel (1..32). The half-resolution estimate plus the blur make 12 enough. */
  samples: number;
}

export type SkyQuality = "low" | "medium" | "high";

/**
 * The analytic sky (Phase 8a). Rendered by the `forge.sky` pass when `SceneSettings.skyEnabled` is
 * true; the atmosphere constants come from `atmosphere` (Earth when `null`) and the knobs below
 * scale them. `DayNightCycle` writes `sunDirection` every frame; without a cycle the renderer takes
 * the sun from the first directional light.
 */
export interface SceneSkySettings {
  /** Unit vector *toward* the sun in render axes; `null` = derive from the first directional light. */
  sunDirection: Vec3 | null;
  /** Sun irradiance at the top of the atmosphere in scene units (drives the sky's brightness). */
  sunIntensity: number;
  /** Extra multiplier on the sky radiance (not on the lights). */
  exposure: number;
  /** Preetham-style haze: 2 = very clear, 10 = hazy. Scales the Mie coefficients by `turbidity / 2`. */
  turbidity: number;
  /** Multipliers on the preset's Rayleigh / Mie coefficients. */
  rayleigh: number;
  mie: number;
  /** Angular radius of the sun disc, radians (the real sun is 0.00465). */
  sunAngularRadius: number;
  /** Disc radiance relative to `sunIntensity × transmittance`; the physical value (~14 700) would bloom the frame. */
  sunDiscIntensity: number;
  /** Star field brightness (0 disables) — only visible when the sky is dark. */
  starBrightness: number;
  /** Render stars and the night sky when the sun is down. */
  nightEnabled: boolean;
  /** Render-local height of the planet's surface (the camera's altitude is measured from it). */
  seaLevel: number;
  /** Ray-march sample counts: low 8×4, medium 16×8, high 32×16 (view × light). */
  quality: SkyQuality;
  /** Planet + atmosphere constants; `null` uses `EARTH_ATMOSPHERE`. */
  atmosphere: AtmosphereParams | null;
}

/**
 * One procedural cloud deck, drawn inside the `forge.sky` pass (Phase 8b). The density field is a
 * pure function of world XZ (`environment/clouds.ts`); the lighting (sun/ambient/horizon tints)
 * is derived per frame from the 8a atmosphere by the renderer, so clouds track the day/night
 * cycle with no extra wiring. `WeatherSystem` writes `coverage` when its `driveClouds` is on.
 */
export interface SceneCloudSettings {
  /** Master switch (when false the shader early-outs and the lighting cache is not evaluated). */
  enabled: boolean;
  /** Fraction of the sky covered, 0..1 (0 = clear). */
  coverage: number;
  /** Vertical optical thickness 0..1 (thin cirrus → thunderhead). */
  density: number;
  /** Deck altitude above sea level, metres. */
  height: number;
  /** World metres per noise unit (smaller = larger clouds). */
  scale: number;
  /** Deterministic seed of the coverage field. */
  seed: number;
  /** Forward-scattering (silver lining) strength around the sun, 0..2. */
  silverLining: number;
  /** Mean wind advecting the deck, m/s (+x east, +z north); written by `WeatherSystem`. */
  windX: number;
  windZ: number;
  /** Cloud albedo (linear RGB). */
  albedo: Color;
}

/** One Gerstner component of the water surface (see `environment/water.ts`). */
export interface WaterWaveParams {
  directionX: number;
  directionZ: number;
  wavelength: number;
  amplitude: number;
  speed: number;
  steepness: number;
  phase: number;
}

/**
 * The water surface (Phase 8b). `WaterSurface` owns the mesh and advances `time`; the renderer
 * reads this block for the water program's uniforms and for the underwater path (camera below
 * `level` skips the sky pass and swaps the fog for the murk).
 */
export interface SceneWaterSettings {
  /** Master switch (set by `WaterSurface` on attach; without it there is no water mesh). */
  enabled: boolean;
  /** Mean water level in render-local Y. */
  level: number;
  /** Edge length of the water plane in metres (informational for tools; the mesh owns it). */
  size: number;
  /** Simulated water time in seconds (advanced on the fixed-step clock). */
  time: number;
  /** Deep/shallow/foam/murk colours (linear RGB). */
  deepColor: Color;
  shallowColor: Color;
  foamColor: Color;
  murkColor: Color;
  /** Fog density applied while the camera is underwater. */
  murkDensity: number;
  /** Surface opacity 0..1. */
  opacity: number;
  /** Sun-glint strength multiplier. */
  sunGlint: number;
  /** Crest value where whitecap foam starts (0..1). */
  foamThreshold: number;
  /** Gerstner components (up to 4 reach the shader; amplitude 0 disables). */
  waves: WaterWaveParams[];
}

export interface SceneSettings {
  ambientColor: Color;
  ambientIntensity: number;
  fog: SceneFogSettings;
  shadow: SceneShadowSettings;
  sky: SceneSkySettings;
  clouds: SceneCloudSettings;
  water: SceneWaterSettings;
  exposure: number;
  toneMapping: ToneMapping;
  /** Background: solid colour when `skyEnabled` is false. */
  backgroundColor: Color;
  /** Draw the analytic sky (`forge.sky`) behind the geometry instead of `backgroundColor`. */
  skyEnabled: boolean;
  /** Image-based lighting intensity multiplier (0 disables IBL contribution). */
  iblIntensity: number;
  /** 0.5-1.0; below 1 the 3D pass renders at reduced resolution into an HDR target. */
  renderScale: number;
  /**
   * Render into a float HDR target and resolve through the post chain (exposure, bloom, tone curve,
   * sRGB encode). When false the forward pass writes the swapchain directly and applies exposure +
   * tone mapping in-shader; bloom is unavailable on that path.
   */
  hdr: boolean;
  /** Master switch for the post chain's effects (bloom); HDR resolve still runs when `hdr` is set. */
  postProcessing: boolean;
  bloom: SceneBloomSettings;
  /**
   * Lay the opaque scene's depth down in a depth-only pass (`forge.prepass`) before `forge.main`,
   * which then shades each visible pixel once: prepassed draws test `less-equal` against that
   * buffer without writing it. SSAO reads the same buffer, so it needs this on. Quality profiles
   * can veto it (`RendererOptions.depthPrepass`).
   */
  depthPrepass: boolean;
  /** Ambient occlusion from the prepass depth; ignored while `depthPrepass` is off. */
  ssao: SceneSsaoSettings;
  /**
   * Clustered (Forward+) lighting. Local (point/spot) lights are gathered into a 16×8×24 grid of
   * view-space clusters and each fragment evaluates only the lights in its own cluster, instead of
   * every fragment walking one fixed 16-entry uniform list. The light maths is the shared one, so a
   * frame is pixel-identical either way while the caps do not bite; what changes is the budget —
   * `MAX_CLUSTERED_LIGHTS` (256) local lights per frame and `MAX_LIGHTS_PER_CLUSTER` (32) per
   * cluster, instead of 16 lights per scene. Directional lights reach every pixel and stay in the
   * uniform list. Ignored for orthographic cameras (their `clip.w` is not a view depth, the same
   * reason SSAO is perspective-only) and when the scene has no local lights at all. Quality profiles
   * can veto it (`RendererOptions.clusteredLighting`).
   */
  clusteredLighting: boolean;
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
    // Fog is opt-in (`setFog`); the other values are a sensible preset for when it is turned on.
    fog: {
      mode: "none",
      color: new Color(0.42, 0.52, 0.62),
      density: 0.0035,
      start: 40,
      end: 900,
      heightFalloff: 0.28,
      heightBase: 0,
    },
    shadow: { enabled: true, cascades: 3, mapSize: 2048, distance: 160, adaptive: true, splitLambda: 0.6, debugCascades: false },
    sky: defaultSkySettings(),
    clouds: defaultCloudSettings(),
    water: defaultWaterSettings(),
    exposure: 1,
    toneMapping: "aces",
    backgroundColor: new Color(0.02, 0.03, 0.05),
    skyEnabled: true,
    iblIntensity: 1,
    renderScale: 1,
    hdr: true,
    postProcessing: true,
    bloom: { enabled: true, threshold: 1, softKnee: 0.5, intensity: 0.06, radius: 1 },
    depthPrepass: true,
    ssao: { enabled: true, radius: 1, intensity: 1, bias: 0.02, samples: 12 },
    clusteredLighting: true,
    vsync: true,
    recenterDistance: 0,
  };
}

export function defaultSkySettings(): SceneSkySettings {
  return {
    sunDirection: null,
    sunIntensity: 20,
    exposure: 1,
    turbidity: 2,
    rayleigh: 1,
    mie: 1,
    sunAngularRadius: 0.00465,
    sunDiscIntensity: 100,
    starBrightness: 1,
    nightEnabled: true,
    seaLevel: 0,
    quality: "medium",
    atmosphere: null,
  };
}

/** A clear sky: the deck is enabled but covers nothing, so existing scenes render unchanged. */
export function defaultCloudSettings(): SceneCloudSettings {
  return {
    enabled: true,
    coverage: 0,
    density: 0.8,
    height: 1500,
    scale: 0.0008,
    seed: 4242,
    silverLining: 0.8,
    windX: 2,
    windZ: 1,
    albedo: new Color(1, 1, 1),
  };
}

export function defaultWaterWave(): WaterWaveParams {
  return { directionX: 1, directionZ: 0.3, wavelength: 28, amplitude: 0.22, speed: 3.2, steepness: 0.35, phase: 0 };
}

/** Still, switched-off water: a gentle two-wave swell that `WaterSurface` enables on attach. */
export function defaultWaterSettings(): SceneWaterSettings {
  return {
    enabled: false,
    level: 0,
    size: 500,
    time: 0,
    deepColor: new Color(0.015, 0.09, 0.13),
    shallowColor: new Color(0.06, 0.28, 0.3),
    foamColor: new Color(0.9, 0.95, 0.95),
    murkColor: new Color(0.02, 0.12, 0.14),
    murkDensity: 0.08,
    opacity: 0.92,
    sunGlint: 1,
    foamThreshold: 0.72,
    waves: [
      { directionX: 1, directionZ: 0.3, wavelength: 28, amplitude: 0.22, speed: 3.2, steepness: 0.35, phase: 0 },
      { directionX: 0.7, directionZ: -0.7, wavelength: 13, amplitude: 0.1, speed: 2.4, steepness: 0.3, phase: 1.7 },
      { directionX: 0.2, directionZ: 1, wavelength: 6, amplitude: 0.045, speed: 1.8, steepness: 0.25, phase: 4.1 },
      { directionX: -0.5, directionZ: 0.8, wavelength: 2.8, amplitude: 0.02, speed: 1.3, steepness: 0.2, phase: 2.3 },
    ],
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
    const defaults = defaultSceneSettings();
    this.settings = {
      ...defaults,
      ...options.settings,
      fog: { ...defaults.fog, ...options.settings?.fog },
      shadow: { ...defaults.shadow, ...options.settings?.shadow },
      sky: { ...defaults.sky, ...options.settings?.sky },
    };
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

  /** Solid background colour; turns the sky pass off (`setSky` turns it back on). */
  setBackgroundColor(color: Color | number): this {
    if (typeof color === "number") this.settings.backgroundColor.setSrgbHex(color);
    else this.settings.backgroundColor.copyFrom(color);
    this.settings.skyEnabled = false;
    this.onSettingsChanged("backgroundColor");
    return this;
  }

  /** Enable the analytic sky and adjust its parameters. `sunDirection` is copied. */
  setSky(options: Partial<SceneSkySettings> = {}): this {
    const sky = this.settings.sky;
    const { sunDirection, ...rest } = options;
    Object.assign(sky, rest);
    if (sunDirection !== undefined) sky.sunDirection = sunDirection ? sunDirection.clone().normalize() : null;
    this.settings.skyEnabled = true;
    this.onSettingsChanged("sky");
    return this;
  }

  setShadowSettings(options: Partial<SceneShadowSettings>): this {
    Object.assign(this.settings.shadow, options);
    this.onSettingsChanged("shadow");
    return this;
  }

  /** Adjust the cloud deck (`coverage` 0 = clear sky; the deck renders inside `forge.sky`). */
  setClouds(options: Partial<SceneCloudSettings> = {}): this {
    const clouds = this.settings.clouds;
    const { albedo, ...rest } = options;
    Object.assign(clouds, rest);
    if (albedo !== undefined) clouds.albedo.copyFrom(albedo);
    this.onSettingsChanged("clouds");
    return this;
  }

  /** Adjust the water surface (colours are copied; `waves` is replaced as a whole). */
  setWater(options: Partial<SceneWaterSettings> = {}): this {
    const water = this.settings.water;
    const { deepColor, shallowColor, foamColor, murkColor, waves, ...rest } = options;
    Object.assign(water, rest);
    if (deepColor !== undefined) water.deepColor.copyFrom(deepColor);
    if (shallowColor !== undefined) water.shallowColor.copyFrom(shallowColor);
    if (foamColor !== undefined) water.foamColor.copyFrom(foamColor);
    if (murkColor !== undefined) water.murkColor.copyFrom(murkColor);
    if (waves !== undefined) water.waves = waves.map((w) => ({ ...w }));
    this.onSettingsChanged("water");
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
    depthPrepass: s.depthPrepass,
    clusteredLighting: s.clusteredLighting,
    renderScale: s.renderScale,
    iblIntensity: s.iblIntensity,
    recenterDistance: s.recenterDistance,
    fog: {
      mode: s.fog.mode,
      color: [s.fog.color.r, s.fog.color.g, s.fog.color.b],
      density: s.fog.density,
      start: s.fog.start,
      end: s.fog.end,
      heightFalloff: s.fog.heightFalloff,
      heightBase: s.fog.heightBase,
    },
    shadow: { ...s.shadow },
    bloom: { ...s.bloom },
    ssao: { ...s.ssao },
    sky: {
      ...s.sky,
      sunDirection: s.sky.sunDirection ? [s.sky.sunDirection.x, s.sky.sunDirection.y, s.sky.sunDirection.z] : null,
      atmosphere: s.sky.atmosphere ? { ...s.sky.atmosphere } : null,
    },
    clouds: {
      ...s.clouds,
      albedo: [s.clouds.albedo.r, s.clouds.albedo.g, s.clouds.albedo.b],
    },
    water: {
      ...s.water,
      deepColor: [s.water.deepColor.r, s.water.deepColor.g, s.water.deepColor.b],
      shallowColor: [s.water.shallowColor.r, s.water.shallowColor.g, s.water.shallowColor.b],
      foamColor: [s.water.foamColor.r, s.water.foamColor.g, s.water.foamColor.b],
      murkColor: [s.water.murkColor.r, s.water.murkColor.g, s.water.murkColor.b],
      waves: s.water.waves.map((w) => ({ ...w })),
    },
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
  if (typeof data["depthPrepass"] === "boolean") target.depthPrepass = data["depthPrepass"];
  if (typeof data["clusteredLighting"] === "boolean") target.clusteredLighting = data["clusteredLighting"];
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
    target.fog.heightFalloff = num(fog["heightFalloff"], target.fog.heightFalloff);
    target.fog.heightBase = num(fog["heightBase"], target.fog.heightBase);
  }
  const sky = data["sky"] as Record<string, unknown> | undefined;
  if (sky) {
    const t = target.sky;
    const dir = vec(sky["sunDirection"]);
    if (dir) t.sunDirection = new Vec3(dir[0]!, dir[1]!, dir[2]!).normalize();
    else if (sky["sunDirection"] === null) t.sunDirection = null;
    t.sunIntensity = num(sky["sunIntensity"], t.sunIntensity);
    t.exposure = num(sky["exposure"], t.exposure);
    t.turbidity = num(sky["turbidity"], t.turbidity);
    t.rayleigh = num(sky["rayleigh"], t.rayleigh);
    t.mie = num(sky["mie"], t.mie);
    t.sunAngularRadius = num(sky["sunAngularRadius"], t.sunAngularRadius);
    t.sunDiscIntensity = num(sky["sunDiscIntensity"], t.sunDiscIntensity);
    t.starBrightness = num(sky["starBrightness"], t.starBrightness);
    t.seaLevel = num(sky["seaLevel"], t.seaLevel);
    if (typeof sky["nightEnabled"] === "boolean") t.nightEnabled = sky["nightEnabled"];
    if (sky["quality"] === "low" || sky["quality"] === "medium" || sky["quality"] === "high") t.quality = sky["quality"];
    if (sky["atmosphere"] && typeof sky["atmosphere"] === "object") t.atmosphere = { ...(sky["atmosphere"] as AtmosphereParams) };
    else if (sky["atmosphere"] === null) t.atmosphere = null;
  }
  const shadow = data["shadow"] as Record<string, unknown> | undefined;
  if (shadow) {
    if (typeof shadow["enabled"] === "boolean") target.shadow.enabled = shadow["enabled"];
    target.shadow.cascades = Math.min(4, Math.max(1, num(shadow["cascades"], target.shadow.cascades)));
    target.shadow.mapSize = num(shadow["mapSize"], target.shadow.mapSize);
    target.shadow.distance = num(shadow["distance"], target.shadow.distance);
    target.shadow.splitLambda = num(shadow["splitLambda"], target.shadow.splitLambda);
    if (typeof shadow["debugCascades"] === "boolean") target.shadow.debugCascades = shadow["debugCascades"];
  }
  const bloom = data["bloom"] as Record<string, unknown> | undefined;
  if (bloom) {
    if (typeof bloom["enabled"] === "boolean") target.bloom.enabled = bloom["enabled"];
    target.bloom.threshold = num(bloom["threshold"], target.bloom.threshold);
    target.bloom.softKnee = num(bloom["softKnee"], target.bloom.softKnee);
    target.bloom.intensity = num(bloom["intensity"], target.bloom.intensity);
    target.bloom.radius = num(bloom["radius"], target.bloom.radius);
  }
  const ssao = data["ssao"] as Record<string, unknown> | undefined;
  if (ssao) {
    if (typeof ssao["enabled"] === "boolean") target.ssao.enabled = ssao["enabled"];
    target.ssao.radius = num(ssao["radius"], target.ssao.radius);
    target.ssao.intensity = num(ssao["intensity"], target.ssao.intensity);
    target.ssao.bias = num(ssao["bias"], target.ssao.bias);
    target.ssao.samples = num(ssao["samples"], target.ssao.samples);
  }
  const clouds = data["clouds"] as Record<string, unknown> | undefined;
  if (clouds) {
    const t = target.clouds;
    if (typeof clouds["enabled"] === "boolean") t.enabled = clouds["enabled"];
    t.coverage = num(clouds["coverage"], t.coverage);
    t.density = num(clouds["density"], t.density);
    t.height = num(clouds["height"], t.height);
    t.scale = num(clouds["scale"], t.scale);
    t.seed = num(clouds["seed"], t.seed);
    t.silverLining = num(clouds["silverLining"], t.silverLining);
    t.windX = num(clouds["windX"], t.windX);
    t.windZ = num(clouds["windZ"], t.windZ);
    const albedo = vec(clouds["albedo"]);
    if (albedo) t.albedo.set(albedo[0]!, albedo[1]!, albedo[2]!);
  }
  const water = data["water"] as Record<string, unknown> | undefined;
  if (water) {
    const t = target.water;
    if (typeof water["enabled"] === "boolean") t.enabled = water["enabled"];
    t.level = num(water["level"], t.level);
    t.size = num(water["size"], t.size);
    t.time = num(water["time"], t.time);
    const deep = vec(water["deepColor"]);
    if (deep) t.deepColor.set(deep[0]!, deep[1]!, deep[2]!);
    const shallow = vec(water["shallowColor"]);
    if (shallow) t.shallowColor.set(shallow[0]!, shallow[1]!, shallow[2]!);
    const foam = vec(water["foamColor"]);
    if (foam) t.foamColor.set(foam[0]!, foam[1]!, foam[2]!);
    const murk = vec(water["murkColor"]);
    if (murk) t.murkColor.set(murk[0]!, murk[1]!, murk[2]!);
    t.murkDensity = num(water["murkDensity"], t.murkDensity);
    t.opacity = num(water["opacity"], t.opacity);
    t.sunGlint = num(water["sunGlint"], t.sunGlint);
    t.foamThreshold = num(water["foamThreshold"], t.foamThreshold);
    if (Array.isArray(water["waves"])) {
      t.waves = (water["waves"] as Record<string, unknown>[]).map((w) => ({
        directionX: num(w["directionX"], 1),
        directionZ: num(w["directionZ"], 0),
        wavelength: num(w["wavelength"], 10),
        amplitude: num(w["amplitude"], 0),
        speed: num(w["speed"], 1),
        steepness: num(w["steepness"], 0),
        phase: num(w["phase"], 0),
      }));
    }
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
