/**
 * Component storage for the ECS.
 *
 * Design (ADR-005 "why not a full archetype store"):
 *  - One storage per component *type*, each holding two parallel arrays: `entityIds` (sorted-ish,
 *    dense) and `data`. Adding/removing is O(1) amortized via swap-remove; lookup is O(1) via a
 *    slot→index table (an Int32Array, not a Map — 6-10× faster in V8 for integer keys).
 *  - Queries iterate the *smallest* participating storage and test membership in the others via
 *    the same slot table, which is why `Query` is cheap even with 100k entities.
 *  - Archetype-style grouping would win for wide queries over many types, but costs a structural
 *    move (chunk copy) on every add/remove. Engines that add/remove components per frame (which
 *    gameplay scripts do) prefer this layout.
 *  - `StructStore` additionally keeps hot numeric fields in typed arrays *inside* the object, so
 *    systems that only read those fields do not chase pointers (see `TransformStore`).
 *
 * Structural edits are journaled and flushed at system boundaries, so no system can observe a
 * mutation while iterating (which would otherwise be the classic ECS crash).
 */

import { UsageError, assert } from "../core/errors.js";
import { entitySlot, type EntityId } from "./entityId.js";

export interface ComponentStorage<V = unknown> {
  readonly typeId: number;
  readonly name: string;
  readonly count: number;
  has(slot: number): boolean;
  get(slot: number): V | undefined;
  set(slot: number, value: V): void;
  remove(slot: number): boolean;
  indexOf(slot: number): number;
  entityAt(i: number): EntityId;
  valueAt(i: number): V;
  clear(): void;
  /** All live slots, for iteration by systems (do not mutate during iteration). */
  forEach(fn: (entity: EntityId, value: V, index: number) => void): void;
  debugCount(): number;
}

const EMPTY_TABLE_SIZE = 256;

/**
 * Object-valued storage: the common case (materials, scripts, renderers).
 * `data[i]` is the component instance for `entityIds[i]`.
 */
export class ObjectStore<V> implements ComponentStorage<V> {
  private entityIds: Int32Array;
  private slotToIndex: Int32Array;
  private data: (V | undefined)[];
  private _count = 0;
  private capacity: number;

  constructor(
    readonly typeId: number,
    readonly name: string,
    initialCapacity = 256,
  ) {
    this.capacity = Math.max(64, initialCapacity);
    this.entityIds = new Int32Array(this.capacity);
    this.slotToIndex = new Int32Array(EMPTY_TABLE_SIZE).fill(-1);
    this.data = new Array<V | undefined>(this.capacity).fill(undefined);
  }

  get count(): number {
    return this._count;
  }

  private ensureSlotCapacity(slot: number): void {
    if (slot < this.slotToIndex.length) return;
    let size = this.slotToIndex.length;
    while (size <= slot) size *= 2;
    const next = new Int32Array(size).fill(-1);
    next.set(this.slotToIndex);
    this.slotToIndex = next;
  }

  private ensureDataCapacity(): void {
    if (this._count < this.capacity) return;
    const cap = this.capacity * 2;
    const ids = new Int32Array(cap);
    ids.set(this.entityIds.subarray(0, this._count));
    const data = new Array<V | undefined>(cap).fill(undefined);
    for (let i = 0; i < this._count; i++) data[i] = this.data[i];
    this.entityIds = ids;
    this.data = data;
    this.capacity = cap;
  }

  has(slot: number): boolean {
    return slot < this.slotToIndex.length && this.slotToIndex[slot] !== -1;
  }

  indexOf(slot: number): number {
    return slot < this.slotToIndex.length ? this.slotToIndex[slot]! : -1;
  }

  get(slot: number): V | undefined {
    const i = this.indexOf(slot);
    return i < 0 ? undefined : this.data[i];
  }

  set(slot: number, value: V): void {
    this.ensureSlotCapacity(slot);
    const existing = this.slotToIndex[slot]!;
    if (existing >= 0) {
      this.data[existing] = value;
      return;
    }
    this.ensureDataCapacity();
    const i = this._count++;
    this.entityIds[i] = slot;
    this.data[i] = value;
    this.slotToIndex[slot] = i;
  }

  remove(slot: number): boolean {
    const i = this.indexOf(slot);
    if (i < 0) return false;
    const last = --this._count;
    const lastSlot = this.entityIds[last]!;
    this.entityIds[i] = lastSlot;
    this.data[i] = this.data[last];
    this.data[last] = undefined;
    this.slotToIndex[lastSlot] = i;
    this.slotToIndex[slot] = -1;
    return true;
  }

  entityAt(i: number): EntityId {
    return this.entityIds[i] as unknown as EntityId;
  }

  slotAt(i: number): number {
    return this.entityIds[i]!;
  }

  valueAt(i: number): V {
    return this.data[i] as V;
  }

  /** Live values, in storage order (the dense prefix; allocates a fresh array). */
  liveValues(): V[] {
    const out: V[] = [];
    for (let i = 0; i < this._count; i++) {
      const v = this.data[i];
      if (v !== undefined) out.push(v);
    }
    return out;
  }

  /** Raw arrays for systems that want to inline the membership test themselves. */
  get rawEntitySlots(): Int32Array {
    return this.entityIds;
  }

  get rawValues(): (V | undefined)[] {
    return this.data;
  }

  forEach(fn: (entity: EntityId, value: V, index: number) => void): void {
    for (let i = 0; i < this._count; i++) fn(this.entityIds[i] as unknown as EntityId, this.data[i] as V, i);
  }

  /** Move the element at `index` to the end (used by sort-based systems, e.g. render sorting). */
  moveToLast(index: number): void {
    if (index < 0 || index >= this._count) return;
    const slot = this.entityIds[index]!;
    const value = this.data[index];
    for (let i = index; i < this._count - 1; i++) {
      this.entityIds[i] = this.entityIds[i + 1]!;
      this.data[i] = this.data[i + 1];
      this.slotToIndex[this.entityIds[i]!] = i;
    }
    this.entityIds[this._count - 1] = slot;
    this.data[this._count - 1] = value;
    this.slotToIndex[slot] = this._count - 1;
  }

  /** Stable insertion by a comparison on values (render batching). O(n) per call: use in bulk. */
  sortValues(compare: (a: V, b: V) => number): void {
    const n = this._count;
    const order = new Int32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    const indices = Array.from(order);
    indices.sort((a, b) => compare(this.data[a] as V, this.data[b] as V));
    const ids = new Int32Array(this.capacity);
    const data = new Array<V | undefined>(this.capacity).fill(undefined);
    for (let i = 0; i < n; i++) {
      const src = indices[i]!;
      ids[i] = this.entityIds[src]!;
      data[i] = this.data[src];
    }
    this.entityIds = ids;
    this.data = data;
    for (let i = 0; i < n; i++) this.slotToIndex[this.entityIds[i]!] = i;
  }

  clear(): void {
    this.slotToIndex.fill(-1);
    this.data.fill(undefined, 0, this._count);
    this._count = 0;
  }

  debugCount(): number {
    return this._count;
  }

  /** Compact to the live size (used after bulk removals / on scene unload). */
  trim(): void {
    if (this.capacity === this._count) return;
    const cap = Math.max(64, this._count);
    const ids = new Int32Array(cap);
    ids.set(this.entityIds.subarray(0, this._count));
    const data = new Array<V | undefined>(cap).fill(undefined);
    for (let i = 0; i < this._count; i++) data[i] = this.data[i];
    this.entityIds = ids;
    this.data = data;
    this.capacity = cap;
  }
}

/**
 * Typed-array storage for struct components whose fields live in a Float32Array (transforms,
 * rigid bodies, particle headers). The object handle still exists for API ergonomics; the arrays
 * are the authority.
 */
export class StructStore<V> extends ObjectStore<V> {
  values: Float32Array;
  ints: Int32Array;

  constructor(
    typeId: number,
    name: string,
    readonly floatsPerEntity: number,
    readonly intsPerEntity: number,
    initialCapacity = 256,
  ) {
    super(typeId, name, initialCapacity);
    this.values = new Float32Array(this.capacityOf(initialCapacity) * floatsPerEntity);
    this.ints = new Int32Array(this.capacityOf(initialCapacity) * intsPerEntity);
  }

  private capacityOf(c: number): number {
    return Math.max(64, c);
  }

  /** Float offset for a packed index. */
  offset(index: number): number {
    return index * this.floatsPerEntity;
  }

  intOffset(index: number): number {
    return index * this.intsPerEntity;
  }

  copyFrom(src: Float32Array, index: number, srcOffset = 0): void {
    this.values.set(src.subarray(srcOffset, srcOffset + this.floatsPerEntity), this.offset(index));
  }

  copyTo(index: number, dst: Float32Array, dstOffset = 0): void {
    dst.set(this.values.subarray(this.offset(index), this.offset(index) + this.floatsPerEntity), dstOffset);
  }
}

/**
 * Query: iterate entities holding all of the requested component types.
 *
 * Usage:
 * ```ts
 * const q = world.query([Transform, MeshRenderer]);
 * for (let i = 0, n = q.count; i < n; i++) {
 *   const t = q.value(0, i); // store for the first type at row i
 * }
 * ```
 * The hot form is `q.rows` + direct store access; `forEach`/`entries()` are for tools.
 */
/** The part of the world a query needs; `EntityWorld` satisfies this structurally. */
export interface QueryWorld {
  storageOf(typeId: number): ComponentStorage<unknown> | null;
  idForSlot(slot: number): EntityId;
  readonly generation: number;
}

export class Query {
  private stores: ComponentStorage[];
  /** Indices of the driving store's rows that currently satisfy the query. */
  readonly rows: number[] = [];
  /** Entities matching the query (parallel to `rows`). */
  readonly entities: EntityId[] = [];

  /** World generation at the time this query was last rebuilt (0 = never). */
  private worldGeneration = -1;

  constructor(
    private readonly world: QueryWorld,
    readonly typeIds: number[],
    readonly anyOf: number[] = [],
    readonly noneOf: number[] = [],
  ) {
    assert(typeIds.length > 0, "Query requires at least one component type");
    this.stores = typeIds.map((id) => {
      const s = this.world.storageOf(id);
      if (!s) throw new UsageError(`Query type ${id} is not registered`);
      return s;
    });
  }

  get count(): number {
    return this.rows.length;
  }

  /** Rebuild the matching row set if the world changed since the last rebuild. */
  refresh(): void {
    if (this.worldGeneration === this.world.generation) return;
    this.rebuild();
  }

  private rebuild(): void {
    this.worldGeneration = this.world.generation;
    // Drive from the smallest store: the membership test per candidate is O(1).
    let driving = this.stores[0]!;
    for (const s of this.stores) if (s.count < driving.count) driving = s;
    this.rows.length = 0;
    this.entities.length = 0;
    const others = this.stores.filter((s) => s !== driving);
    const n = driving.count;
    for (let i = 0; i < n; i++) {
      const slot = (driving as ObjectStore<unknown>).slotAt(i);
      let ok = true;
      for (const s of others) {
        if (!s.has(slot)) {
          ok = false;
          break;
        }
      }
      if (ok && this.anyOf.length > 0) {
        ok = false;
        for (const id of this.anyOf) {
          const s = this.world.storageOf(id);
          if (s?.has(slot)) {
            ok = true;
            break;
          }
        }
      }
      if (ok && this.noneOf.length > 0) {
        for (const id of this.noneOf) {
          const s = this.world.storageOf(id);
          if (s?.has(slot)) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        this.rows.push(i);
        this.entities.push(this.world.idForSlot(slot));
      }
    }
  }

  /** Entity slot of row `r` (systems that index typed arrays directly). */
  slotAt(r: number): number {
    return entitySlot(this.entities[r]!);
  }

  /** Value of type `t` (index into the query's type list) for row `r`. */
  value(t: number, r: number): unknown {
    const store = this.stores[t]!;
    const slot = (store as ObjectStore<unknown>).slotAt(this.rows[r]!);
    return store.get(slot);
  }

  entity(r: number): EntityId {
    return this.entities[r]!;
  }

  store<T>(t: number): ObjectStore<T> {
    return this.stores[t] as unknown as ObjectStore<T>;
  }

  /** Forget cached rows (called when the owner releases the query). */
  clear(): void {
    this.rows.length = 0;
    this.entities.length = 0;
    this.worldGeneration = -1;
  }

  /** Stores, ensuring the row set is current first. */
  resolve(): { stores: ComponentStorage[]; rows: number[]; entities: EntityId[] } {
    this.refresh();
    return { stores: this.stores, rows: this.rows, entities: this.entities };
  }

  forEach(fn: (entity: EntityId, values: unknown[]) => void): void {
    this.refresh();
    const scratch: unknown[] = new Array(this.stores.length);
    for (let r = 0; r < this.rows.length; r++) {
      for (let t = 0; t < this.stores.length; t++) scratch[t] = this.value(t, r);
      fn(this.entities[r]!, scratch);
    }
  }

  [Symbol.iterator](): IterableIterator<[EntityId, unknown[]]> {
    const out: [EntityId, unknown[]][] = [];
    this.forEach((e, v) => out.push([e, [...v]]));
    return out[Symbol.iterator]();
  }
}
