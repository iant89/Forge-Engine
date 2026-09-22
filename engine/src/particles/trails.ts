/**
 * Ring-buffer trails. One trail per particle slot, `length` samples deep. Recording is a copy of
 * the position after integration — no entities, no per-sample objects.
 */

import { P_X, P_Y, P_Z, PARTICLE_FLOATS, isAlive } from "./layout.js";

export class ParticleTrails {
  readonly length: number;
  readonly capacity: number;
  /** xyzxyz… indexed by `slot * length + ring`. */
  readonly positions: Float32Array;
  private readonly head: Int32Array;
  private readonly filled: Int32Array;

  constructor(capacity: number, length = 8) {
    this.capacity = capacity;
    this.length = Math.max(1, length);
    this.positions = new Float32Array(capacity * this.length * 3);
    this.head = new Int32Array(capacity);
    this.filled = new Int32Array(capacity);
  }

  reset(): void {
    this.positions.fill(0);
    this.head.fill(0);
    this.filled.fill(0);
  }

  /** Snapshot every alive particle. Dead slots keep their last ribbon but stop growing. */
  record(state: Float32Array): void {
    const n = Math.min(this.capacity, state.length / PARTICLE_FLOATS);
    for (let i = 0; i < n; i++) {
      if (!isAlive(state, i)) continue;
      const o = i * PARTICLE_FLOATS;
      const slot = this.head[i]!;
      const base = (i * this.length + slot) * 3;
      this.positions[base] = state[o + P_X]!;
      this.positions[base + 1] = state[o + P_Y]!;
      this.positions[base + 2] = state[o + P_Z]!;
      this.head[i] = (slot + 1) % this.length;
      this.filled[i] = Math.min(this.length, this.filled[i]! + 1);
    }
  }

  /** How many samples this slot has stored (≤ length). */
  count(index: number): number {
    return this.filled[index] ?? 0;
  }

  /**
   * Sample `age` steps back from the newest (0 = latest). Writes into `out`.
   * Returns false if that sample does not exist yet.
   */
  sample(index: number, age: number, out: { x: number; y: number; z: number }): boolean {
    const n = this.filled[index] ?? 0;
    if (age < 0 || age >= n) return false;
    const head = this.head[index]!;
    const slot = (head - 1 - age + this.length * 2) % this.length;
    const base = (index * this.length + slot) * 3;
    out.x = this.positions[base]!;
    out.y = this.positions[base + 1]!;
    out.z = this.positions[base + 2]!;
    return true;
  }
}
