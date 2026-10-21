/**
 * Public authoring workspace for the rest of Phase 26.
 *
 * `EditorWorkspace` coordinates the DOM-free document model, multi-selection, creation/deletion,
 * gizmo commits, generic component fields, scene/material/particle authoring and specialist
 * diagnostic panels. It never steps or owns the scene; the host still owns the engine loop and save
 * lifecycle.
 */

import {
  Color,
  EventTarget2,
  ParticleComponent,
  ParticleWorld,
  Renderable,
  UsageError,
} from "@forge/engine";
import type {
  Engine,
  EntityId,
  EcsFieldValue,
  ResourceDescriptor,
  StreamedLoad,
  Scene,
} from "@forge/engine";
import {
  EDITOR_PANEL_IDS,
  inspectEditorPanel,
  type EditorPanelId,
  type EditorPanelSnapshot,
  type EditorPanelContext,
  type PanelDataById,
} from "./panels.js";
import { updateGizmoDrag, type GizmoDrag, type GizmoDragOptions } from "./gizmo.js";
import {
  EditorSession,
  type EditorCreateEntityOptions,
  type EditorDocumentChange,
  type EditorEntityInspector,
  type EditorHierarchyOptions,
  type EditorHierarchySnapshot,
  type EditorReparentOptions,
  type EditorTransformPatch,
} from "./session.js";

export interface EditorSelectionOptions {
  readonly additive?: boolean;
  readonly toggle?: boolean;
}

export interface MaterialEditPatch {
  readonly label?: string;
  readonly baseColor?: readonly [number, number, number, number?];
  readonly emissive?: readonly [number, number, number, number?];
  readonly emissiveStrength?: number;
  readonly metallic?: number;
  readonly roughness?: number;
  readonly opacity?: number;
  readonly normalScale?: number;
  readonly transparent?: boolean;
  readonly doubleSided?: boolean;
  readonly fogExempt?: boolean;
  readonly depthWrite?: boolean;
  readonly alphaTest?: number;
  readonly tiling?: readonly [number, number];
  readonly offset?: readonly [number, number];
}

export interface ParticleEditPatch {
  readonly rate?: number;
  readonly lifeMin?: number;
  readonly lifeMax?: number;
  readonly size?: number;
  readonly drag?: number;
  readonly maxEmitsPerFrame?: number;
  readonly position?: readonly [number, number, number];
  readonly direction?: readonly [number, number, number];
  readonly speedMin?: number;
  readonly speedMax?: number;
}

export interface TerrainEditPatch {
  readonly focus?: readonly [number, number, number];
  readonly focusForward?: readonly [number, number, number];
  readonly layeredMaterialsEnabled?: boolean;
}

export interface EditorWorkspaceChange {
  readonly kind: "selection" | "document" | "panel";
  readonly document?: EditorDocumentChange;
  readonly panel?: EditorPanelId;
}

export interface EditorWorkspaceOptions {
  readonly historyLimit?: number;
  readonly engine?: Engine | null;
}

/** One authoring workspace attached to one live scene. */
export class EditorWorkspace {
  readonly session: EditorSession;
  readonly scene: Scene;
  readonly engine: Engine | null;
  readonly changed = new EventTarget2<EditorWorkspaceChange>();

  private readonly selectedIds = new Set<EntityId>();
  private readonly selectionSubscription;
  private readonly documentSubscription;
  private preservingMultiSelection = false;
  private disposed = false;

  constructor(scene: Scene, options: EditorWorkspaceOptions = {}) {
    if (scene.world.isDisposed) throw new UsageError("EditorWorkspace requires a live Scene");
    this.scene = scene;
    this.engine = options.engine ?? null;
    this.session = new EditorSession(scene, { historyLimit: options.historyLimit });
    this.selectionSubscription = this.session.selectionChanged.on(({ current }) => {
      if (!this.preservingMultiSelection) {
        this.selectedIds.clear();
        if (current !== null) this.selectedIds.add(current);
      } else if (current !== null) {
        this.selectedIds.add(current);
      }
      this.changed.emit({ kind: "selection" });
    });
    this.documentSubscription = this.session.documentChanged.on((document) => {
      this.pruneSelection();
      this.changed.emit({ kind: "document", document });
    });
  }

  get selection(): readonly EntityId[] {
    this.assertActive();
    this.pruneSelection();
    return [...this.selectedIds];
  }

  get primarySelection(): EntityId | null {
    this.assertActive();
    this.pruneSelection();
    return this.session.selection;
  }

  hierarchy(options: EditorHierarchyOptions = {}): EditorHierarchySnapshot {
    this.assertActive();
    const snapshot = this.session.hierarchy(options);
    return {
      ...snapshot,
      rows: snapshot.rows.map((row) => ({ ...row, selected: this.selectedIds.has(row.id) })),
    };
  }

  inspect(id: EntityId | null = this.primarySelection): EditorEntityInspector | null {
    this.assertActive();
    return this.session.inspect(id);
  }

  select(id: EntityId | null, options: EditorSelectionOptions = {}): boolean {
    this.assertActive();
    if (id !== null && !this.scene.world.exists(id)) throw new UsageError(`Editor entity ${id} is stale or destroyed`);
    if (id === null || (!options.additive && !options.toggle)) {
      this.selectedIds.clear();
      if (id !== null) this.selectedIds.add(id);
      return this.session.select(id);
    }
    if (options.toggle) {
      if (this.selectedIds.has(id)) this.selectedIds.delete(id);
      else this.selectedIds.add(id);
    } else {
      this.selectedIds.add(id);
    }
    const primary = [...this.selectedIds][0] ?? null;
    this.preservingMultiSelection = true;
    try {
      this.session.select(primary);
    } finally {
      this.preservingMultiSelection = false;
    }
    return true;
  }

  selectMany(ids: readonly EntityId[], options: EditorSelectionOptions = {}): boolean {
    this.assertActive();
    for (const id of ids) if (!this.scene.world.exists(id)) throw new UsageError(`Editor entity ${id} is stale or destroyed`);
    if (!options.additive && !options.toggle) this.selectedIds.clear();
    for (const id of ids) {
      if (options.toggle && this.selectedIds.has(id)) this.selectedIds.delete(id);
      else this.selectedIds.add(id);
    }
    const primary = [...this.selectedIds][0] ?? null;
    this.preservingMultiSelection = true;
    try {
      this.session.select(primary);
    } finally {
      this.preservingMultiSelection = false;
    }
    return ids.length > 0;
  }

  setExpanded(id: EntityId, expanded: boolean): boolean {
    this.assertActive();
    return this.session.setExpanded(id, expanded);
  }

  renameEntity(id: EntityId, name: string): boolean {
    this.assertActive();
    return this.session.renameEntity(id, name);
  }

  reparentEntity(id: EntityId, parent: EntityId | null, options: EditorReparentOptions = {}): boolean {
    this.assertActive();
    return this.session.reparentEntity(id, parent, options);
  }

  setLocalTransform(id: EntityId, patch: EditorTransformPatch): boolean {
    this.assertActive();
    return this.session.setLocalTransform(id, patch);
  }

  /** Convert a host viewport hit into a patch without mutating the document. */
  previewGizmoDrag(drag: GizmoDrag, point: readonly [number, number, number], options: GizmoDragOptions = {}): EditorTransformPatch {
    this.assertActive();
    return updateGizmoDrag(drag, point, options);
  }

  /** Commit one gizmo drag as a single transform history entry. */
  commitGizmoDrag(id: EntityId, drag: GizmoDrag, point: readonly [number, number, number], options: GizmoDragOptions = {}): boolean {
    this.assertActive();
    return this.setLocalTransform(id, updateGizmoDrag(drag, point, options));
  }

  setComponentEnabled(id: EntityId, type: string, enabled: boolean): boolean {
    this.assertActive();
    return this.session.setComponentEnabled(id, type, enabled);
  }

  setComponentFields(id: EntityId, type: string, fields: Readonly<Record<string, EcsFieldValue>>): boolean {
    this.assertActive();
    return this.session.setComponentFields(id, type, fields);
  }

  createEntity(name = "", options: EditorCreateEntityOptions = {}): EntityId {
    this.assertActive();
    const id = this.session.createEntity(name, options);
    this.selectedIds.clear();
    this.selectedIds.add(id);
    return id;
  }

  duplicateEntity(id: EntityId, options: { readonly parent?: EntityId | null } = {}): EntityId {
    this.assertActive();
    const duplicate = this.session.duplicateEntity(id, options);
    this.selectedIds.clear();
    this.selectedIds.add(duplicate);
    return duplicate;
  }

  deleteEntity(id: EntityId = this.primarySelection ?? 0 as EntityId): boolean {
    this.assertActive();
    if (id === 0 || !this.scene.world.exists(id)) return false;
    const result = this.session.deleteEntity(id);
    this.selectedIds.delete(id);
    this.pruneSelection();
    return result;
  }

  /** Configure one material through an undoable, renderer-safe authoring command. */
  setMaterial(id: EntityId, patch: MaterialEditPatch): boolean {
    this.assertActive();
    const renderable = this.scene.world.getComponent(id, Renderable);
    const material = renderable?.material;
    if (!material) throw new UsageError(`Editor entity ${id} has no editable Material`);
    const before = captureMaterial(material);
    const after: MaterialState = {
      ...before,
      ...patch,
      baseColor: patch.baseColor
        ? [patch.baseColor[0]!, patch.baseColor[1]!, patch.baseColor[2]!, patch.baseColor[3] ?? before.baseColor[3]!] as const
        : before.baseColor,
      emissive: patch.emissive
        ? [patch.emissive[0]!, patch.emissive[1]!, patch.emissive[2]!, patch.emissive[3] ?? before.emissive[3]!] as const
        : before.emissive,
    };
    if (sameMaterial(before, after)) return false;
    const label = `Material ${material.label}`;
    this.session.history.execute({
      label,
      apply: () => applyMaterial(material, after),
      revert: () => applyMaterial(material, before),
    });
    this.changed.emit({ kind: "document" });
    return true;
  }

  /** Edit the active terrain world's focus/material presentation without changing its generation contract. */
  setTerrain(patch: TerrainEditPatch): boolean {
    this.assertActive();
    const world = this.scene.objects.find((object) => object.name === "TerrainWorld") as { focusPosition?: { x: number; y: number; z: number }; focusForward?: { x: number; y: number; z: number }; layeredMaterialsEnabled?: boolean; setLayeredMaterialsEnabled?: (enabled: boolean) => void } | undefined;
    if (!world || !world.focusPosition || !world.focusForward || typeof world.setLayeredMaterialsEnabled !== "function") {
      throw new UsageError("The scene has no editable TerrainWorld");
    }
    const before: TerrainEditPatch = {
      focus: [world.focusPosition.x, world.focusPosition.y, world.focusPosition.z],
      focusForward: [world.focusForward.x, world.focusForward.y, world.focusForward.z],
      layeredMaterialsEnabled: world.layeredMaterialsEnabled,
    };
    const editableWorld = world as {
      focusPosition: { x: number; y: number; z: number };
      focusForward: { x: number; y: number; z: number };
      layeredMaterialsEnabled?: boolean;
      setLayeredMaterialsEnabled: (enabled: boolean) => void;
    };
    const after: TerrainEditPatch = { ...before, ...patch };
    if (JSON.stringify(before) === JSON.stringify(after)) return false;
    const label = "Terrain settings";
    this.session.history.execute({
      label,
      apply: () => applyTerrainPatch(editableWorld, after),
      revert: () => applyTerrainPatch(editableWorld, before),
    });
    this.changed.emit({ kind: "document" });
    return true;
  }

  /** Configure the first CPU particle source, or the selected particle component. */
  setParticles(patch: ParticleEditPatch): boolean {
    this.assertActive();
    const component = this.primarySelection === null ? undefined : this.scene.world.getComponent(this.primarySelection, ParticleComponent);
    const source = component?.simulation ?? (this.scene.objects.find((object) => object instanceof ParticleWorld) as ParticleWorld | undefined)?.simulation;
    if (!source) throw new UsageError("The scene has no editable CPU particle source");
    const before = captureParticle(source);
    const after = { ...before, ...patch };
    if (JSON.stringify(before) === JSON.stringify(after)) return false;
    const label = "Particle settings";
    this.session.history.execute({
      label,
      apply: () => applyParticle(source, after),
      revert: () => applyParticle(source, before),
    });
    this.changed.emit({ kind: "document" });
    return true;
  }

  /** Apply a validated scene-settings patch (environment editor, post/material-independent). */
  setSceneSettings(patch: Record<string, unknown>): boolean {
    this.assertActive();
    const before = deepClone(this.scene.exportSettings()) as Record<string, unknown>;
    const after = mergeSettings(before, patch);
    if (JSON.stringify(before) === JSON.stringify(after)) return false;
    const label = "Scene settings";
    this.session.history.execute({
      label,
      apply: () => this.scene.importSettings(deepClone(after) as Record<string, unknown>),
      revert: () => this.scene.importSettings(deepClone(before) as Record<string, unknown>),
    });
    this.changed.emit({ kind: "document" });
    return true;
  }

  /** Request an asset through the engine's public streamer; the workspace does not retain a lease. */
  requestAsset<T>(descriptor: ResourceDescriptor<T>): StreamedLoad<T> {
    this.assertActive();
    if (!this.engine || this.engine.currentScene !== this.scene) throw new UsageError("Asset requests require an Engine attached to this scene");
    return this.engine.streamer.request(descriptor);
  }

  cancelAsset(id: string): boolean {
    this.assertActive();
    if (!this.engine || this.engine.currentScene !== this.scene) return false;
    return this.engine.streamer.cancel(id);
  }

  panel<K extends EditorPanelId>(id: K, options: { readonly filter?: string; readonly limit?: number } = {}): EditorPanelSnapshot<PanelDataById[K]> {
    this.assertActive();
    const context: EditorPanelContext = {
      scene: this.scene,
      engine: this.engine?.currentScene === this.scene ? this.engine : null,
      session: this.session,
      selectedId: this.primarySelection,
    };
    const snapshot = inspectEditorPanel(id, context, options) as EditorPanelSnapshot<PanelDataById[K]>;
    this.changed.emit({ kind: "panel", panel: id });
    return snapshot;
  }

  panels(): { [K in EditorPanelId]: EditorPanelSnapshot<PanelDataById[K]> } {
    const result = {} as { [K in EditorPanelId]: EditorPanelSnapshot<PanelDataById[K]> };
    for (const id of EDITOR_PANEL_IDS) result[id] = this.panel(id) as never;
    return result;
  }

  save(): ReturnType<Scene["serialize"]> {
    this.assertActive();
    return this.scene.serialize();
  }

  undo(): boolean {
    this.assertActive();
    return this.session.undo();
  }

  redo(): boolean {
    this.assertActive();
    return this.session.redo();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.selectionSubscription.dispose();
    this.documentSubscription.dispose();
    this.session.dispose();
    this.changed.clear();
    this.selectedIds.clear();
  }

  private pruneSelection(): void {
    for (const id of this.selectedIds) if (!this.scene.world.exists(id)) this.selectedIds.delete(id);
    const primary = this.session.selection;
    if (primary !== null && !this.selectedIds.has(primary)) this.selectedIds.add(primary);
  }

  private assertActive(): void {
    if (this.disposed) throw new UsageError("EditorWorkspace has been disposed");
    if (this.scene.world.isDisposed) throw new UsageError("EditorWorkspace scene has been disposed");
  }
}

interface MaterialState extends MaterialEditPatch {
  readonly label: string;
  readonly baseColor: readonly [number, number, number, number];
  readonly emissive: readonly [number, number, number, number];
  readonly emissiveStrength: number;
  readonly metallic: number;
  readonly roughness: number;
  readonly opacity: number;
  readonly normalScale: number;
  readonly transparent: boolean;
  readonly doubleSided: boolean;
  readonly fogExempt: boolean;
  readonly depthWrite: boolean;
  readonly alphaTest: number;
  readonly tiling: readonly [number, number];
  readonly offset: readonly [number, number];
}

function captureMaterial(material: NonNullable<Renderable["material"]>): MaterialState {
  return {
    label: material.label,
    baseColor: [material.baseColor.r, material.baseColor.g, material.baseColor.b, material.baseColor.a],
    emissive: [material.emissive.r, material.emissive.g, material.emissive.b, material.emissive.a],
    emissiveStrength: material.emissiveStrength,
    metallic: material.metallic,
    roughness: material.roughness,
    opacity: material.opacity,
    normalScale: material.normalScale,
    transparent: material.transparent,
    doubleSided: material.doubleSided,
    fogExempt: material.fogExempt,
    depthWrite: material.depthWrite,
    alphaTest: material.alphaTest,
    tiling: [material.tiling.x, material.tiling.y],
    offset: [material.offset.x, material.offset.y],
  };
}

function applyMaterial(material: NonNullable<Renderable["material"]>, state: MaterialEditPatch & Partial<MaterialState>): void {
  if (state.label !== undefined) material.label = state.label;
  if (state.baseColor !== undefined) material.setColor(new Color(state.baseColor[0]!, state.baseColor[1]!, state.baseColor[2]!, state.baseColor[3] ?? 1));
  if (state.emissive !== undefined) material.setEmissive(new Color(state.emissive[0]!, state.emissive[1]!, state.emissive[2]!, state.emissive[3] ?? 1));
  if (state.emissiveStrength !== undefined) material.emissiveStrength = finite(state.emissiveStrength, material.emissiveStrength);
  if (state.metallic !== undefined || state.roughness !== undefined) material.setMetallicRoughness(state.metallic ?? material.metallic, state.roughness ?? material.roughness);
  if (state.opacity !== undefined) material.opacity = finite(state.opacity, material.opacity);
  if (state.normalScale !== undefined) material.normalScale = finite(state.normalScale, material.normalScale);
  if (state.transparent !== undefined) material.transparent = state.transparent;
  if (state.doubleSided !== undefined) material.doubleSided = state.doubleSided;
  if (state.fogExempt !== undefined) material.fogExempt = state.fogExempt;
  if (state.depthWrite !== undefined) material.depthWrite = state.depthWrite;
  if (state.alphaTest !== undefined) material.alphaTest = Math.max(0, finite(state.alphaTest, material.alphaTest));
  if (state.tiling !== undefined) material.tiling.set(state.tiling[0]!, state.tiling[1]!);
  if (state.offset !== undefined) material.offset.set(state.offset[0]!, state.offset[1]!);
  material.markChanged();
}

function sameMaterial(a: MaterialState, b: MaterialState & MaterialEditPatch): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function applyTerrainPatch(world: { focusPosition: { x: number; y: number; z: number }; focusForward: { x: number; y: number; z: number }; layeredMaterialsEnabled?: boolean; setLayeredMaterialsEnabled: (enabled: boolean) => void }, patch: TerrainEditPatch): void {
  if (patch.focus) world.focusPosition.x = patch.focus[0]!, world.focusPosition.y = patch.focus[1]!, world.focusPosition.z = patch.focus[2]!;
  if (patch.focusForward) world.focusForward.x = patch.focusForward[0]!, world.focusForward.y = patch.focusForward[1]!, world.focusForward.z = patch.focusForward[2]!;
  if (patch.layeredMaterialsEnabled !== undefined) world.setLayeredMaterialsEnabled(patch.layeredMaterialsEnabled);
}

interface ParticleState extends ParticleEditPatch {
  readonly rate: number;
  readonly lifeMin: number;
  readonly lifeMax: number;
  readonly size: number;
  readonly drag: number;
  readonly maxEmitsPerFrame: number;
  readonly position: readonly [number, number, number];
  readonly direction: readonly [number, number, number];
  readonly speedMin: number;
  readonly speedMax: number;
}

function captureParticle(source: { emitter: { rate: number; lifeMin: number; lifeMax: number; size: number; position: { x: number; y: number; z: number }; jitter: { x: number; y: number; z: number }; cone: { direction: { x: number; y: number; z: number }; speedMin: number; speedMax: number } }; drag: number; maxEmitsPerFrame: number }): ParticleState {
  return {
    rate: source.emitter.rate,
    lifeMin: source.emitter.lifeMin,
    lifeMax: source.emitter.lifeMax,
    size: source.emitter.size,
    drag: source.drag,
    maxEmitsPerFrame: source.maxEmitsPerFrame,
    position: [source.emitter.position.x, source.emitter.position.y, source.emitter.position.z],
    direction: [source.emitter.cone.direction.x, source.emitter.cone.direction.y, source.emitter.cone.direction.z],
    speedMin: source.emitter.cone.speedMin,
    speedMax: source.emitter.cone.speedMax,
  };
}

function applyParticle(source: { emitter: { rate: number; lifeMin: number; lifeMax: number; size: number; position: { x: number; y: number; z: number }; cone: { direction: { x: number; y: number; z: number }; speedMin: number; speedMax: number } }; drag: number; maxEmitsPerFrame: number }, state: ParticleEditPatch & Partial<ParticleState>): void {
  if (state.rate !== undefined) source.emitter.rate = Math.max(0, finite(state.rate, source.emitter.rate));
  if (state.lifeMin !== undefined) source.emitter.lifeMin = Math.max(0, finite(state.lifeMin, source.emitter.lifeMin));
  if (state.lifeMax !== undefined) source.emitter.lifeMax = Math.max(source.emitter.lifeMin, finite(state.lifeMax, source.emitter.lifeMax));
  if (state.size !== undefined) source.emitter.size = Math.max(0, finite(state.size, source.emitter.size));
  if (state.drag !== undefined) source.drag = Math.max(0, finite(state.drag, source.drag));
  if (state.maxEmitsPerFrame !== undefined) source.maxEmitsPerFrame = Math.max(0, Math.floor(finite(state.maxEmitsPerFrame, source.maxEmitsPerFrame)));
  if (state.position) [source.emitter.position.x, source.emitter.position.y, source.emitter.position.z] = state.position as [number, number, number];
  if (state.direction) [source.emitter.cone.direction.x, source.emitter.cone.direction.y, source.emitter.cone.direction.z] = state.direction as [number, number, number];
  if (state.speedMin !== undefined) source.emitter.cone.speedMin = finite(state.speedMin, source.emitter.cone.speedMin);
  if (state.speedMax !== undefined) source.emitter.cone.speedMax = Math.max(source.emitter.cone.speedMin, finite(state.speedMax, source.emitter.cone.speedMax));
}

function mergeSettings(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out = deepClone(base) as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value) && out[key] && typeof out[key] === "object" && !Array.isArray(out[key])) {
      out[key] = mergeSettings(out[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      out[key] = deepClone(value);
    }
  }
  return out;
}

function deepClone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => deepClone(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = deepClone(item);
    return out;
  }
  return value;
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}
