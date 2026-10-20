/**
 * Scene hierarchy and selected-entity authoring model for Phase 26.
 *
 * This package never reaches into `engine/src`: every read and edit goes through symbols exported by
 * `@forge/engine`. The model is DOM-free so a retained-mode Forge UI, a browser DOM shell, tests, or
 * an external tool can consume the same deterministic plain-data snapshots.
 */

import {
  EventTarget2,
  NULL_ENTITY,
  Quat,
  Transform,
  UsageError,
  Vec3,
  entitySlot,
  inspectEntity,
  tryComponentInfoByName,
} from "@forge/engine";
import type {
  Component,
  Disposable,
  EcsFieldValue,
  Entity,
  EntityId,
  EntityWorld,
  Scene,
} from "@forge/engine";
import { EditorHistory } from "./history.js";

export type EditorVec3 = readonly [number, number, number];
export type EditorQuat = readonly [number, number, number, number];

export interface EditorTransformState {
  readonly position: EditorVec3;
  readonly rotation: EditorQuat;
  readonly scale: EditorVec3;
}

export interface EditorTransformPatch {
  readonly position?: EditorVec3;
  readonly rotation?: EditorQuat;
  readonly scale?: EditorVec3;
}

export interface EditorHierarchyOptions {
  /** Case-insensitive name substring or exact component type. Matching rows include their ancestors. */
  filter?: string;
  /** Maximum visible rows. Defaults to 2,000; zero is allowed. */
  limit?: number;
}

export interface EditorHierarchyRow {
  readonly id: EntityId;
  readonly name: string;
  readonly label: string;
  readonly parent: EntityId | null;
  readonly depth: number;
  readonly childCount: number;
  readonly components: readonly string[];
  readonly selected: boolean;
  readonly expanded: boolean;
  readonly matchesFilter: boolean;
}

export interface EditorHierarchySnapshot {
  readonly generation: number;
  readonly totalEntities: number;
  readonly matchingEntities: number;
  readonly filter: string;
  readonly rows: readonly EditorHierarchyRow[];
  readonly truncated: boolean;
}

export interface EditorComponentInspector {
  readonly type: string;
  readonly group: string;
  readonly enabled: boolean;
  readonly fields: Readonly<Record<string, EcsFieldValue>>;
}

export interface EditorEntityInspector {
  readonly id: EntityId;
  readonly name: string;
  readonly parent: EntityId | null;
  readonly children: readonly EntityId[];
  readonly transform: EditorTransformState | null;
  readonly components: readonly EditorComponentInspector[];
}

export interface EditorSelectionChange {
  readonly previous: EntityId | null;
  readonly current: EntityId | null;
}

export type EditorDocumentChangeKind = "rename" | "reparent" | "transform" | "component";

export interface EditorDocumentChange {
  readonly kind: EditorDocumentChangeKind;
  readonly entity: EntityId;
  readonly label: string;
}

export interface EditorSessionOptions {
  /** Maximum retained undo entries. Defaults to 100. */
  historyLimit?: number;
}

/** Public-API-only authoring session for one live {@link Scene}. The session never owns the scene. */
export class EditorSession {
  readonly history: EditorHistory;
  readonly selectionChanged = new EventTarget2<EditorSelectionChange>();
  readonly documentChanged = new EventTarget2<EditorDocumentChange>();

  private selectedId: EntityId | null = null;
  private readonly collapsed = new Set<EntityId>();
  private readonly destroyedSubscription: Disposable;
  private disposed = false;

  constructor(readonly scene: Scene, options: EditorSessionOptions = {}) {
    if (scene.world.isDisposed) throw new UsageError("EditorSession requires a live Scene");
    this.history = new EditorHistory({ limit: options.historyLimit });
    this.destroyedSubscription = scene.world.events.entityDestroyed.on((id) => {
      this.collapsed.delete(id);
      if (this.selectedId === id) this.setSelection(null);
      // A command may retain an old parent/component identity. External destruction invalidates that
      // assumption, so fail closed instead of keeping an undo entry that can edit the wrong object.
      this.history.clear();
    });
  }

  get world(): EntityWorld {
    return this.scene.world;
  }

  get selection(): EntityId | null {
    this.assertActive();
    this.synchroniseSelection();
    return this.selectedId;
  }

  select(id: EntityId | null): boolean {
    this.assertActive();
    if (id !== null) this.requireEntity(id);
    return this.setSelection(id);
  }

  /** Build a stable root-first, pre-order hierarchy view without mutating the world. */
  hierarchy(options: EditorHierarchyOptions = {}): EditorHierarchySnapshot {
    this.assertActive();
    this.synchroniseSelection();
    const requestedLimit = options.limit ?? 2_000;
    const limit = Number.isFinite(requestedLimit) ? Math.max(0, Math.floor(requestedLimit)) : 2_000;
    const filter = options.filter?.trim() ?? "";
    const needle = filter.toLowerCase();
    const ids = this.world.liveEntityIds();
    const idSet = new Set(ids);
    const parents = new Map<EntityId, EntityId | null>();
    const children = new Map<EntityId, EntityId[]>();
    const componentTypes = new Map<EntityId, string[]>();
    const directMatches = new Set<EntityId>();

    for (const id of ids) {
      const rawParent = this.world.parentOf(id);
      const parent = rawParent === NULL_ENTITY || !idSet.has(rawParent) ? null : rawParent;
      parents.set(id, parent);
      children.set(id, this.world.childrenOf(id).filter((child) => idSet.has(child)));
      const types = this.world.componentTypesOf(id);
      componentTypes.set(id, types);
      const name = this.world.name(id);
      if (!needle || name.toLowerCase().includes(needle) || types.some((type) => type.toLowerCase() === needle)) {
        directMatches.add(id);
      }
    }

    const included = new Set(directMatches);
    if (needle) {
      for (const match of directMatches) {
        let parent = parents.get(match) ?? null;
        let guard = 0;
        while (parent !== null && guard++ <= ids.length) {
          included.add(parent);
          parent = parents.get(parent) ?? null;
        }
      }
    }

    const roots = ids.filter((id) => parents.get(id) === null);
    const stack: { id: EntityId; depth: number }[] = [];
    for (let i = roots.length - 1; i >= 0; i--) stack.push({ id: roots[i]!, depth: 0 });

    const rows: EditorHierarchyRow[] = [];
    let truncated = false;
    while (stack.length > 0) {
      const entry = stack.pop()!;
      if (!included.has(entry.id)) continue;
      if (rows.length >= limit) {
        truncated = true;
        break;
      }
      const name = this.world.name(entry.id);
      const childIds = children.get(entry.id) ?? [];
      const expanded = needle.length > 0 || !this.collapsed.has(entry.id);
      rows.push({
        id: entry.id,
        name,
        label: name || `Entity ${entitySlot(entry.id)}`,
        parent: parents.get(entry.id) ?? null,
        depth: entry.depth,
        childCount: childIds.length,
        components: [...(componentTypes.get(entry.id) ?? [])],
        selected: this.selectedId === entry.id,
        expanded,
        matchesFilter: directMatches.has(entry.id),
      });
      if (!expanded) continue;
      for (let i = childIds.length - 1; i >= 0; i--) {
        const child = childIds[i]!;
        if (included.has(child)) stack.push({ id: child, depth: entry.depth + 1 });
      }
    }

    return {
      generation: this.world.generation,
      totalEntities: ids.length,
      matchingEntities: directMatches.size,
      filter,
      rows,
      truncated,
    };
  }

  isExpanded(id: EntityId): boolean {
    this.assertActive();
    this.requireEntity(id);
    return !this.collapsed.has(id);
  }

  setExpanded(id: EntityId, expanded: boolean): boolean {
    this.assertActive();
    this.requireEntity(id);
    const wasExpanded = !this.collapsed.has(id);
    if (wasExpanded === expanded) return false;
    if (expanded) this.collapsed.delete(id);
    else this.collapsed.add(id);
    return true;
  }

  toggleExpanded(id: EntityId): boolean {
    return this.setExpanded(id, !this.isExpanded(id));
  }

  inspect(id: EntityId | null = this.selection): EditorEntityInspector | null {
    this.assertActive();
    if (id === null) return null;
    const detail = inspectEntity(this.world, id);
    if (!detail) {
      if (this.selectedId === id) this.setSelection(null);
      return null;
    }
    const transform = this.world.hasTransform(id) ? transformState(this.world, id) : null;
    return {
      id,
      name: detail.name,
      parent: detail.parent === NULL_ENTITY ? null : detail.parent,
      children: this.world.childrenOf(id),
      transform,
      components: detail.detail.map((component): EditorComponentInspector => ({
        type: component.type,
        group: tryComponentInfoByName(component.type)?.editorGroup ?? component.type,
        enabled: component.enabled,
        fields: component.type === "Transform" && transform
          ? {
              position: [...transform.position],
              rotation: [...transform.rotation],
              scale: [...transform.scale],
            }
          : { ...component.fields },
      })),
    };
  }

  renameEntity(id: EntityId, name: string): boolean {
    this.assertActive();
    const entity = this.requireEntity(id);
    const previous = entity.name;
    if (previous === name) return false;
    const label = `Rename ${previous || `Entity ${entitySlot(id)}`}`;
    this.history.execute({
      label,
      apply: () => {
        this.requireEntity(id).name = name;
        this.emitDocumentChange("rename", id, label);
      },
      revert: () => {
        this.requireEntity(id).name = previous;
        this.emitDocumentChange("rename", id, label);
      },
    });
    return true;
  }

  /** Reparent while retaining local TRS. World-space pose may therefore change under a new parent. */
  reparentEntity(id: EntityId, parent: EntityId | null): boolean {
    this.assertActive();
    this.requireEntity(id);
    if (parent !== null) this.requireEntity(parent);
    const previousRaw = this.world.parentOf(id);
    const previous = previousRaw === NULL_ENTITY ? null : previousRaw;
    if (previous === parent) return false;
    const label = `Reparent ${this.world.name(id) || `Entity ${entitySlot(id)}`}`;
    this.history.execute({
      label,
      apply: () => {
        this.requireEntity(id);
        if (parent !== null) this.requireEntity(parent);
        this.world.setParent(id, parent);
        this.emitDocumentChange("reparent", id, label);
      },
      revert: () => {
        this.requireEntity(id);
        if (previous !== null) this.requireEntity(previous);
        this.world.setParent(id, previous);
        this.emitDocumentChange("reparent", id, label);
      },
    });
    return true;
  }

  setLocalTransform(id: EntityId, patch: EditorTransformPatch): boolean {
    this.assertActive();
    this.requireTransform(id);
    const previous = transformState(this.world, id);
    const next: EditorTransformState = {
      position: patch.position ? copyVec3("position", patch.position) : previous.position,
      rotation: patch.rotation ? copyQuat(patch.rotation) : previous.rotation,
      scale: patch.scale ? copyVec3("scale", patch.scale) : previous.scale,
    };
    if (sameTransform(previous, next)) return false;
    const label = `Transform ${this.world.name(id) || `Entity ${entitySlot(id)}`}`;
    this.history.execute({
      label,
      apply: () => {
        this.applyTransform(id, next);
        this.emitDocumentChange("transform", id, label);
      },
      revert: () => {
        this.applyTransform(id, previous);
        this.emitDocumentChange("transform", id, label);
      },
    });
    return true;
  }

  setComponentEnabled(id: EntityId, type: string, enabled: boolean): boolean {
    this.assertActive();
    const component = this.requireComponent(id, type);
    const previous = component.enabled;
    if (previous === enabled) return false;
    const label = `${enabled ? "Enable" : "Disable"} ${type}`;
    const resolve = (): Component => {
      const current = this.requireComponent(id, type);
      if (current !== component) throw new UsageError(`Editor command target ${type} on entity ${id} was replaced`);
      return current;
    };
    this.history.execute({
      label,
      apply: () => {
        resolve().enabled = enabled;
        this.emitDocumentChange("component", id, label);
      },
      revert: () => {
        resolve().enabled = previous;
        this.emitDocumentChange("component", id, label);
      },
    });
    return true;
  }

  undo(): boolean {
    this.assertActive();
    return this.history.undo();
  }

  redo(): boolean {
    this.assertActive();
    return this.history.redo();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.destroyedSubscription.dispose();
    this.history.clear();
    this.history.changed.clear();
    this.selectionChanged.clear();
    this.documentChanged.clear();
    this.collapsed.clear();
    this.selectedId = null;
  }

  private applyTransform(id: EntityId, state: EditorTransformState): void {
    this.requireTransform(id);
    const position = new Vec3(state.position[0], state.position[1], state.position[2]);
    const rotation = new Quat(state.rotation[0], state.rotation[1], state.rotation[2], state.rotation[3]);
    const scale = new Vec3(state.scale[0], state.scale[1], state.scale[2]);
    const component = this.world.getComponent(id, Transform);
    if (component) {
      component.setPosition(position.x, position.y, position.z);
      component.setRotation(rotation);
      component.setScale(scale.x, scale.y, scale.z);
      this.world.markTransformDirty(id);
    } else {
      // Public Entity/TransformHandle APIs can allocate a transform slot without attaching the
      // component. Keep those authoring-only entities editable too.
      this.world.setTRS(id, position, rotation, scale);
    }
  }

  private requireEntity(id: EntityId): Entity {
    const entity = this.world.facade(id);
    if (!entity) throw new UsageError(`Editor entity ${id} is stale or destroyed`);
    return entity;
  }

  private requireTransform(id: EntityId): void {
    this.requireEntity(id);
    if (!this.world.hasTransform(id)) {
      throw new UsageError(`Editor entity ${id} has no Transform component`);
    }
  }

  private requireComponent(id: EntityId, type: string): Component {
    this.requireEntity(id);
    const info = tryComponentInfoByName(type);
    if (!info) throw new UsageError(`Editor component type "${type}" is not registered`);
    const component = this.world.getComponent(id, info.ctor);
    if (!component) throw new UsageError(`Editor entity ${id} has no ${type} component`);
    return component;
  }

  private synchroniseSelection(): void {
    if (this.selectedId !== null && !this.world.exists(this.selectedId)) this.setSelection(null);
  }

  private setSelection(id: EntityId | null): boolean {
    if (this.selectedId === id) return false;
    const previous = this.selectedId;
    this.selectedId = id;
    this.selectionChanged.emit({ previous, current: id });
    return true;
  }

  private emitDocumentChange(kind: EditorDocumentChangeKind, entity: EntityId, label: string): void {
    this.documentChanged.emit({ kind, entity, label });
  }

  private assertActive(): void {
    if (this.disposed) throw new UsageError("EditorSession has been disposed");
    if (this.world.isDisposed) throw new UsageError("EditorSession scene has been disposed");
  }
}

function transformState(world: EntityWorld, id: EntityId): EditorTransformState {
  const trs = world.getTRS(id);
  return {
    position: [trs.position.x, trs.position.y, trs.position.z],
    rotation: [trs.rotation.x, trs.rotation.y, trs.rotation.z, trs.rotation.w],
    scale: [trs.scale.x, trs.scale.y, trs.scale.z],
  };
}

function copyVec3(label: string, value: EditorVec3): EditorVec3 {
  if (value.length !== 3 || !value.every(Number.isFinite)) {
    throw new UsageError(`Editor transform ${label} must contain three finite numbers`);
  }
  return [value[0], value[1], value[2]];
}

function copyQuat(value: EditorQuat): EditorQuat {
  if (value.length !== 4 || !value.every(Number.isFinite)) {
    throw new UsageError("Editor transform rotation must contain four finite numbers");
  }
  const lengthSquared = value[0] * value[0] + value[1] * value[1] + value[2] * value[2] + value[3] * value[3];
  if (!(lengthSquared > 0)) throw new UsageError("Editor transform rotation cannot be the zero quaternion");
  return [value[0], value[1], value[2], value[3]];
}

function sameTransform(a: EditorTransformState, b: EditorTransformState): boolean {
  return sameTuple(a.position, b.position) && sameTuple(a.rotation, b.rotation) && sameTuple(a.scale, b.scale);
}

function sameTuple(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
