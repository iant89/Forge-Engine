/**
 * DOM-free specialist workspace adapters for Phase 26.5–26.13.
 *
 * Panels are snapshots and commands, not runtime subsystems. They consume only the public
 * `@forge/engine` barrel so the same data can feed the DOM shell, Forge UI, a CLI, or an external
 * editor host. Missing optional services produce an unavailable panel rather than an exception.
 */

import {
  Material,
  Renderable,
  TerrainWorld,
  VehicleComponent,
  inspectEnvironment,
  inspectParticles,
  inspectRenderGraph,
  inspectStreaming,
  inspectTerrain,
  frameTimeline,
} from "@forge/engine";
import type { EntityId } from "@forge/engine";
import type {
  Engine,
  FrameRecord,
  FrameBreakdown,
  ParticleDebugSnapshot,
  RenderGraphView,
  Scene,
  ScopeStats,
  StreamingDebugSnapshot,
  TerrainDebugSnapshot,
  EnvironmentDebugSnapshot,
} from "@forge/engine";
import type { EditorSession } from "./session.js";

export const EDITOR_PANEL_IDS = [
  "terrain",
  "material",
  "particles",
  "vehicle",
  "environment",
  "streaming",
  "renderGraph",
  "assets",
  "profiler",
] as const;

export type EditorPanelId = (typeof EDITOR_PANEL_IDS)[number];

export interface EditorPanelSnapshot<T = unknown> {
  readonly id: EditorPanelId;
  readonly title: string;
  readonly available: boolean;
  readonly message: string | null;
  readonly data: T | null;
}

export interface MaterialPanelEntry {
  readonly entity: EntityId;
  readonly entityName: string;
  readonly label: string;
  readonly technique: string;
  readonly pipelineKey: string;
  readonly baseColor: [number, number, number, number];
  readonly emissive: [number, number, number, number];
  readonly emissiveStrength: number;
  readonly metallic: number;
  readonly roughness: number;
  readonly opacity: number;
  readonly tiling: [number, number];
  readonly offset: [number, number];
  readonly transparent: boolean;
  readonly doubleSided: boolean;
  readonly fogExempt: boolean;
  readonly alphaTest: number;
  readonly maps: { albedo: boolean; normal: boolean; metallicRoughness: boolean; emissive: boolean; occlusion: boolean };
}

export interface MaterialPanelData {
  readonly selected: MaterialPanelEntry | null;
  readonly entries: readonly MaterialPanelEntry[];
}

export interface ParticlePanelData extends ParticleDebugSnapshot {
  readonly gpuWorldsReady: number;
}

export interface VehiclePanelEntry {
  readonly entity: EntityId;
  readonly entityName: string;
  readonly enabled: boolean;
  readonly gear: number;
  readonly speed: number;
  readonly telemetry: ReturnType<VehicleComponent["vehicle"]["telemetry"]>;
  readonly input: Readonly<VehicleComponent["vehicle"]["input"]>;
  readonly config: { mass: number; wheelbase: number; wheelCount: number; drivetrain: string };
}

export interface VehiclePanelData {
  readonly entries: readonly VehiclePanelEntry[];
}

export interface AssetBrowserEntry {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly bytes: number;
  readonly priority: number;
  readonly dependencies: readonly string[];
  readonly dependents: readonly string[];
  readonly source: "registry" | "streamer";
}

export interface AssetBrowserData {
  readonly entries: readonly AssetBrowserEntry[];
  readonly registry: ReturnType<Engine["resources"]["stats"]>;
  readonly filter: string;
  readonly truncated: boolean;
}

export interface ProfilerPanelData {
  readonly scopes: readonly ScopeStats[];
  readonly frames: readonly FrameRecord[];
  readonly breakdown: FrameBreakdown;
  readonly timeline: ReturnType<typeof frameTimeline>;
  readonly report: string;
}

export interface EditorPanelContext {
  readonly scene: Scene;
  readonly engine: Engine | null;
  readonly session: EditorSession;
  readonly selectedId: EntityId | null;
}

export type PanelDataById = {
  terrain: TerrainDebugSnapshot;
  material: MaterialPanelData;
  particles: ParticlePanelData;
  vehicle: VehiclePanelData;
  environment: EnvironmentDebugSnapshot;
  streaming: StreamingDebugSnapshot;
  renderGraph: RenderGraphView;
  assets: AssetBrowserData;
  profiler: ProfilerPanelData;
};

/** Build one bounded specialist snapshot. */
export function inspectEditorPanel<K extends EditorPanelId>(id: K, context: EditorPanelContext, options: { filter?: string; limit?: number } = {}): EditorPanelSnapshot<PanelDataById[K]> {
  switch (id) {
    case "terrain": {
      const data = inspectTerrainPanel(context.scene, options);
      return data === null
        ? unavailable("terrain", "Terrain", "No TerrainWorld is present in this scene")
        : panel("terrain", "Terrain", data) as EditorPanelSnapshot<PanelDataById[K]>;
    }
    case "material":
      return panel("material", "Material", inspectMaterials(context.scene, context.selectedId)) as EditorPanelSnapshot<PanelDataById[K]>;
    case "particles":
      return panel("particles", "Particles", inspectParticlePanel(context.scene, options)) as EditorPanelSnapshot<PanelDataById[K]>;
    case "vehicle":
      return panel("vehicle", "Vehicles", inspectVehicles(context.scene)) as EditorPanelSnapshot<PanelDataById[K]>;
    case "environment":
      return panel("environment", "Environment", inspectEnvironment(context.scene)) as EditorPanelSnapshot<PanelDataById[K]>;
    case "streaming":
      if (!context.engine) return unavailable("streaming", "Streaming", "Attach an Engine to inspect streaming");
      return panel("streaming", "Streaming", inspectStreaming(context.engine)) as EditorPanelSnapshot<PanelDataById[K]>;
    case "renderGraph":
      if (!context.engine) return unavailable("renderGraph", "Render Graph", "Attach an Engine to inspect the render graph");
      return panel("renderGraph", "Render Graph", inspectRenderGraph(context.engine.renderer.graph)) as EditorPanelSnapshot<PanelDataById[K]>;
    case "assets":
      if (!context.engine) return unavailable("assets", "Assets", "Attach an Engine to browse loaded assets");
      return panel("assets", "Assets", inspectAssets(context.engine, options.filter ?? "", options.limit)) as EditorPanelSnapshot<PanelDataById[K]>;
    case "profiler":
      if (!context.engine) return unavailable("profiler", "Profiler", "Attach an Engine to inspect frame history");
      return panel("profiler", "Profiler", inspectProfiler(context.engine)) as EditorPanelSnapshot<PanelDataById[K]>;
  }
}

function inspectTerrainPanel(scene: Scene, options: { filter?: string; limit?: number }): TerrainDebugSnapshot | null {
  const world = scene.objects.find((object): object is TerrainWorld => object instanceof TerrainWorld);
  return world ? inspectTerrain(world, { filter: options.filter, limit: options.limit }) : null;
}

function inspectMaterials(scene: Scene, selectedId: EntityId | null): MaterialPanelData {
  const entries: MaterialPanelEntry[] = [];
  for (const renderable of scene.world.store(Renderable).liveValues()) {
    if (!renderable.material) continue;
    const entity = scene.world.facade(renderable.entity);
    if (!entity) continue;
    entries.push(describeMaterial(entity.id, entity.name, renderable.material));
  }
  return { selected: selectedId === null ? null : entries.find((entry) => entry.entity === selectedId) ?? null, entries };
}

function describeMaterial(entity: EntityId, entityName: string, material: Material): MaterialPanelEntry {
  return {
    entity,
    entityName,
    label: material.label,
    technique: material.technique,
    pipelineKey: material.pipelineKey,
    baseColor: [material.baseColor.r, material.baseColor.g, material.baseColor.b, material.baseColor.a],
    emissive: [material.emissive.r, material.emissive.g, material.emissive.b, material.emissive.a],
    emissiveStrength: material.emissiveStrength,
    metallic: material.metallic,
    roughness: material.roughness,
    opacity: material.opacity,
    tiling: [material.tiling.x, material.tiling.y],
    offset: [material.offset.x, material.offset.y],
    transparent: material.transparent,
    doubleSided: material.doubleSided,
    fogExempt: material.fogExempt,
    alphaTest: material.alphaTest,
    maps: {
      albedo: material.albedoMap !== null,
      normal: material.normalMap !== null,
      metallicRoughness: material.metallicRoughnessMap !== null,
      emissive: material.emissiveMap !== null,
      occlusion: material.occlusionMap !== null,
    },
  };
}

function inspectParticlePanel(scene: Scene, options: { filter?: string; limit?: number }): ParticlePanelData {
  const snapshot = inspectParticles(scene, {
    filter: options.filter,
    maxWorlds: options.limit,
    maxParticleSamples: 128,
  });
  return { ...snapshot, gpuWorldsReady: snapshot.worlds.filter((world) => world.backend === "gpu" && world.ready).length };
}

function inspectVehicles(scene: Scene): VehiclePanelData {
  const entries: VehiclePanelEntry[] = [];
  for (const component of scene.world.store(VehicleComponent).liveValues()) {
    const entity = scene.world.facade(component.entity);
    if (!entity) continue;
    const vehicle = component.vehicle;
    entries.push({
      entity: entity.id,
      entityName: entity.name,
      enabled: component.enabled,
      gear: vehicle.gear,
      speed: vehicle.speed,
      telemetry: vehicle.telemetry(),
      input: { ...vehicle.input },
      config: {
        mass: vehicle.config.mass,
        wheelbase: vehicle.config.wheelbase,
        wheelCount: vehicle.config.wheels.length,
        drivetrain: vehicle.config.layout,
      },
    });
  }
  return { entries };
}

function inspectAssets(engine: Engine, filter: string, limit = 256): AssetBrowserData {
  const needle = filter.trim().toLowerCase();
  const cap = Number.isFinite(limit) ? Math.max(0, Math.min(1024, Math.floor(limit))) : 256;
  const entries = new Map<string, AssetBrowserEntry>();
  const kinds = ["texture", "mesh", "material", "gltf", "audio", "scene", "terrain", "shader"];
  for (const kind of kinds) {
    for (const id of engine.resources.idsOfKind(kind)) {
      if (needle && !id.toLowerCase().includes(needle) && !kind.includes(needle)) continue;
      const descriptor = engine.resources.descriptorOf(id);
      entries.set(id, {
        id,
        kind,
        state: engine.resources.stateOf(id) ?? "unknown",
        bytes: 0,
        priority: descriptor?.priority ?? 0,
        dependencies: engine.resources.dependenciesOf(id),
        dependents: engine.resources.dependentsOf(id),
        source: "registry",
      });
    }
  }
  for (const load of engine.streamer.inspect(1024)) {
    if (needle && !load.id.toLowerCase().includes(needle) && !load.kind.toLowerCase().includes(needle)) continue;
    entries.set(load.id, {
      id: load.id,
      kind: load.kind,
      state: load.state,
      bytes: load.estimatedBytes,
      priority: load.priority,
      dependencies: engine.resources.dependenciesOf(load.id),
      dependents: engine.resources.dependentsOf(load.id),
      source: "streamer",
    });
  }
  const all = [...entries.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  return { entries: all.slice(0, cap), registry: engine.resources.stats(), filter, truncated: all.length > cap };
}

function inspectProfiler(engine: Engine): ProfilerPanelData {
  const frames = engine.profiler.frameHistory().map((frame) => ({ ...frame, slices: frame.slices.map((slice) => ({ ...slice })) }));
  return {
    scopes: engine.profiler.snapshot().map((scope) => ({ ...scope })),
    frames,
    breakdown: engine.frameBreakdown(),
    timeline: frameTimeline(frames),
    report: engine.profiler.report(),
  };
}

function panel<K extends EditorPanelId, T>(id: K, title: string, data: T | null): EditorPanelSnapshot<T> {
  return { id, title, available: data !== null, message: data === null ? `No ${title.toLowerCase()} object is present in this scene` : null, data };
}

function unavailable<K extends EditorPanelId>(id: K, title: string, message: string): EditorPanelSnapshot<never> {
  return { id, title, available: false, message, data: null };
}
