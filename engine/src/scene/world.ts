/**
 * `EntityWorld` — entity ids, per-type component stores, hierarchy, transform storage and the
 * system scheduler. `Scene` is a thin policy layer on top of this.
 *
 * Guarantees that subsystem code may rely on:
 *  1. **Stable generational ids.** A stale `EntityId` never resolves to a different entity;
 *     `exists()` returns false instead.
 *  2. **O(1) component access** by (entity slot, type) through per-type stores.
 *  3. **Safe iteration.** Structural edits made during a system pass are journaled and applied
 *     when that pass returns, so `Query` iteration cannot observe a swap-remove mid-loop.
 *  4. **One transform pass.** `TransformSystem` computes world matrices in a single depth-ordered
 *     sweep and reports the changed slots, so visibility/rendering can skip static geometry.
 *  5. **Deterministic system order.** Ordering comes from `order` + `before`/`after`, not from
 *     registration sequence; a cycle is an error, not a silent reordering.
 *
 * Deliberately *not* here: rendering, physics, asset or engine concerns — those live in their own
 * subsystems and attach components (this file imports nothing from them).
 */

import { EventTarget2, type Disposable } from "../core/events.js";
import { ObjectDisposedError, UsageError } from "../core/errors.js";
import { FreeList, handleGeneration, makeHandle } from "../core/pool.js";
import { Mat4 } from "../math/mat.js";
import { TransformStore, TRS } from "../math/transform.js";
import { Vec3 } from "../math/vec.js";
import { Quat } from "../math/mat.js";
import { AABB } from "../math/geometry.js";
import { componentInfo, componentTypeById, type Component, type ComponentTypeInfo } from "./components.js";
import { entityGeneration, entitySlot, makeEntityId, NULL_ENTITY, type EntityId } from "./entityId.js";
import { ObjectStore, Query, type ComponentStorage } from "./stores.js";
import { TransformSystem, type ISystem, type SystemContext } from "./systems.js";

export interface EntityWorldOptions {
  initialCapacity?: number;
  /** Hard cap on live entities (guards runaway scripted spawns). 0 disables. */
  maxEntities?: number;
}

interface StructuralOp {
  kind: "add" | "remove" | "destroy";
  id: EntityId;
  component?: Component;
  typeId?: number;
}

export class EntityWorld {
  readonly transforms = new TransformStore(256);
  readonly events = {
    entityCreated: new EventTarget2<EntityId>(),
    entityDestroyed: new EventTarget2<EntityId>(),
    componentAdded: new EventTarget2<{ entity: EntityId; type: string }>(),
    componentRemoved: new EventTarget2<{ entity: EntityId; type: string }>(),
    hierarchyChanged: new EventTarget2<EntityId>(),
  };
  readonly systems: ISystem[] = [];

  private readonly freeList: FreeList;
  private readonly maxEntities: number;
  private readonly facades: (Entity | null)[] = [];
  private readonly names: (string | null)[] = [];
  /** entity slot → transform slot (-1 when the entity has no Transform component). */
  private readonly transformSlotOf: Int32Array = new Int32Array(0);
  private readonly stores = new Map<number, ComponentStorage<Component>>();
  private readonly queries = new Set<Query>();
  private readonly systemsByName = new Map<string, ISystem>();
  private readonly parentOfSlot = new Map<number, number>();
  private readonly childrenOfSlot = new Map<number, number[]>();
  private readonly localBoundsMap = new Map<number, AABB>();
  private readonly journal: StructuralOp[] = [];
  private journalDepth = 0;
  private generationCounter = 1;
  private liveEntities = 0;
  private componentCount = 0;
  private systemsSorted = false;
  private disposed = false;

  constructor(options: EntityWorldOptions = {}) {
    this.freeList = new FreeList(options.initialCapacity ?? 256);
    this.maxEntities = options.maxEntities ?? 0;
    this.registerSystem(new TransformSystem());
  }

  /**
   * Bumped on every structural change (add/remove component, create/destroy entity, rebind,
   * transform write). `Query` uses it as a validity token; listeners use it as a cheap
   * "the world changed" signal for caches (render batches, LOD tables, inspector).
   */
  get generation(): number {
    return this.generationCounter;
  }

  get liveEntityCount(): number {
    return this.liveEntities;
  }

  get componentCountValue(): number {
    return this.componentCount;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  // ------------------------------------------------------------------ entities

  exists(id: EntityId): boolean {
    if (id === NULL_ENTITY || this.disposed) return false;
    return this.freeList.isValid(makeHandle(entitySlot(id), entityGeneration(id)));
  }

  /** Slot for a live id, or -1. Hot path for systems: avoids re-validating twice. */
  slotOf(id: EntityId): number {
    return this.exists(id) ? entitySlot(id) : -1;
  }

  idForSlot(slot: number): EntityId {
    return makeEntityId(slot, this.freeList.generationOf(slot)) as EntityId;
  }

  createEntity(name?: string): Entity {
    if (this.disposed) throw new ObjectDisposedError("EntityWorld");
    if (this.maxEntities > 0 && this.liveEntities >= this.maxEntities) {
      throw new UsageError(`EntityWorld: live entity cap reached (${this.maxEntities})`);
    }
    const { slot, generation } = this.freeList.allocate();
    this.ensureSlotCapacity(slot);
    this.transformSlotOf[slot] = -1;
    this.names[slot] = name ?? null;
    const id = makeEntityId(slot, generation & 0xffff) as EntityId;
    const facade = new Entity(this, id);
    this.facades[slot] = facade;
    this.liveEntities++;
    this.generationCounter++;
    this.events.entityCreated.emit(id);
    return facade;
  }

  destroyEntity(id: EntityId): boolean {
    const slot = this.slotOf(id);
    if (slot < 0) return false;
    if (this.journalDepth > 0) {
      this.journal.push({ kind: "destroy", id });
      return true;
    }
    this.events.entityDestroyed.emit(id);
    for (const [typeId, store] of this.stores) {
      const c = store.get(slot);
      if (c) this.detachComponent(slot, typeId, c);
    }
    const parent = this.parentOfSlot.get(slot);
    if (parent !== undefined) {
      const kids = this.childrenOfSlot.get(parent);
      if (kids) {
        const i = kids.indexOf(slot);
        if (i >= 0) kids.splice(i, 1);
      }
      this.parentOfSlot.delete(slot);
      this.events.hierarchyChanged.emit(id);
    }
    // Orphans are destroyed with their owner: an entity whose parent disappears has no
    // meaningful place in the hierarchy, and silently re-parenting to the root leaks entities.
    const kids = this.childrenOfSlot.get(slot);
    if (kids && kids.length > 0) {
      const orphanIds = kids.map((k) => this.idForSlot(k));
      this.childrenOfSlot.delete(slot);
      for (const childId of orphanIds) this.destroyEntity(childId);
    } else {
      this.childrenOfSlot.delete(slot);
    }
    const t = this.transformSlotOf[slot]!;
    if (t > 0) {
      this.transforms.release(t);
      this.transformSlotOf[slot] = -1;
    }
    this.localBoundsMap.delete(slot);
    this.names[slot] = null;
    this.facades[slot] = null;
    this.freeList.release(slot);
    this.liveEntities--;
    this.generationCounter++;
    return true;
  }

  liveEntityIds(): EntityId[] {
    const out: EntityId[] = [];
    for (let slot = 0; slot < this.freeList.highWaterMark; slot++) {
      const handle = this.freeList.handleOf(slot);
      if (handle !== 0xffffffff && this.freeList.isValid(handle)) out.push(makeEntityId(slot, handleGeneration(handle)) as EntityId);
    }
    return out;
  }

  facade(id: EntityId): Entity | null {
    const slot = this.slotOf(id);
    return slot < 0 ? null : this.facades[slot];
  }

  name(id: EntityId): string {
    const slot = this.slotOf(id);
    return slot < 0 ? "<stale>" : (this.names[slot] ?? "");
  }

  setName(id: EntityId, name: string): void {
    const slot = this.slotOf(id);
    if (slot >= 0) this.names[slot] = name;
  }

  findByName(name: string): EntityId[] {
    const out: EntityId[] = [];
    for (const id of this.liveEntityIds()) if (this.name(id) === name) out.push(id);
    return out;
  }

  // ------------------------------------------------------------------ components

  addComponent<T extends Component>(id: EntityId, component: T): T {
    const slot = this.slotOf(id);
    if (slot < 0) throw new UsageError("addComponent: entity id is stale or destroyed");
    const info = componentInfo(component.constructor as new (...args: never[]) => Component);
    const existing = this.storeFor(info).get(slot);
    if (existing && existing !== component && !allowsMultiple(info)) {
      throw new UsageError(`Entity "${this.name(id)}" already has a ${info.name} component`);
    }
    if (this.journalDepth > 0) {
      component.entity = id;
      component._typeId = info.id;
      this.journal.push({ kind: "add", id, component });
      return component;
    }
    this.attachComponent(id, slot, component, info);
    return component;
  }

  /** @internal */
  attachComponent(id: EntityId, slot: number, component: Component, info: ComponentTypeInfo): void {
    const store = this.storeFor(info);
    component.entity = id;
    component._typeId = info.id;
    store.set(slot, component);
    this.componentCount++;
    this.generationCounter++;
    try {
      component.onAttach?.(this);
    } catch (e) {
      reportComponentError(`onAttach ${info.name}`, e);
    }
    this.events.componentAdded.emit({ entity: id, type: info.name });
  }

  removeComponent<T extends Component>(id: EntityId, ctor: new (...args: never[]) => T): boolean {
    const slot = this.slotOf(id);
    if (slot < 0) return false;
    const info = componentInfo(ctor as unknown as new (...args: never[]) => Component);
    const c = this.storeFor(info).get(slot);
    if (!c) return false;
    if (this.journalDepth > 0) {
      this.journal.push({ kind: "remove", id, typeId: info.id });
      return true;
    }
    this.detachComponent(slot, info.id, c);
    return true;
  }

  /** @internal */
  detachComponent(slot: number, typeId: number, component: Component): void {
    const info = this.typeInfo(typeId);
    try {
      component.onDetach?.(this);
    } catch (e) {
      reportComponentError(`onDetach ${info.name}`, e);
    }
    this.storeFor(info).remove(slot);
    this.componentCount--;
    this.generationCounter++;
    component.entity = NULL_ENTITY;
    component._typeId = -1;
    component._disposables?.dispose();
    component._disposables = undefined;
    try {
      component.dispose?.();
    } catch (e) {
      reportComponentError(`dispose ${info.name}`, e);
    }
    if (info.name === "Transform") {
      const t = this.transformSlotOf[slot]!;
      if (t > 0) {
        this.transforms.release(t);
        this.transformSlotOf[slot] = -1;
      }
    }
    this.events.componentRemoved.emit({ entity: this.idForSlot(slot), type: info.name });
  }

  getComponent<T extends Component>(id: EntityId, ctor: new (...args: never[]) => T): T | undefined {
    const slot = this.slotOf(id);
    if (slot < 0) return undefined;
    const info = componentInfo(ctor as unknown as new (...args: never[]) => Component);
    return this.storeFor(info).get(slot) as T | undefined;
  }

  hasComponent<T extends Component>(id: EntityId, ctor: new (...args: never[]) => T): boolean {
    const slot = this.slotOf(id);
    if (slot < 0) return false;
    return this.storeFor(componentInfo(ctor as unknown as new (...args: never[]) => Component)).has(slot);
  }

  componentsOf(id: EntityId): Component[] {
    const slot = this.slotOf(id);
    const out: Component[] = [];
    if (slot < 0) return out;
    for (const info of this.registeredTypes()) {
      const c = this.storeFor(info).get(slot);
      if (c) out.push(c);
    }
    return out;
  }

  componentTypesOf(id: EntityId): string[] {
    const slot = this.slotOf(id);
    const out: string[] = [];
    if (slot < 0) return out;
    for (const info of this.registeredTypes()) if (this.storeFor(info).has(slot)) out.push(info.name);
    return out;
  }

  /** @internal One store per component type *per world* — see `ComponentTypeInfo.createStore`. */
  storeFor(info: ComponentTypeInfo): ComponentStorage<Component> {
    let s = this.stores.get(info.id);
    if (!s) {
      s = info.createStore();
      this.stores.set(info.id, s);
    }
    return s;
  }

  /** @internal Implements `QueryWorld.storageOf`. */
  storageOf(typeId: number): ComponentStorage<unknown> | null {
    return (this.stores.get(typeId) ?? null) as ComponentStorage<unknown> | null;
  }

  registeredTypes(): ComponentTypeInfo[] {
    return [...this.stores.keys()].sort((a, b) => a - b).map((id) => this.typeInfo(id));
  }

  typeInfo(id: number): ComponentTypeInfo {
    const info = componentTypeById(id);
    if (!info) throw new UsageError(`Unknown component type id ${id}`);
    return info;
  }

  /** Object store for a component type, for systems that want raw array access. */
  store<T extends Component>(ctor: new (...args: never[]) => T): ObjectStore<T> {
    const info = componentInfo(ctor as unknown as new (...args: never[]) => Component);
    return this.storeFor(info) as unknown as ObjectStore<T>;
  }

  // ------------------------------------------------------------------ queries

  query(
    ctors: (new (...args: never[]) => Component)[],
    options: { anyOf?: (new (...args: never[]) => Component)[]; noneOf?: (new (...args: never[]) => Component)[] } = {},
  ): Query {
    const typeIds = ctors.map((c) => componentInfo(c as unknown as new (...args: never[]) => Component).id);
    const anyOf = (options.anyOf ?? []).map((c) => componentInfo(c as unknown as new (...args: never[]) => Component).id);
    const noneOf = (options.noneOf ?? []).map((c) => componentInfo(c as unknown as new (...args: never[]) => Component).id);
    const q = new Query(this, typeIds, anyOf, noneOf);
    this.queries.add(q);
    return q;
  }

  releaseQuery(q: Query): void {
    this.queries.delete(q);
    q.clear();
  }

  // ------------------------------------------------------------------ transforms

  transformSlot(id: EntityId, create = false): number {
    const slot = this.slotOf(id);
    if (slot < 0) return 0;
    let t = this.transformSlotOf[slot]!;
    if (t < 0 && create) {
      const parentId = this.parentOf(id);
      const parentSlot = parentId === NULL_ENTITY ? 0 : this.transformSlot(parentId, true);
      t = this.transforms.allocate(parentSlot, slot);
      this.transformSlotOf[slot] = t;
      this.generationCounter++;
    }
    return t < 0 ? 0 : t;
  }

  hasTransform(id: EntityId): boolean {
    const slot = this.slotOf(id);
    return slot >= 0 && this.transformSlotOf[slot]! > 0;
  }

  getTRS(id: EntityId, out = new TRS()): TRS {
    const t = this.transformSlot(id, true);
    return this.transforms.writeTRS(t, out);
  }

  setTRS(id: EntityId, position: Vec3, rotation: Quat, scale: Vec3): void {
    const t = this.transformSlot(id, true);
    this.transforms.setLocalTRS(t, position, rotation, scale);
    this.generationCounter++;
  }

  worldPosition(id: EntityId, out = new Vec3()): Vec3 {
    return this.transforms.getWorldPosition(this.transformSlot(id, true), out);
  }

  /**
   * World-space rotation, extracted from the composed world matrix. The store keeps matrices rather
   * than a second set of quaternions (one source of truth), so this decomposes; scale is discarded.
   */
  getWorldRotation(transformSlot: number, out: Quat): Quat {
    const m = new Mat4(this.transforms.worldView(transformSlot));
    m.decompose(SCRATCH_POS, out, SCRATCH_SCALE);
    return out;
  }

  /** World matrix of an entity's transform slot, written into `out`. */
  getWorldMatrix(id: EntityId, out: Mat4): Mat4 {
    out.m.set(this.transforms.worldView(this.transformSlot(id, true)));
    return out;
  }

  setLocalBounds(id: EntityId, box: AABB): void {
    const slot = this.slotOf(id);
    if (slot < 0) return;
    const existing = this.localBoundsMap.get(slot);
    if (existing) existing.setFrom(box.min, box.max);
    else this.localBoundsMap.set(slot, box.clone());
    this.generationCounter++;
  }

  localBounds(id: EntityId): AABB | undefined {
    const slot = this.slotOf(id);
    return slot < 0 ? undefined : this.localBoundsMap.get(slot);
  }

  markTransformDirty(id: EntityId): void {
    const t = this.transformSlotOf[this.slotOf(id)]!;
    if (t > 0) this.transforms.markDirty(t);
    this.generationCounter++;
  }

  /**
   * Recompute world matrices. Returns the number of slots that actually changed, and fills
   * `changedSlots` (a caller-owned array, cleared first) so systems can do targeted work.
   */
  updateTransforms(changedSlots: number[], force = false): number {
    this.transforms.updateWorld(changedSlots, force);
    this.generationCounter++;
    return changedSlots.length;
  }

  /** True when any world matrix changed since the last call (renderer uses this to skip uploads). */
  get transformsChangedEpoch(): number {
    return this.transforms.epoch;
  }

  // ------------------------------------------------------------------ hierarchy

  parentOf(id: EntityId): EntityId {
    const slot = this.slotOf(id);
    if (slot < 0) return NULL_ENTITY;
    const p = this.parentOfSlot.get(slot);
    return p === undefined ? NULL_ENTITY : this.idForSlot(p);
  }

  childrenOf(id: EntityId): EntityId[] {
    const slot = this.slotOf(id);
    const kids = slot < 0 ? undefined : this.childrenOfSlot.get(slot);
    if (!kids) return [];
    const out: EntityId[] = [];
    for (const k of kids) {
      const id = this.idForSlot(k);
      if (this.exists(id)) out.push(id);
    }
    return out;
  }

  setParent(child: EntityId, parent: EntityId | null): void {
    const cSlot = this.slotOf(child);
    if (cSlot < 0) throw new UsageError("setParent: child is stale");
    let pSlot = -1;
    if (parent !== null) {
      pSlot = this.slotOf(parent);
      if (pSlot < 0) throw new UsageError("setParent: parent entity is stale or destroyed");
    }
    if (pSlot === cSlot) throw new UsageError("setParent: an entity cannot be its own parent");
    if (pSlot >= 0) {
      let walk: number | undefined = pSlot;
      let guard = 0;
      while (walk !== undefined && guard++ < 256) {
        if (walk === cSlot) throw new UsageError("setParent: cycle detected");
        walk = this.parentOfSlot.get(walk);
      }
    }
    const old = this.parentOfSlot.get(cSlot);
    if (old !== undefined) {
      const list = this.childrenOfSlot.get(old);
      if (list) {
        const i = list.indexOf(cSlot);
        if (i >= 0) list.splice(i, 1);
      }
      this.parentOfSlot.delete(cSlot);
    }
    if (pSlot >= 0) {
      this.parentOfSlot.set(cSlot, pSlot);
      let kids = this.childrenOfSlot.get(pSlot);
      if (!kids) this.childrenOfSlot.set(pSlot, (kids = []));
      if (!kids.includes(cSlot)) kids.push(cSlot);
    }
    const t = this.transformSlotOf[cSlot]!;
    if (t > 0) {
      const parentTransform = pSlot >= 0 ? this.transformSlot(this.idForSlot(pSlot), true) : 0;
      this.transforms.setParent(t, parentTransform);
    }
    this.generationCounter++;
    this.events.hierarchyChanged.emit(child);
  }

  // ------------------------------------------------------------------ systems

  registerSystem(system: ISystem): Disposable {
    if (this.systemsByName.has(system.name)) throw new UsageError(`System "${system.name}" is already registered`);
    this.systems.push(system);
    this.systemsByName.set(system.name, system);
    this.systemsSorted = false;
    const self = this;
    return {
      dispose() {
        const i = self.systems.indexOf(system);
        if (i >= 0) self.systems.splice(i, 1);
        self.systemsByName.delete(system.name);
        self.systemsSorted = false;
      },
    };
  }

  systemByName(name: string): ISystem | undefined {
    return this.systemsByName.get(name);
  }

  /** Order systems by `order`, then satisfy `before`/`after` (fixed point; errors on a cycle). */
  sortSystems(): void {
    if (this.systemsSorted) return;
    const list = [...this.systems];
    list.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
    let changed = true;
    let passes = 0;
    while (changed) {
      changed = false;
      if (++passes > list.length * list.length + 4) {
        throw new UsageError(`System ordering cycle among: ${list.map((s) => s.name).join(", ")}`);
      }
      outer: for (let i = 0; i < list.length; i++) {
        for (const dep of list[i]!.after ?? []) {
          const j = list.findIndex((s) => s.name === dep);
          if (j > i) {
            moveSystem(list, j, i);
            changed = true;
            break outer;
          }
        }
        for (const dep of list[i]!.before ?? []) {
          const j = list.findIndex((s) => s.name === dep);
          if (j >= 0 && j < i) {
            moveSystem(list, i, j);
            changed = true;
            break outer;
          }
        }
      }
    }
    this.systems.length = 0;
    this.systems.push(...list);
    this.systemsSorted = true;
  }

  runSystems(context: SystemContext): void {
    this.sortSystems();
    for (const system of this.systems) {
      if (!system.enabled) continue;
      this.journalDepth++;
      try {
        system.update(context);
      } catch (e) {
        reportComponentError(`system ${system.name}`, e);
      } finally {
        this.journalDepth--;
        this.flushJournal();
      }
    }
  }

  flushJournal(): void {
    if (this.journal.length === 0 || this.disposed) return;
    const ops = this.journal.splice(0, this.journal.length);
    for (const op of ops) {
      if (!this.exists(op.id)) continue;
      const slot = entitySlot(op.id);
      switch (op.kind) {
        case "add": {
          const c = op.component!;
          const info = componentInfo(c.constructor as new (...args: never[]) => Component);
          this.attachComponent(op.id, slot, c, info);
          break;
        }
        case "remove": {
          const info = this.typeInfo(op.typeId!);
          const c = this.storeFor(info).get(slot);
          if (c) this.detachComponent(slot, info.id, c);
          break;
        }
        case "destroy":
          this.destroyEntity(op.id);
          break;
      }
    }
  }

  // ------------------------------------------------------------------ lifecycle

  dispose(): void {
    if (this.disposed) return;
    for (const id of this.liveEntityIds()) this.destroyEntity(id);
    for (const store of this.stores.values()) store.clear();
    for (const q of this.queries) q.clear();
    this.queries.clear();
    this.systems.length = 0;
    this.systemsByName.clear();
    this.parentOfSlot.clear();
    this.childrenOfSlot.clear();
    this.localBoundsMap.clear();
    for (const key of Object.keys(this.events) as (keyof typeof this.events)[]) this.events[key].clear();
    this.disposed = true;
  }

  private ensureSlotCapacity(slot: number): void {
    while (this.facades.length <= slot) {
      this.facades.push(null);
      this.names.push(null);
    }
    if (slot >= this.transformSlotOf.length) {
      const next = new Int32Array(Math.max(slot + 1, this.transformSlotOf.length * 2, 256)).fill(-1);
      next.set(this.transformSlotOf);
      (this as unknown as { transformSlotOf: Int32Array }).transformSlotOf = next;
    }
  }

  stats(): {
    entities: number;
    components: number;
    transformSlots: number;
    systems: number;
    queries: number;
    hierarchyDepth: number;
    byComponent: { name: string; count: number }[];
  } {
    let depth = 0;
    for (const slot of this.parentOfSlot.keys()) {
      let d = 0;
      let s: number | undefined = slot;
      while (s !== undefined && d < 64) {
        s = this.parentOfSlot.get(s);
        d++;
      }
      depth = Math.max(depth, d);
    }
    const byComponent: { name: string; count: number }[] = [];
    for (const info of this.registeredTypes()) byComponent.push({ name: info.name, count: this.storeFor(info).count });
    return {
      entities: this.liveEntities,
      components: this.componentCount,
      transformSlots: this.transforms.count,
      systems: this.systems.length,
      queries: this.queries.size,
      hierarchyDepth: depth,
      byComponent,
    };
  }
}

function allowsMultiple(info: ComponentTypeInfo): boolean {
  return (info as { allowMultiple?: boolean }).allowMultiple === true;
}

function moveSystem(list: ISystem[], from: number, to: number): void {
  const [item] = list.splice(from, 1);
  if (item) list.splice(to, 0, item);
}

const SCRATCH_POS = new Vec3();
const SCRATCH_SCALE = new Vec3(1, 1, 1);

const errorHandlers = new Set<(message: string, error: unknown) => void>();

/** Global hook so `Engine` can route ECS/lifecycle errors into its logger. */
export function setComponentErrorHandler(fn: (message: string, error: unknown) => void): Disposable {
  errorHandlers.add(fn);
  return { dispose: () => errorHandlers.delete(fn) };
}

function reportComponentError(context: string, error: unknown): void {
  if (errorHandlers.size > 0) for (const h of errorHandlers) h(context, error);
  else if (typeof console !== "undefined") console.error(`[forge:ecs] ${context} failed`, error);
}

/**
 * Entity facade: the ergonomic handle used by scripts and the editor. It stores an id and
 * revalidates through the world on every call, so a stale facade throws a clear
 * `ObjectDisposedError` rather than touching a recycled slot.
 */
export class Entity {
  /** @internal */ _id: EntityId;
  /** @internal */ _world: EntityWorld;

  /** @internal Constructed by `EntityWorld.createEntity`; use `Scene.createEntity`. */
  constructor(world: EntityWorld, id: EntityId) {
    this._world = world;
    this._id = id;
  }

  get id(): EntityId {
    return this._id;
  }

  get world(): EntityWorld {
    return this._world;
  }

  get isValid(): boolean {
    return this._world.exists(this._id);
  }

  get name(): string {
    return this._world.name(this._id);
  }

  set name(v: string) {
    this._world.setName(this._id, v);
  }

  add<T extends Component>(component: T): T {
    this.check();
    return this._world.addComponent(this._id, component);
  }

  remove<T extends Component>(ctor: new (...args: never[]) => T): boolean {
    this.check();
    return this._world.removeComponent(this._id, ctor);
  }

  get<T extends Component>(ctor: new (...args: never[]) => T): T | undefined {
    return this._world.getComponent(this._id, ctor);
  }

  require<T extends Component>(ctor: new (...args: never[]) => T): T {
    const c = this._world.getComponent(this._id, ctor);
    if (!c) throw new UsageError(`Entity "${this.name}" has no ${ctor.name} component`);
    return c;
  }

  has<T extends Component>(ctor: new (...args: never[]) => T): boolean {
    return this._world.hasComponent(this._id, ctor);
  }

  get components(): Component[] {
    return this._world.componentsOf(this._id);
  }

  get componentTypes(): string[] {
    return this._world.componentTypesOf(this._id);
  }

  get parent(): Entity | null {
    const p = this._world.parentOf(this._id);
    return p === NULL_ENTITY ? null : this._world.facade(p);
  }

  set parent(e: Entity | null) {
    this._world.setParent(this._id, e ? e._id : null);
  }

  get children(): Entity[] {
    return this._world.childrenOf(this._id).map((id) => this._world.facade(id)!) as Entity[];
  }

  addChild(child: Entity): void {
    this._world.setParent(child._id, this._id);
  }

  /** Transform access (allocates the entity's transform slot on first use). */
  get transform(): TransformHandle {
    return new TransformHandle(this._world, this._id);
  }

  setPosition(x: number, y: number, z: number): this {
    this._world.transforms.setPosition(this._world.transformSlot(this._id, true), x, y, z);
    return this;
  }

  getPosition(out = new Vec3()): Vec3 {
    return this._world.worldPosition(this._id, out);
  }

  destroy(): void {
    this._world.destroyEntity(this._id);
  }

  private check(): void {
    if (!this.isValid) throw new ObjectDisposedError(`Entity "${this.name || this._id}"`);
  }

  toString(): string {
    return `Entity(${this.name || "<unnamed>"} #${entitySlot(this._id)})`;
  }
}

/**
 * Transform accessor bound to an entity. Lives in the world's flat store; the handle is a
 * throwaway view (allocation-free to obtain from `Entity.transform`'s perspective is not
 * required — this object is small, short-lived and only used by authoring/script paths).
 */
export class TransformHandle {
  constructor(
    private readonly world: EntityWorld,
    private readonly id: EntityId,
  ) {}

  private slot(): number {
    return this.world.transformSlot(this.id, true);
  }

  get position(): Vec3 {
    const out = new Vec3();
    this.world.transforms.getPosition(this.slot(), out);
    return out;
  }

  set position(v: Vec3) {
    this.world.transforms.setPosition(this.slot(), v.x, v.y, v.z);
  }

  get rotation(): Quat {
    const q = new Quat();
    this.world.transforms.getRotation(this.slot(), q);
    return q;
  }

  set rotation(q: Quat) {
    this.world.transforms.setRotation(this.slot(), q);
  }

  get scale(): Vec3 {
    const out = new Vec3();
    this.world.transforms.getScale(this.slot(), out);
    return out;
  }

  set scale(v: Vec3) {
    this.world.transforms.setScale(this.slot(), v.x, v.y, v.z);
  }

  get worldMatrix(): Float32Array {
    return this.world.transforms.worldView(this.slot());
  }

  /** Aim the entity's local +Z at `target` (matches `Mat4.setLookAt`'s basis convention). */
  lookAt(target: Vec3, up = new Vec3(0, 1, 0)): void {
    const pos = this.position;
    const view = new Mat4().setLookAt(pos, target, up);
    // The look-at matrix is the *view* orientation (world→camera). The object's orientation is its
    // inverse; for an orthonormal 3×3 that is the transpose.
    const rot = new Quat();
    Quat.fromRotationMatrix(view.clone().transpose(), rot);
    this.rotation = rot;
  }

  translate(dx: number, dy: number, dz: number): void {
    const p = this.position;
    this.position = p.set(p.x + dx, p.y + dy, p.z + dz);
  }
}


