/**
 * `SlotAllocator` — power-of-two byte slots inside one contiguous region.
 *
 * A GPU buffer that holds both per-frame staging and long-lived blocks needs two different
 * disciplines in one address space: the staging half is a bump cursor that resets every frame, and
 * the long-lived half must hand back the *same* offset for the same block until that block dies —
 * a draw binds it by offset, so moving it means re-uploading it and re-recording every batch that
 * points at it. This is the long-lived half (Phase 14.3's device-resident population instances:
 * one slot per (chunk, type), uploaded once, freed when the chunk streams out).
 *
 * The rules, and why:
 *
 *  - **Every offset is a multiple of {@link SlotAllocator.ALIGNMENT} (256).** That is WebGPU's
 *    `minStorageBufferOffsetAlignment`, so a slot can be bound directly as a dynamic offset without
 *    the caller rounding anything. It is also a multiple of 4, which `queue.writeBuffer` requires.
 *  - **Slots are bucketed by size, and a freed slot is reused by the next request of its own bucket
 *    before the region grows.** Population blocks come in a handful of distinct capacities (one per
 *    type's `maxPerChunk`), so a streaming world reuses the same few buckets indefinitely: the
 *    region reaches its high-water mark in the first seconds and then stops growing.
 *  - **A bucket's slot is at most twice the request**, so internal fragmentation is bounded by 2×
 *    and never by the region's size.
 *  - **Offsets are region-relative.** The caller adds the region's base in the buffer; when that
 *    base moves (the staging half grew), every offset stays valid and only the uploads move.
 *
 * Allocation is O(1) and free is O(1); nothing here allocates after warm-up except the free-list
 * arrays themselves, which are reused.
 */

import { alignUp } from "../math/scalar.js";
import { UsageError } from "../core/errors.js";

/** Largest slot: 4 MiB. A population block that big would be ~52 000 instances of one chunk. */
const MAX_SLOT_BYTES = 4 * 1024 * 1024;

export class SlotAllocator {
  /** Every offset and every slot size is a multiple of this (WebGPU's storage-offset alignment). */
  static readonly ALIGNMENT = 256;

  private readonly freeLists: number[][] = [];
  /** Allocated offset → the slot bytes it holds, so {@link free} needs no size argument. */
  private readonly live = new Map<number, number>();
  /** Next never-used offset (region-relative). */
  private cursor = 0;
  private highWater = 0;

  /**
   * Reserve `bytes` and return the region-relative offset, or -1 when the request is not a finite
   * positive number. The slot is at least `bytes` and at most twice it, rounded to
   * {@link ALIGNMENT}.
   */
  allocate(bytes: number): number {
    if (!Number.isFinite(bytes) || bytes <= 0) return -1;
    const slot = SlotAllocator.slotBytesFor(bytes);
    if (slot > MAX_SLOT_BYTES) throw new UsageError(`SlotAllocator: ${bytes} bytes exceeds the ${MAX_SLOT_BYTES}-byte slot cap`);
    const bucket = SlotAllocator.bucketOf(slot);
    const list = (this.freeLists[bucket] ??= []);
    let offset = list.pop();
    if (offset === undefined) {
      offset = this.cursor;
      this.cursor += slot;
      if (this.cursor > this.highWater) this.highWater = this.cursor;
    }
    this.live.set(offset, slot);
    return offset;
  }

  /** Release a slot. Freeing an offset that is not live is a no-op (a double free cannot corrupt). */
  free(offset: number): void {
    const slot = this.live.get(offset);
    if (slot === undefined) return;
    this.live.delete(offset);
    (this.freeLists[SlotAllocator.bucketOf(slot)] ??= []).push(offset);
  }

  /** Bytes the region must hold for every live slot to fit: the high-water mark, never shrinking. */
  get capacity(): number {
    return this.highWater;
  }

  /** Bytes currently held by live slots (bucket-rounded, so ≥ the sum of the requests). */
  get usedBytes(): number {
    let total = 0;
    for (const slot of this.live.values()) total += slot;
    return total;
  }

  get allocationCount(): number {
    return this.live.size;
  }

  /** Bytes sitting in free lists — reusable without growing the region. */
  get freeBytes(): number {
    let total = 0;
    for (let bucket = 0; bucket < this.freeLists.length; bucket++) {
      const list = this.freeLists[bucket];
      if (list) total += list.length * (SlotAllocator.ALIGNMENT << bucket);
    }
    return total;
  }

  /** Drop every slot (the region's owner is going away). */
  clear(): void {
    for (const list of this.freeLists) if (list) list.length = 0;
    this.live.clear();
    this.cursor = 0;
    this.highWater = 0;
  }

  /** The bucket size for a request: {@link ALIGNMENT} shifted up to the next power of two. */
  static slotBytesFor(bytes: number): number {
    const aligned = alignUp(Math.ceil(bytes), SlotAllocator.ALIGNMENT);
    let slot = SlotAllocator.ALIGNMENT;
    while (slot < aligned) slot <<= 1;
    return slot;
  }

  private static bucketOf(slot: number): number {
    let bucket = 0;
    let size = SlotAllocator.ALIGNMENT;
    while (size < slot) {
      size <<= 1;
      bucket++;
    }
    return bucket;
  }
}
