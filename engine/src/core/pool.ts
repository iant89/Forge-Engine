/**
 * Memory tools: object pooling, free lists, integer stacks and growable typed-array buffers.
 *
 * The engine's rule is "no per-frame allocation". These are the primitives that make that
 * practical without hand-rolled index juggling in every subsystem:
 *
 *  - `ObjectPool`   — reusable JS objects (render commands, hits, packets).
 *  - `FreeList`     — O(1) slot alloc/release with generational validation, the basis for ECS
 *                     storage and GPU resource slots.
 *  - `IntStack`     — allocation-free LIFO of ints (traversal worklists, stack of indices).
 *  - `FloatBuffer`/`Uint32Buffer` — growable typed-array writers for GPU uploads.
 *
 * Pools never hold on to references they did not create when the caller passes a factory, and
 * every pool reports `outstanding` so leak/abuse shows up in `stats`.
 */

import { assert } from "./errors.js";
import { alignUp } from "../math/scalar.js";

export interface Poolable {
  /** Called when released back to the pool. Must leave the object safe to re-obtain. */
  reset(): void;
}

export interface PoolOptions {
  /** Pre-created instances (avoids a stall on the first burst of frames). */
  prewarm?: number;
  /** Soft cap; beyond it `release()` drops the object instead of keeping it (bounds memory). */
  maxRetained?: number;
  name?: string;
}

export class ObjectPool<T extends object> {
  private free: T[] = [];
  private created = 0;
  private acquired = 0;
  private outstanding = 0;
  private discarded = 0;

  constructor(
    private readonly factory: () => T,
    private readonly options: PoolOptions = {},
  ) {
    const prewarm = options.prewarm ?? 0;
    for (let i = 0; i < prewarm; i++) this.free.push(this.create());
  }

  private create(): T {
    this.created++;
    return this.factory();
  }

  obtain(): T {
    let obj = this.free.pop();
    if (!obj) obj = this.create();
    this.acquired++;
    this.outstanding++;
    return obj;
  }

  release(obj: T): void {
    assert(this.outstanding > 0, "ObjectPool: release without obtain");
    this.outstanding--;
    const max = this.options.maxRetained ?? 4096;
    if (this.free.length >= max) {
      this.discarded++;
      return;
    }
    (obj as unknown as Poolable).reset?.();
    this.free.push(obj);
  }

  /** Number of objects handed out and not returned (a leak if it grows without bound). */
  get leaked(): number {
    return this.outstanding;
  }

  get stats(): { created: number; retained: number; outstanding: number; acquired: number; discarded: number } {
    return {
      created: this.created,
      retained: this.free.length,
      outstanding: this.outstanding,
      acquired: this.acquired,
      discarded: this.discarded,
    };
  }

  /** Free the pool's retained objects (engine shutdown / scene teardown). */
  drain(): void {
    this.free.length = 0;
  }
}

/**
 * Generational slot allocator.
 *
 * Indices are stable while a slot is alive and are recycled after release. A monotonically
 * increasing generation per slot lets callers detect "the thing I'm holding was freed".
 * Encoded handle: `(slot << 8) | (generation & 0xff)` — 8 bits of generation catches
 * realistic reuse patterns while keeping handles small integers (fast Map keys).
 */
export class FreeList {
  private nextFree: number[] = [];
  private _generations: Uint32Array;
  private _size = 0;
  private _live = 0;
  /** slot → handle, so `handleOf` is O(1) (used when destroying entities). */
  private _handles: Uint32Array;

  constructor(initialCapacity = 256) {
    this._generations = new Uint32Array(initialCapacity);
    this._handles = new Uint32Array(initialCapacity);
    this._size = initialCapacity;
    // Slots are allocated 0..capacity-1 lazily by `_grow`; the free list is seeded with none.
  }

  get size(): number {
    return this._size;
  }

  get liveCount(): number {
    return this._live;
  }

  allocate(): { slot: number; generation: number } {
    let slot: number;
    const recycled = this.nextFree.pop();
    if (recycled !== undefined) {
      slot = recycled;
    } else {
      slot = this._usedSlots++;
      if (this._usedSlots >= this._size) this.grow();
    }
    const generation = (this._generations[slot] = ((this._generations[slot] ?? 0) + 1) & 0xffffffff);
    this._live++;
    const handle = makeHandle(slot, generation);
    this._handles[slot] = handle;
    return { slot, generation };
  }

  private _usedSlots = 0;
  get usedSlots(): number {
    return this._usedSlots;
  }

  /** Highest allocated slot index + 1 — iterate `0..usedSlots` for dense scanning. */
  get highWaterMark(): number {
    return this._usedSlots;
  }

  release(slot: number): number {
    assert(slot >= 0 && slot < this._size, "FreeList: release out of range");
    const gen = (this._generations[slot]! + 1) & 0xffffffff;
    this._generations[slot] = gen;
    this._handles[slot] = 0xffffffff;
    this.nextFree.push(slot);
    this._live--;
    return gen;
  }

  isValid(handle: number): boolean {
    const slot = handle >>> 8;
    const generation = handle & 0xff;
    if (slot >= this._size) return false;
    return this._handles[slot] === handle && (this._generations[slot]! & 0xff) === generation;
  }

  handleOf(slot: number): number {
    return this._handles[slot]!;
  }

  generationOf(slot: number): number {
    return this._generations[slot]!;
  }

  private grow(): void {
    const newSize = alignUp(this._size * 2, 64);
    const gen = new Uint32Array(newSize);
    gen.set(this._generations);
    const handles = new Uint32Array(newSize);
    handles.fill(0xffffffff);
    handles.set(this._handles);
    this._generations = gen;
    this._handles = handles;
    this._size = newSize;
  }

  reset(): void {
    this.nextFree.length = 0;
    this._generations.fill(0);
    this._handles.fill(0xffffffff);
    this._usedSlots = 0;
    this._live = 0;
  }

  get stats(): { size: number; live: number; recycled: number } {
    return { size: this._size, live: this._live, recycled: this.nextFree.length };
  }
}

export function makeHandle(slot: number, generation: number): number {
  return ((slot << 8) | (generation & 0xff)) >>> 0;
}

export function handleSlot(handle: number): number {
  return handle >>> 8;
}

export function handleGeneration(handle: number): number {
  return handle & 0xff;
}

/** Growable Int32Array stack — traversal worklists without touching the JS heap. */
export class IntStack {
  private data: Int32Array;
  private top = 0;

  constructor(initialCapacity = 256) {
    this.data = new Int32Array(Math.max(8, initialCapacity));
  }

  get length(): number {
    return this.top;
  }

  get isEmpty(): boolean {
    return this.top === 0;
  }

  clear(): void {
    this.top = 0;
  }

  push(v: number): void {
    if (this.top >= this.data.length) this.data = growTyped(this.data, this.data.length * 2, Int32Array);
    this.data[this.top++] = v;
  }

  pop(): number {
    assert(this.top > 0, "IntStack: pop on empty stack");
    return this.data[--this.top]!;
  }

  peek(): number {
    return this.data[this.top - 1]!;
  }

  /** Consume everything, in LIFO order, into a plain number array (for tests / debug). */
  drain(out: number[] = []): number[] {
    while (this.top > 0) out.push(this.data[--this.top]!);
    return out;
  }

  toArray(): number[] {
    return Array.prototype.slice.call(this.data, 0, this.top) as number[];
  }
}

/** A growable float writer with a reset() that keeps capacity (the GPU-upload workhorse). */
export class FloatBuffer {
  private data: Float32Array;
  private _length = 0;

  constructor(initialCapacity = 1024) {
    this.data = new Float32Array(Math.max(16, initialCapacity));
  }

  get length(): number {
    return this._length;
  }

  get byteLength(): number {
    return this._length * 4;
  }

  /** Raw view over written data. Invalidated by the next write. */
  view(): Float32Array {
    return this.data.subarray(0, this._length);
  }

  get capacity(): number {
    return this.data.length;
  }

  ensure(floats: number): void {
    const need = this._length + floats;
    if (need > this.data.length) this.data = growTyped(this.data, Math.max(need, this.data.length * 2), Float32Array);
  }

  write(v: number): void {
    this.ensure(1);
    this.data[this._length++] = v;
  }

  write3(x: number, y: number, z: number): void {
    this.ensure(3);
    this.data[this._length] = x;
    this.data[this._length + 1] = y;
    this.data[this._length + 2] = z;
    this._length += 3;
  }

  write4(x: number, y: number, z: number, w: number): void {
    this.ensure(4);
    this.data[this._length] = x;
    this.data[this._length + 1] = y;
    this.data[this._length + 2] = z;
    this.data[this._length + 3] = w;
    this._length += 4;
  }

  /** Bulk write from any array-like (typed array or plain array); no intermediate copies. */
  writeArray(src: ArrayLike<number>, srcOffset = 0, count = src.length - srcOffset): void {
    this.ensure(count);
    if (srcOffset === 0 && count === src.length) {
      this.data.set(src as ArrayLike<number>, this._length);
    } else {
      for (let i = 0; i < count; i++) this.data[this._length + i] = src[srcOffset + i]!;
    }
    this._length += count;
  }

  padToElementAlignment(elements: number): void {
    while (this._length % elements !== 0) this.write(0);
  }

  reset(): void {
    this._length = 0;
  }

  trimTo(targetCapacity: number): void {
    if (targetCapacity < this.data.length && targetCapacity >= this._length) {
      this.data = new Float32Array(alignUp(Math.max(targetCapacity, 16), 16));
    }
  }
}

export class Uint16Buffer {
  private data: Uint16Array;
  private _length = 0;

  constructor(initialCapacity = 1024) {
    this.data = new Uint16Array(Math.max(16, initialCapacity));
  }

  get length(): number {
    return this._length;
  }

  get byteLength(): number {
    return this._length * 2;
  }

  view(): Uint16Array {
    return this.data.subarray(0, this._length);
  }

  ensure(elements: number): void {
    const need = this._length + elements;
    if (need > this.data.length) this.data = growTyped(this.data, Math.max(need, this.data.length * 2), Uint16Array);
  }

  write(v: number): void {
    this.ensure(1);
    this.data[this._length++] = v;
  }

  reset(): void {
    this._length = 0;
  }
}

export class Uint32Buffer {
  private data: Uint32Array;
  private _length = 0;

  constructor(initialCapacity = 1024) {
    this.data = new Uint32Array(Math.max(16, initialCapacity));
  }

  get length(): number {
    return this._length;
  }

  get byteLength(): number {
    return this._length * 4;
  }

  view(): Uint32Array {
    return this.data.subarray(0, this._length);
  }

  ensure(elements: number): void {
    const need = this._length + elements;
    if (need > this.data.length) this.data = growTyped(this.data, Math.max(need, this.data.length * 2), Uint32Array);
  }

  write(v: number): void {
    this.ensure(1);
    this.data[this._length++] = v;
  }

  write3(x: number, y: number, z: number): void {
    this.ensure(3);
    this.data[this._length] = x;
    this.data[this._length + 1] = y;
    this.data[this._length + 2] = z;
    this._length += 3;
  }

  reset(): void {
    this._length = 0;
  }
}

/** Grow a typed array preserving contents. `ctor` avoids a per-call lookup. */
export function growTyped<T extends ArrayBufferView & { readonly length: number }>(
  src: T,
  newLength: number,
  ctor: new (length: number) => T,
): T {
  const dst = new ctor(newLength);
  (dst as unknown as { set(a: ArrayBufferView): void }).set(src);
  return dst;
}

/**
 * Bump allocator over a Float32Array: used for scratch vertex/uniform staging where the whole
 * frame's data is discarded at once. `rewind()` is O(1).
 */
export class FloatArena {
  readonly data: Float32Array;
  private used = 0;

  constructor(capacityFloats: number) {
    this.data = new Float32Array(capacityFloats);
  }

  get usedFloats(): number {
    return this.used;
  }

  get usedBytes(): number {
    return this.used * 4;
  }

  get capacity(): number {
    return this.data.length;
  }

  allocate(floats: number): number {
    const aligned = alignUp(floats, 4);
    if (this.used + aligned > this.data.length) {
      throw new Error(`FloatArena overflow: need ${aligned} floats, have ${this.data.length - this.used}`);
    }
    const at = this.used;
    this.used += aligned;
    return at;
  }

  rewind(): void {
    this.used = 0;
  }
}
