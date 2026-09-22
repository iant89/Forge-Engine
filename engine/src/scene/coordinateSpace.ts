/**
 * The scene's camera-relative origin — the one place world space and render space meet.
 *
 * Everything authored and simulated lives in double-precision *world* coordinates. Everything the
 * GPU consumes is float32 *render-local* coordinates, i.e. `world - origin`. Recentering the origin
 * is what keeps a vehicle at 500 km from the world origin from jittering, and it must be a single
 * cheap operation, so:
 *
 *  - Entities are *not* re-written on recenter except their root local positions (one write per
 *    root, O(roots), not O(entities)); children inherit through the transform graph.
 *  - A recenter is only *requested* by policy (distance threshold) and *applied* at a frame
 *    boundary, never mid-frame, so no system can observe a half-applied origin change.
 *  - Pinned entities (terrain anchors, physics bodies that must keep exact absolute positions) keep
 *    a double copy here and are re-projected from it rather than from float32, so precision is not
 *    lost across many recenters.
 */

import { Double3 } from "../math/double3.js";
import { Vec3 } from "../math/vec.js";
import { asWorldPosition, chunkLocalOffset, worldToChunk, type ChunkCoordinate, type LocalPosition, type RenderPosition, type RenderSpace, type WorldPosition } from "./spaces.js";
import type { EntityWorld } from "./world.js";
import type { EntityId } from "./entityId.js";

export interface CoordinateSpaceOptions {
  /** Recenter when the camera is farther than this from the origin (metres). 0 disables. */
  recenterDistance?: number;
  /** Hysteresis factor: recentre only when past `recenterDistance`, settle until 60% of it. */
  hysteresis?: number;
  /** Round the new origin to this grid (metres) so chunk-aligned worlds stay stable. */
  snapTo?: number;
}

export class CoordinateSpace {
  /** World-space position of render-local (0,0,0). */
  readonly origin = new Double3();
  /** Number of recenters performed (useful in tests + the debug overlay). */
  recenterCount = 0;
  /** Set by `Scene` so the space can poke the transform store. */
  private world: EntityWorld | null = null;
  private readonly recenterDistance: number;
  private readonly hysteresis: number;
  private readonly snap: number;
  /** slot → exact world position, for entities that must survive many recenters. */
  private readonly pinned = new Map<number, Double3>();
  private pending: Double3 | null = null;
  private scratchDelta = new Double3();

  constructor(options: CoordinateSpaceOptions = {}) {
    this.recenterDistance = options.recenterDistance ?? 0;
    this.hysteresis = options.hysteresis ?? 0.6;
    this.snap = options.snapTo ?? 0;
  }

  /** @internal */
  bind(world: EntityWorld): void {
    this.world = world;
  }

  get hasPendingRecenter(): boolean {
    return this.pending !== null;
  }

  /**
   * The formal coordinate-space view of this object: the origin as a `WorldPosition`, for the
   * helpers in `spaces.ts`. Reading it is free (it is the live origin, not a copy).
   */
  get renderSpace(): RenderSpace {
    return { origin: this.origin as WorldPosition };
  }

  /** The world origin as a `WorldPosition` (the authoritative large-world value). */
  get worldOrigin(): WorldPosition {
    return asWorldPosition(this.origin);
  }

  /** Which chunk a world position falls in, at the given chunk size (Phase 9.4). */
  chunkOf(worldPosition: WorldPosition | Double3, chunkSize: number): ChunkCoordinate {
    return worldToChunk(asWorldPosition(worldPosition as Double3), chunkSize);
  }

  /** Position inside its chunk, in metres (Phase 9.4). */
  chunkOffsetOf(worldPosition: WorldPosition | Double3, chunkSize: number, out: Vec3): LocalPosition {
    return chunkLocalOffset(asWorldPosition(worldPosition as Double3), chunkSize, out);
  }

  /** World → render-local (float32), typed as a `RenderPosition`. */
  renderPositionOf(worldPosition: WorldPosition | Double3, out: Vec3): RenderPosition {
    return this.toRenderLocal(worldPosition as Double3, out) as RenderPosition;
  }

  /** Render-local → world, typed as a `WorldPosition`. */
  worldPositionOf(renderPosition: RenderPosition | Vec3, out: Double3): WorldPosition {
    return asWorldPosition(this.toWorld(renderPosition, out));
  }

  /** World → render-local (float32). */
  toRenderLocal(worldPos: Double3, out: Vec3): Vec3 {
    out.x = worldPos.x - this.origin.x;
    out.y = worldPos.y - this.origin.y;
    out.z = worldPos.z - this.origin.z;
    return out;
  }

  toRenderLocalArray(worldPos: Double3, out: Float32Array, offset = 0): void {
    worldPos.writeRelativeFloat32(this.origin, out, offset);
  }

  /** Render-local → world. */
  toWorld(renderLocal: Vec3 | { x: number; y: number; z: number }, out: Double3): Double3 {
    return out.set(this.origin.x + renderLocal.x, this.origin.y + renderLocal.y, this.origin.z + renderLocal.z);
  }

  /**
   * Keep an entity's exact world position here (used by physics bodies + terrain anchors). After a
   * recenter, its float32 local values are re-derived from the double copy instead of accumulated
   * rounding.
   */
  pin(entity: EntityId, worldPosition: Double3): void {
    const slot = this.world?.slotOf(entity) ?? -1;
    if (slot < 0) return;
    const existing = this.pinned.get(slot);
    if (existing) existing.copyFrom(worldPosition);
    else this.pinned.set(slot, worldPosition.clone());
  }

  unpin(entity: EntityId): void {
    const slot = this.world?.slotOf(entity) ?? -1;
    if (slot >= 0) this.pinned.delete(slot);
  }

  pinnedPosition(entity: EntityId): Double3 | undefined {
    const slot = this.world?.slotOf(entity) ?? -1;
    return slot < 0 ? undefined : this.pinned.get(slot);
  }

  /** Write an entity's world position (double) into the float32 transform storage. */
  setEntityWorldPosition(entity: EntityId, worldPosition: Double3): void {
    const world = this.world;
    if (!world) return;
    this.pin(entity, worldPosition);
    const slot = world.slotOf(entity);
    if (slot < 0) return;
    const transformSlot = world.transformSlot(entity, true);
    const v = SCRATCH_V;
    this.toRenderLocal(worldPosition, v);
    world.transforms.setPosition(transformSlot, v.x, v.y, v.z);
  }

  getEntityWorldPosition(entity: EntityId, out: Double3): Double3 {
    const world = this.world;
    const slot = world ? world.slotOf(entity) : -1;
    const pinned = slot !== undefined && slot >= 0 ? this.pinned.get(slot) : undefined;
    if (pinned) return out.copyFrom(pinned);
    const v = world ? world.worldPosition(entity, SCRATCH_V) : SCRATCH_V;
    return out.set(this.origin.x + v.x, this.origin.y + v.y, this.origin.z + v.z);
  }

  /** Ask for a recenter; applied at the next `applyPending()` (frame boundary). */
  requestRecenterTo(target: Double3): void {
    this.pending ??= new Double3();
    this.pending.copyFrom(target);
  }

  /** Recenter toward a render-local camera position when it drifted past the threshold. */
  maybeRecenter(cameraWorld: Double3): boolean {
    if (this.recenterDistance <= 0) return false;
    const dx = cameraWorld.x - this.origin.x;
    const dy = cameraWorld.y - this.origin.y;
    const dz = cameraWorld.z - this.origin.z;
    const dist = Math.hypot(dx, dy, dz);
    // Hysteresis: the first recenter triggers at the full threshold; afterwards the camera may come
    // back inside `hysteresis * threshold` before another move is allowed. Without this, a camera
    // parked exactly at the threshold recenters every frame (the classic "origin jitter" bug).
    const limit = this.recenterDistance * (this.recenterApplied ? this.hysteresis : 1);
    if (dist < (this.recenterApplied ? limit : this.recenterDistance)) return false;
    this.requestRecenterTo(SNAP_TARGET.set(cameraWorld.x, cameraWorld.y, cameraWorld.z));
    return true;
  }

  /** True once at least one recenter happened (enables the hysteresis threshold narrowing). */
  private recenterApplied = false;

  /**
   * Apply a pending recenter. Returns the delta that was subtracted from entity positions, or null
   * when nothing was pending. Call at a frame boundary, before systems run.
   */
  applyPending(): { dx: number; dy: number; dz: number } | null {
    if (!this.pending) return null;
    const target = this.pending;
    this.pending = null;
    let tx = target.x;
    let ty = target.y;
    let tz = target.z;
    if (this.snap > 0) {
      tx = Math.round(tx / this.snap) * this.snap;
      ty = Math.round(ty / this.snap) * this.snap;
      tz = Math.round(tz / this.snap) * this.snap;
    }
    const d = this.scratchDelta.set(tx - this.origin.x, ty - this.origin.y, tz - this.origin.z);
    if (d.x === 0 && d.y === 0 && d.z === 0) return null;
    this.origin.set(tx, ty, tz);
    this.recenterCount++;
    this.recenterApplied = true;
    const world = this.world;
    if (world) {
      // Shift every root transform by -delta; children follow via the hierarchy. Pinned entities
      // are re-derived from their double copies instead, which is why they do not accumulate error.
      const store = world.transforms;
      const changed: number[] = [];
      for (let slot = 0; slot < store.count + 1; slot++) {
        if (!store.isAllocated(slot)) continue;
        if (store.parent[slot] !== 0) continue;
        const pos = SCRATCH_V;
        store.getPosition(slot, pos);
        store.setPosition(slot, pos.x - d.x, pos.y - d.y, pos.z - d.z);
        changed.push(slot);
      }
      for (const [slotIndex, pinnedPos] of this.pinned) {
        const tSlot = world.transformSlot(world.idForSlot(slotIndex), false);
        if (tSlot <= 0) continue;
        this.toRenderLocal(pinnedPos, SCRATCH_V);
        store.setPosition(tSlot, SCRATCH_V.x, SCRATCH_V.y, SCRATCH_V.z);
        changed.push(tSlot);
        void slotIndex;
      }
      if (changed.length > 0) store.updateWorld(changed, true);
    }
    return { dx: d.x, dy: d.y, dz: d.z };
  }

  /** Absolute world position of the render origin, for tests + tooling. */
  snapshot(): { origin: [number, number, number]; recenters: number; pinned: number } {
    return { origin: [this.origin.x, this.origin.y, this.origin.z], recenters: this.recenterCount, pinned: this.pinned.size };
  }

  reset(): void {
    this.origin.setZero();
    this.pending = null;
    this.pinned.clear();
    this.recenterApplied = false;
  }
}

const SCRATCH_V = new Vec3();
const SNAP_TARGET = new Double3();
