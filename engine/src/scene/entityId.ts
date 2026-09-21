/**
 * Entity identities.
 *
 * An `EntityId` is a packed 32-bit generational index: `slot` in the low 16 bits, `generation`
 * in the high 16 bits. Rationale for 16+16 rather than 24+8 (see ADR-005):
 *  - 65 536 live entities is plenty for the object counts this engine targets (terrain props are
 *    chunk-scattered instanced entities, not per-instance scene entities), and the *index* space
 *    is what matters for iteration cost — a dense 16-bit index means a 64k scene fits in a few
 *    L1 caches;
 *  - 16 bits of generation makes stale-handle reuse essentially impossible in an interactive
 *    session (a slot must be freed and re-taken 65 536 times before ids collide again).
 * If a project needs more than 65k entities it can raise ENTITY_BITS in one place — the layout is
 * parameterized by the masks below, not scattered through the code.
 */

import { makeHandle } from "../core/pool.js";

export const SLOT_BITS = 16;
export const SLOT_MASK = (1 << SLOT_BITS) - 1;
export const MAX_SLOTS = SLOT_MASK;
export const MAX_COMPONENT_TYPES = 64;

export type EntityId = number;

export const NULL_ENTITY: EntityId = 0;

export function makeEntityId(slot: number, generation: number): EntityId {
  return (((slot & SLOT_MASK) | ((generation & SLOT_MASK) << SLOT_BITS)) >>> 0) as EntityId;
}

export function entitySlot(id: EntityId): number {
  return id & SLOT_MASK;
}

export function entityGeneration(id: EntityId): number {
  return (id >>> SLOT_BITS) & SLOT_MASK;
}

/** Packs (slot, generation) into the 32-bit handle form used by the resource layer. */
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
