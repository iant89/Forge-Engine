/**
 * Entity identities.
 *
 * An `EntityId` is a packed 32-bit generational index: `slot` in the low `SLOT_BITS` (20) bits,
 * `generation` in the high `GEN_BITS` (12) bits. The layout is parameterized by the masks below,
 * not scattered through the code.
 *
 * `EntityWorld.exists` compares all 12 generation bits. A slot's generation advances twice per
 * create/destroy cycle (once on allocate, once on release), so a stale id can resolve again only
 * after its slot has been reused 2 048 times. The `FreeList` handle form (`makeHandle`) keeps just
 * 8 generation bits; it must never be the test for whether an `EntityId` is live.
 */

import { makeHandle } from "../core/pool.js";

export const SLOT_BITS = 20;
export const SLOT_MASK = (1 << SLOT_BITS) - 1;
export const MAX_SLOTS = SLOT_MASK;
export const GEN_BITS = 32 - SLOT_BITS;
export const GEN_MASK = (1 << GEN_BITS) - 1;
export const MAX_COMPONENT_TYPES = 64;

export type EntityId = number;

export const NULL_ENTITY: EntityId = 0;

export function makeEntityId(slot: number, generation: number): EntityId {
  return (((slot & SLOT_MASK) | ((generation & GEN_MASK) << SLOT_BITS)) >>> 0) as EntityId;
}

export function entitySlot(id: EntityId): number {
  return id & SLOT_MASK;
}

export function entityGeneration(id: EntityId): number {
  return (id >>> SLOT_BITS) & GEN_MASK;
}

/**
 * Packs (slot, generation) into the 32-bit handle form used by the resource layer. Lossy: the handle
 * keeps only the low 8 generation bits, so do not use it to validate an `EntityId`.
 */
export function entityIdToHandle(id: EntityId): number {
  return makeHandle(entitySlot(id), entityGeneration(id));
}

export function describeEntity(id: EntityId): string {
  if (id === NULL_ENTITY) return "entity(null)";
  return `entity(${entitySlot(id)}:g${entityGeneration(id)})`;
}

/** A component reference: entity + component type, used by the debug inspector. */
export interface ComponentRef {
  entity: EntityId;
  componentType: number;
}
