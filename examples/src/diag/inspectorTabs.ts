/**
 * The tabs behind the demo's Inspector window (`inspectorPanel.ts`): one adapter per Phase 21
 * diagnostic API, turning each read-only snapshot into rows, fields and (where the API has one) a
 * debug-line overlay.
 *
 * Nothing here holds engine state: `load` is called on every refresh with a fresh snapshot, and a
 * subsystem that is not present in the running scene (no terrain, no physics, no GPU timestamps)
 * reports a note instead of throwing — a panel that crashes because the demo is on the PBR scene is
 * worse than a panel that says there is nothing to show.
 *
 * The source is deliberately the console's own host shape ({@link DeveloperConsoleHost}) plus a line
 * sink, so the console and the panel see exactly the same engine objects.
 */

import {
  TerrainWorld,
  drawEnvironmentDebug,
  drawParticleDebug,
  drawPhysicsDebug,
  drawTerrainDebug,
  inspectEcs,
  inspectEntity,
  inspectEnvironment,
  inspectGpuResources,
  inspectParticles,
  inspectRenderGraph,
  inspectStreaming,
  inspectTerrain,
  PhysicsSystem,
  physicsDebugDraw,
  type DeveloperConsoleHost,
} from "@forge/engine";
import type { Vec3 } from "@forge/engine";
import type { InspectorField, InspectorRow, InspectorSection, InspectorTabData } from "./inspectorPanel.js";

export interface InspectorSource extends DeveloperConsoleHost {
  /** Renderer line sink for overlays; absent means overlays are unavailable. */
  drawLine?: ((a: Vec3, b: Vec3, color: number) => void) | null;
}

/**
 * The engine's `draw*Debug` bridges take a looser point type than `Renderer.drawLine` hands out, so
 * the host's sink is adapted once here rather than at every call site.
 */
function lineSink(source: InspectorSource): ((a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, color: number) => void) | null {
  const sink = source.drawLine;
  if (!sink) return null;
  return (a, b, color) => sink(a as Vec3, b as Vec3, color);
}

export interface InspectorOverlay {
  key: string;
  label: string;
  /** Draw this overlay's lines for one frame; returns how many lines it emitted. */
  draw(source: InspectorSource): number;
}

export interface InspectorTab {
  id: string;
  title: string;
  /** Placeholder for the filter box; tabs that ignore the filter leave it undefined. */
  filterHint?: string;
  overlay?: InspectorOverlay;
  load(source: InspectorSource, filter: string): InspectorTabData;
}

// ------------------------------------------------------------------ formatting

const num = (value: number, digits = 2): string => (Number.isFinite(value) ? value.toFixed(digits) : "—");
const int = (value: number): string => (Number.isFinite(value) ? String(Math.round(value)) : "—");
const ms = (value: number | null | undefined): string => (value === null || value === undefined ? "—" : `${num(value)} ms`);
const vec = (value: readonly number[] | null | undefined, digits = 2): string =>
  !value ? "—" : value.map((v) => num(v, digits)).join(", ");

function bytes(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 * 1024) return `${(value / 1024 ** 2).toFixed(2)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${Math.round(value)} B`;
}

const fields = (entries: readonly (readonly [string, string | number | boolean | null | undefined])[]): InspectorField[] =>
  entries.map(([label, value]) => ({
    label,
    value: typeof value === "number" ? (Number.isInteger(value) ? String(value) : num(value)) : String(value ?? "—"),
  }));

const note = (text: string, extra: readonly string[] = []): InspectorTabData => ({
  summary: [],
  rows: [],
  notes: [text, ...extra],
});

// ------------------------------------------------------------------ helpers shared by tabs

const sceneOf = (source: InspectorSource) => source.currentScene ?? null;

function terrainOf(source: InspectorSource): TerrainWorld | null {
  const scene = sceneOf(source);
  if (!scene) return null;
  const found = scene.objects.find((object) => object instanceof TerrainWorld);
  return found instanceof TerrainWorld ? found : null;
}

function physicsOf(source: InspectorSource) {
  const scene = sceneOf(source);
  if (!scene) return null;
  const found = scene.world.systems.find((system) => system instanceof PhysicsSystem);
  return found instanceof PhysicsSystem ? found : null;
}

// ------------------------------------------------------------------ 21.2 ECS

const ecsTab: InspectorTab = {
  id: "ecs",
  title: "ECS",
  filterHint: "name or component",
  load(source, filter) {
    const scene = sceneOf(source);
    if (!scene) return note("no scene is active");
    const snapshot = inspectEcs(scene.world, {
      profiler: source.profiler ?? null,
      filter: filter || undefined,
      limit: 200,
    });
    const rows: InspectorRow[] = snapshot.list.map((entity) => ({
      key: `e${entity.id}`,
      label: `#${entity.id} ${entity.name}${entity.children > 0 ? ` (+${entity.children})` : ""}`,
      badge: entity.components.length > 0 ? `${entity.components.length}c` : "—",
      detail: () => [
        {
          fields: fields([
            ["id", entity.id],
            ["name", entity.name],
            ["parent", entity.parent],
            ["children", entity.children],
            ["position", vec(entity.position)],
          ]),
        },
        {
          title: `components (${entity.components.length})`,
          fields: fields(entity.components.map((name) => [name, ""])) as InspectorField[],
        },
      ],
    }));
    // The list row is built from the bounded snapshot; the detail reads the entity again so the
    // component *fields* (which the list deliberately omits) are only computed on demand.
    const detail = (key: string): InspectorSection[] => {
      const id = Number(key.slice(1));
      const entity = inspectEntity(scene.world, id);
      if (!entity) return [{ fields: [{ label: "gone", value: "the entity no longer exists" }] }];
      return [
        { title: entity.name || `#${id}`, fields: fields([["id", id], ["parent", entity.parent], ["children", entity.children], ["position", vec(entity.position)]]) },
        ...entity.detail.map((component) => ({
          title: `${component.type}${component.enabled ? "" : " (disabled)"}`,
          fields: fields(Object.entries(component.fields).map(([label, value]) => [label, Array.isArray(value) ? vec(value, 3) : (value as string | number | boolean | null)])),
        })),
      ];
    };
    for (const row of rows) row.detail = () => detail(row.key);
    return {
      summary: [
        { label: "entities", value: int(snapshot.entities) },
        { label: "components", value: int(snapshot.components) },
        { label: "systems", value: int(snapshot.systems.length) },
        { label: "depth", value: int(snapshot.hierarchyDepth) },
      ],
      rows,
      notes: snapshot.truncated
        ? ["showing the first 200 matching entities — narrow the filter to reach the rest", ROW_HINT]
        : rows.length === 0
          ? [filter ? `no entity matches ${JSON.stringify(filter)}` : "the scene has no entities"]
          : [],
    };
  },
};

const systemsTab: InspectorTab = {
  id: "systems",
  title: "Systems",
  filterHint: "system name",
  load(source, filter) {
    const scene = sceneOf(source);
    if (!scene) return note("no scene is active");
    const snapshot = inspectEcs(scene.world, { profiler: source.profiler ?? null, limit: 0 });
    const needle = filter.trim().toLowerCase();
    const systems = snapshot.systems.filter((system) => !needle || system.name.toLowerCase().includes(needle));
    return {
      summary: [
        { label: "systems", value: int(systems.length) },
        { label: "enabled", value: int(systems.filter((s) => s.enabled).length) },
        { label: "frame scope", value: ms(source.profiler?.lastFrame()?.cpuMs ?? null) },
      ],
      rows: systems.map((system, index) => ({
        key: `s${index}:${system.name}`,
        label: `${system.enabled ? "" : "(off) "}${system.name}`,
        badge: ms(system.ms),
        detail: () => [
          {
            fields: fields([
              ["order", system.order],
              ["run index", system.runIndex],
              ["enabled", system.enabled],
              ["profiler scope", ms(system.ms)],
              ...Object.entries(system.stats ?? {}).map(([k, v]) => [k, v] as const),
            ]),
          },
        ],
      })),
      notes: systems.some((s) => s.ms === null) ? ["a `—` scope time means the profiler has no scope for that system yet"] : [],
    };
  },
};

const ROW_HINT = "the entity list is capped at 200 rows by the inspector API";

// ------------------------------------------------------------------ 21.3 render graph

const graphTab: InspectorTab = {
  id: "graph",
  title: "Graph",
  filterHint: "pass name",
  load(source, filter) {
    if (!source.renderer) return note("the renderer is not exposed to the inspector");
    const view = inspectRenderGraph(source.renderer.graph);
    const needle = filter.trim().toLowerCase();
    const rows: InspectorRow[] = [];
    for (const pass of view.passes) {
      if (needle && !pass.name.toLowerCase().includes(needle)) continue;
      rows.push({
        key: `p:${pass.name}`,
        label: pass.live ? pass.name : `${pass.name}`,
        badge: pass.gpuMs !== null ? num(pass.gpuMs) : pass.live ? "live" : "culled",
        detail: () => [
          {
            fields: fields([
              ["live", pass.live],
              ["reason", pass.reason],
              ["gpu", ms(pass.gpuMs)],
            ]),
          },
          { title: "reads", fields: fields(pass.reads.map((name) => [name, ""])) },
          { title: "writes", fields: fields(pass.writes.map((name) => [name, ""])) },
          { title: "depends on", fields: fields(pass.dependsOn.map((name) => [name, ""])) },
        ],
      });
    }
    for (const name of view.culled) {
      if (needle && !name.toLowerCase().includes(needle)) continue;
      rows.push({
        key: `c:${name}`,
        label: name,
        badge: "culled",
        detail: () => [{ fields: fields([["live", false], ["note", "not scheduled this frame: nothing consumed its output"]]) }],
      });
    }
    return {
      summary: [
        { label: "passes", value: int(view.passes.length) },
        { label: "culled", value: int(view.culled.length) },
        { label: "transient", value: bytes(view.transientBytes) },
        { label: "aliased", value: bytes(view.aliasedBytes) },
        { label: "pooled", value: bytes(view.pooledBytes) },
        { label: "gpu", value: ms(view.gpuFrameMs) },
      ],
      rows,
      notes:
        view.gpuFrameMs === null
          ? ["no GPU frame time: this adapter has no timestamp queries"]
          : rows.length === 0
            ? ["no pass matches the filter"]
            : [],
    };
  },
};

// ------------------------------------------------------------------ 21.4 GPU resources

const gpuTab: InspectorTab = {
  id: "gpu",
  title: "GPU",
  filterHint: "label",
  load(source, filter) {
    if (!source.gpu) return note("the GPU device is not exposed to the inspector");
    const view = inspectGpuResources(source.gpu, { top: 8 });
    const needle = filter.trim().toLowerCase();
    const rows: InspectorRow[] = view.groups
      .filter((group) => !needle || group.group.toLowerCase().includes(needle))
      .map((group) => ({
        key: `g:${group.group}`,
        label: group.group,
        badge: bytes(group.bytes),
        detail: () => [
          {
            fields: fields([
              ["count", group.count],
              ["bytes", bytes(group.bytes)],
              ["textures", group.textures],
              ["buffers", group.buffers],
              ["largest", `${group.largest.label} (${bytes(group.largest.bytes)})`],
            ]),
          },
        ],
      }));
    return {
      summary: [
        { label: "total", value: bytes(view.totalBytes) },
        { label: "textures", value: bytes(view.textureBytes) },
        { label: "buffers", value: bytes(view.bufferBytes) },
        { label: "live", value: int(view.count) },
        { label: "pipelines", value: int(view.objects.pipelines) },
        { label: "bind groups", value: int(view.objects.bindGroups) },
      ],
      rows,
      notes: rows.length === 0 ? ["no live resources match the filter"] : [],
    };
  },
};

// ------------------------------------------------------------------ 21.5 physics

const physicsTab: InspectorTab = {
  id: "physics",
  title: "Physics",
  filterHint: "body id or shape",
  overlay: {
    key: "physics",
    label: "wireframes + contacts",
    draw(source) {
      const system = physicsOf(source);
      const sink = lineSink(source);
      if (!system || !sink) return 0;
      const view = drawPhysicsDebug(system.world, sink, { showAabbs: true, showVelocity: true, showContacts: true });
      return view.lineCount;
    },
  },
  load(source, filter) {
    const system = physicsOf(source);
    if (!system) return note("no PhysicsSystem is registered on the active scene");
    const limit = 128;
    const view = physicsDebugDraw(system.world, { maxBodies: limit, showAabbs: true, showVelocity: true, showContacts: true });
    const needle = filter.trim().toLowerCase();
    const bodies = system.world.bodies
      .slice(0, limit)
      .filter((body) => !needle || String(body.id).includes(needle) || body.shape.type.toLowerCase().includes(needle));
    return {
      summary: [
        { label: "bodies", value: int(view.bodyCount) },
        { label: "processed", value: int(view.processedBodies) },
        { label: "contacts", value: int(view.contactCount) },
        { label: "lines", value: int(view.lineCount) },
      ],
      rows: bodies.map((body) => ({
        key: `b${body.id}`,
        label: `#${body.id} ${body.shape.type}`,
        badge: body.type,
        detail: () => [
          {
            fields: fields([
              ["type", body.type],
              ["shape", body.shape.type],
              ["position", vec([body.renderPosition.x, body.renderPosition.y, body.renderPosition.z])],
              ["velocity", vec([body.linearVelocity.x, body.linearVelocity.y, body.linearVelocity.z])],
              ["mass", num(body.mass, 3)],
              ["sleeping", body.isSleeping ?? false],
            ]),
          },
        ],
      })),
      notes: [
        ...(view.truncatedBodies ? [`showing the first ${limit} of ${view.bodyCount} bodies`] : []),
        ...(view.truncatedContacts ? [`contact overlay capped: ${view.truncatedContacts} contact points omitted`] : []),
      ],
    };
  },
};

// ------------------------------------------------------------------ 21.6 terrain

const terrainTab: InspectorTab = {
  id: "terrain",
  title: "Terrain",
  filterHint: "chunk key",
  overlay: {
    key: "terrain",
    label: "chunk bounds",
    draw(source) {
      const world = terrainOf(source);
      const sink = lineSink(source);
      if (!world || !sink) return 0;
      return drawTerrainDebug(world, sink, { limit: 256 });
    },
  },
  load(source, filter) {
    const world = terrainOf(source);
    if (!world) return note("no TerrainWorld is attached to the active scene");
    const snapshot = inspectTerrain(world, { filter: filter || undefined, limit: 128 });
    const rows = snapshot.list.map((chunk) => ({
      key: `t:${chunk.key}`,
      label: `${chunk.key}  lod ${chunk.lod}`,
      badge: chunk.state,
      detail: () => [
        {
          fields: fields([
            ["state", chunk.state],
            ["lod", chunk.lod],
            ["resolution", chunk.resolution],
            ["geomorph", num(chunk.geomorphAlpha, 3)],
            ["size", num(chunk.size, 1)],
            ["resident", bytes(chunk.residentBytes)],
            ["entity", chunk.entityId === null ? "—" : chunk.entityId],
            ["centre height", chunk.centerHeight === null ? "—" : num(chunk.centerHeight, 2)],
            ["bounds min", vec(chunk.bounds[0], 1)],
            ["bounds max", vec(chunk.bounds[1], 1)],
          ]),
        },
      ],
    }));
    return {
      summary: [
        { label: "chunks", value: int(snapshot.chunks) },
        { label: "ready", value: int(snapshot.ready) },
        { label: "pending", value: int(snapshot.pending) },
        { label: "generating", value: int(snapshot.generating) },
        { label: "resident", value: bytes(snapshot.residentBytes) },
        { label: "view", value: num(snapshot.viewDistance, 0) },
      ],
      rows,
      notes: snapshot.truncated ? ["showing the first 128 matching chunks — narrow the filter for the rest"] : [],
    };
  },
};

// ------------------------------------------------------------------ 21.7 particles

const particlesTab: InspectorTab = {
  id: "particles",
  title: "Particles",
  filterHint: "world name",
  overlay: {
    key: "particles",
    label: "particles",
    draw(source) {
      const scene = sceneOf(source);
      const sink = lineSink(source);
      if (!scene || !sink) return 0;
      return drawParticleDebug(scene, sink, { maxParticleSamples: 64 });
    },
  },
  load(source, filter) {
    const scene = sceneOf(source);
    if (!scene) return note("no scene is active");
    const snapshot = inspectParticles(scene, { filter: filter || undefined, maxParticleSamples: 32 });
    return {
      summary: [
        { label: "worlds", value: int(snapshot.worldCount) },
        { label: "cpu", value: int(snapshot.cpuWorlds) },
        { label: "gpu", value: int(snapshot.gpuWorlds) },
      ],
      rows: snapshot.worlds.map((world, index) => ({
        key: `w${index}:${world.name}`,
        label: `${world.name}  ${world.backend}`,
        badge: world.alive === null ? `${int(world.emitted)} emitted` : `${int(world.alive)} alive`,
        detail: () => [
          {
            fields: fields([
              ["backend", world.backend],
              ["enabled", world.enabled],
              ["ready", world.ready],
              ["entity", world.entityId === null ? "—" : world.entityId],
              ["capacity", int(world.capacity)],
              ["alive", world.alive === null ? "counters only (GPU)" : int(world.alive)],
              ["emitted", int(world.emitted)],
              ["steps", int(world.steps)],
              ["storage", bytes(world.storageBytes)],
            ]),
          },
          ...(world.emitter
            ? [
                {
                  title: "emitter",
                  fields: fields([
                    ["position", vec(world.emitter.position)],
                    ["direction", vec(world.emitter.direction)],
                    ["rate", num(world.emitter.rate, 1)],
                    ["life", `${num(world.emitter.lifeMin, 2)}–${num(world.emitter.lifeMax, 2)} s`],
                    ["size", num(world.emitter.size, 3)],
                    ["speed", `${num(world.emitter.speedMin, 2)}–${num(world.emitter.speedMax, 2)}`],
                    ["cone", num(world.emitter.coneAngle, 3)],
                  ]),
                },
              ]
            : []),
          {
            title: `sampled particles (${world.sampledParticles.length} of ${int(world.scannedSlots)} slots)`,
            fields:
              world.sampledParticles.length === 0
                ? [{ label: world.backend === "gpu" ? "gpu" : "none", value: world.backend === "gpu" ? "positions are not read back" : "no live particles" }]
                : fields(
                    world.sampledParticles.slice(0, 32).map((p) => [`#${p.slot}`, `${vec(p.position, 1)}  life ${num(p.remainingLife, 2)}/${num(p.maxLife, 2)}`]),
                  ),
          },
        ],
      })),
      notes: snapshot.truncatedWorlds ? ["showing the first 32 particle worlds"] : [],
    };
  },
};

// ------------------------------------------------------------------ 21.8 streaming

const streamingTab: InspectorTab = {
  id: "streaming",
  title: "Streaming",
  filterHint: "asset, task or object",
  load(source, filter) {
    if (!source.streamer || !source.tasks) return note("the asset streamer or task scheduler is not exposed to the inspector");
    const snapshot = inspectStreaming(
      { streamer: source.streamer, tasks: source.tasks, currentScene: sceneOf(source) },
      { filter: filter || undefined, limit: 128 },
    );
    const rows: InspectorRow[] = [];
    for (const load of snapshot.assetLoads) {
      rows.push({
        key: `a:${load.id}`,
        label: `asset  ${load.id}`,
        badge: load.state,
        detail: () => [
          {
            fields: fields([
              ["kind", load.kind],
              ["state", load.state],
              ["priority", num(load.priority, 1)],
              ["sequence", load.sequence],
              ["estimated", bytes(load.estimatedBytes)],
              ["age", ms(load.ageMs)],
              ["load", ms(load.loadMs)],
            ]),
          },
        ],
      });
    }
    for (const task of snapshot.taskRecords) {
      rows.push({
        key: `k:${task.id}`,
        label: `task  ${task.name}`,
        badge: task.state,
        detail: () => [
          {
            fields: fields([
              ["key", task.key],
              ["priority", num(task.priority, 1)],
              ["state", task.state],
              ["age", ms(task.ageMs)],
              ["runtime", ms(task.runtimeMs)],
              ["progress", task.progress === null ? "—" : num(task.progress, 2)],
              ["cancel requested", task.cancelRequested],
            ]),
          },
        ],
      });
    }
    for (const object of snapshot.streamingObjects) {
      rows.push({
        key: `o:${object.name}`,
        label: `owner  ${object.name}`,
        badge: object.enabled ? "on" : "off",
        detail: () => [
          {
            fields: object.statsError
              ? fields([["stats error", object.statsError]])
              : fields(Object.entries(object.stats).map(([k, v]) => [k, v as string | number | boolean | null])),
          },
        ],
      });
    }
    const assets = snapshot.assets;
    const taskStats = snapshot.tasks;
    return {
      summary: [
        { label: "queued", value: int(assets.queued) },
        { label: "in flight", value: int(assets.inFlight) },
        { label: "failed", value: int(assets.failed) },
        { label: "budget", value: `${bytes(assets.budgetRemaining)} of ${bytes(assets.budgetBytes)}` },
        { label: "tasks", value: `${int(taskStats.running)}/${int(taskStats.workers)} workers` },
        { label: "owners", value: int(snapshot.streamingObjects.length) },
      ],
      rows,
      notes: [
        ...(snapshot.truncatedAssetLoads || snapshot.truncatedTasks || snapshot.truncatedObjects
          ? ["one or more lists hit their 128-row cap — narrow the filter for the rest"]
          : []),
        ...(rows.length === 0 ? ["nothing is in flight and no scene object reports streaming stats"] : []),
      ],
    };
  },
};

// ------------------------------------------------------------------ 21.9 environment

const environmentTab: InspectorTab = {
  id: "world",
  title: "World",
  overlay: {
    key: "environment",
    label: "sun / wind",
    draw(source) {
      const scene = sceneOf(source);
      const sink = lineSink(source);
      if (!scene || !sink) return 0;
      return drawEnvironmentDebug(scene, sink);
    },
  },
  load(source) {
    const scene = sceneOf(source);
    if (!scene) return note("no scene is active");
    const snapshot = inspectEnvironment(scene, { maxSystems: 4 });
    const group = (key: string, title: string, value: unknown, badge = ""): InspectorRow => ({
      key,
      label: title,
      badge,
      detail: () => [
        {
          fields: fields(
            Object.entries((value ?? {}) as Record<string, unknown>).map(([k, v]) => [
              k,
              Array.isArray(v)
                ? vec(v as number[], 3)
                : typeof v === "object" && v !== null
                  ? JSON.stringify(v)
                  : (v as string | number | boolean | null),
            ]),
          ),
        },
      ],
    });
    const rows: InspectorRow[] = [group("sun", "sun", snapshot.sun, snapshot.sun.source)];
    rows.push(group("atmosphere", "atmosphere", snapshot.atmosphere, snapshot.atmosphere.source));
    rows.push(group("clouds", "clouds", snapshot.clouds, snapshot.clouds.enabled ? "on" : "off"));
    rows.push(group("water", "water", snapshot.water, snapshot.water.enabled ? "on" : "off"));
    for (const [index, cycle] of snapshot.dayNight.entries()) rows.push(group(`daynight${index}`, `day/night  ${cycle.name ?? `#${index}`}`, cycle));
    for (const [index, weather] of snapshot.weather.entries()) {
      rows.push(group(`weather${index}`, `weather  ${weather.name}`, weather, String(weather.state)));
      rows.push(group(`wind${index}`, `wind + rain  ${weather.name}`, { wind: weather.wind, precipitationAtSample: weather.precipitationAtSample, samplePosition: weather.samplePosition }));
    }
    for (const [index, lightning] of snapshot.lightning.entries()) {
      rows.push(group(`lightning${index}`, `lightning  ${lightning.name}`, lightning, `${int(lightning.activeStrikes)} active`));
    }
    const firstWeather = snapshot.weather[0];
    const firstCycle = snapshot.dayNight[0];
    return {
      summary: [
        { label: "scene", value: snapshot.sceneName },
        { label: "cycle", value: firstCycle ? `${num(firstCycle.timeOfDay, 2)} h${firstCycle.isDay ? " day" : " night"}` : "—" },
        { label: "weather", value: firstWeather ? String(firstWeather.state) : "—" },
        { label: "bolts", value: int(snapshot.lightning.reduce((a, l) => a + l.activeStrikes, 0)) },
      ],
      rows,
      notes: [
        "sampled at " + vec(snapshot.samplePosition, 1),
        ...(snapshot.truncatedWeather || snapshot.truncatedDayNight || snapshot.truncatedLightning ? ["some systems were left out (maxSystems)"] : []),
      ],
    };
  },
};

export const INSPECTOR_TABS: readonly InspectorTab[] = [
  ecsTab,
  systemsTab,
  graphTab,
  gpuTab,
  physicsTab,
  terrainTab,
  particlesTab,
  streamingTab,
  environmentTab,
];
