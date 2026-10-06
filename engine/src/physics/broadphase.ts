/**
 * Deterministic sweep-and-prune broadphase for rigid-body AABBs.
 *
 * Bodies are sorted on their minimum X bound, then a short active set checks Y/Z overlap. Returned
 * pairs are re-sorted into the PhysicsWorld's stable insertion order so changing the broadphase does
 * not change solver/contact ordering. The result buffer is reused and remains valid until `query`
 * is called again.
 */

import type { RigidBody } from "./body.js";

export interface BroadphasePair {
  /** Index into the body list supplied to `query`; always less than `b`. */
  a: number;
  b: number;
}

export interface BroadphaseStats {
  bodyCount: number;
  possiblePairs: number;
  /** Pairs whose X intervals overlap and at least one body can move. */
  axisCandidates: number;
  /** Full AABB-overlap pairs passed to the narrowphase. */
  overlapPairs: number;
}

interface Proxy {
  body: RigidBody;
  index: number;
}

export class SweepAndPruneBroadphase {
  private readonly proxies: Proxy[] = [];
  private readonly active: Proxy[] = [];
  private readonly pairBuffer: BroadphasePair[] = [];
  readonly stats: BroadphaseStats = { bodyCount: 0, possiblePairs: 0, axisCandidates: 0, overlapPairs: 0 };

  /**
   * Generate overlapping body pairs. A pair of immovable bodies is omitted, matching PhysicsWorld's
   * former broadphase. The caller must refresh each body's AABB before querying after moving it.
   */
  query(bodies: readonly RigidBody[]): readonly BroadphasePair[] {
    const count = bodies.length;
    this.proxies.length = count;
    for (let i = 0; i < count; i++) {
      const proxy = this.proxies[i] ?? { body: bodies[i]!, index: i };
      proxy.body = bodies[i]!;
      proxy.index = i;
      this.proxies[i] = proxy;
    }
    this.proxies.sort((a, b) =>
      a.body.aabb.min.x - b.body.aabb.min.x || a.body.id - b.body.id || a.index - b.index,
    );

    const stats = this.stats;
    stats.bodyCount = count;
    stats.possiblePairs = count < 2 ? 0 : (count * (count - 1)) / 2;
    stats.axisCandidates = 0;
    stats.overlapPairs = 0;
    this.active.length = 0;
    this.pairBuffer.length = 0;

    for (const current of this.proxies) {
      const currentBox = current.body.aabb;
      let kept = 0;
      for (let i = 0; i < this.active.length; i++) {
        const previous = this.active[i]!;
        if (previous.body.aabb.max.x >= currentBox.min.x) this.active[kept++] = previous;
      }
      this.active.length = kept;

      for (const previous of this.active) {
        if (previous.body.invMass === 0 && current.body.invMass === 0) continue;
        stats.axisCandidates++;
        const a = previous.body.aabb;
        if (a.min.y > currentBox.max.y || a.max.y < currentBox.min.y ||
            a.min.z > currentBox.max.z || a.max.z < currentBox.min.z) continue;
        const pair = this.pairBuffer[stats.overlapPairs] ?? { a: 0, b: 0 };
        pair.a = Math.min(previous.index, current.index);
        pair.b = Math.max(previous.index, current.index);
        this.pairBuffer[stats.overlapPairs] = pair;
        stats.overlapPairs++;
      }
      this.active.push(current);
    }

    this.pairBuffer.length = stats.overlapPairs;
    this.pairBuffer.sort((a, b) => a.a - b.a || a.b - b.b);
    return this.pairBuffer;
  }
}
