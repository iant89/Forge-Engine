/**
 * Bounded, persistent terrain deformation state (Phase 15.5 foundation).
 *
 * The procedural generator remains authoritative. This sparse per-chunk field stores runtime deltas
 * such as wheel impressions separately so an evicted tile can be restored without changing the
 * generator's deterministic output. Rendering and collision application consume this field in later
 * 15.5 steps.
 */

export interface DeformationStamp {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly depth: number;
}

export interface SerializedDeformationChunk {
  readonly key: string;
  readonly resolution: number;
  readonly values: number[];
}

export class TerrainDeformationField {
  readonly resolution: number;
  readonly maxChunks: number;
  private readonly chunks = new Map<string, Float32Array>();
  private _revision = 0;

  constructor(options: { resolution?: number; maxChunks?: number } = {}) {
    this.resolution = Math.max(2, Math.floor(options.resolution ?? 33));
    this.maxChunks = Math.max(1, Math.floor(options.maxChunks ?? 128));
  }

  get revision(): number {
    return this._revision;
  }

  get chunkCount(): number {
    return this.chunks.size;
  }

  get sampleCount(): number {
    let count = 0;
    for (const values of this.chunks.values()) for (const value of values) if (value !== 0) count++;
    return count;
  }

  /** Add a shallow depression in chunk-local metres; positive depth means downward. */
  stamp(key: string, stamp: DeformationStamp, chunkSize: number): boolean {
    if (!key || !Number.isFinite(chunkSize) || chunkSize <= 0) return false;
    if (!Number.isFinite(stamp.x) || !Number.isFinite(stamp.z) || !Number.isFinite(stamp.radius) || !Number.isFinite(stamp.depth)) return false;
    if (stamp.radius <= 0 || stamp.depth <= 0) return false;
    let values = this.chunks.get(key);
    if (!values) {
      if (this.chunks.size >= this.maxChunks) return false;
      values = new Float32Array(this.resolution * this.resolution);
      this.chunks.set(key, values);
    }
    const cell = chunkSize / (this.resolution - 1);
    const minI = Math.max(0, Math.floor((stamp.x - stamp.radius) / cell));
    const maxI = Math.min(this.resolution - 1, Math.ceil((stamp.x + stamp.radius) / cell));
    const minJ = Math.max(0, Math.floor((stamp.z - stamp.radius) / cell));
    const maxJ = Math.min(this.resolution - 1, Math.ceil((stamp.z + stamp.radius) / cell));
    let changed = false;
    for (let j = minJ; j <= maxJ; j++) {
      for (let i = minI; i <= maxI; i++) {
        const dx = i * cell - stamp.x;
        const dz = j * cell - stamp.z;
        const distance = Math.hypot(dx, dz);
        if (distance > stamp.radius) continue;
        const falloff = 1 - distance / stamp.radius;
        const index = j * this.resolution + i;
        const next = Math.max(-10, values[index]! - stamp.depth * falloff);
        if (next !== values[index]) {
          values[index] = next;
          changed = true;
        }
      }
    }
    if (changed) this._revision++;
    return changed;
  }

  sample(key: string, x: number, z: number, chunkSize: number): number {
    const values = this.chunks.get(key);
    if (!values || chunkSize <= 0) return 0;
    const u = Math.max(0, Math.min(1, x / chunkSize)) * (this.resolution - 1);
    const v = Math.max(0, Math.min(1, z / chunkSize)) * (this.resolution - 1);
    const i = Math.min(this.resolution - 1, Math.round(u));
    const j = Math.min(this.resolution - 1, Math.round(v));
    return values[j * this.resolution + i]!;
  }

  remove(key: string): boolean {
    const removed = this.chunks.delete(key);
    if (removed) this._revision++;
    return removed;
  }

  serialize(): SerializedDeformationChunk[] {
    return [...this.chunks.entries()].map(([key, values]) => ({ key, resolution: this.resolution, values: Array.from(values) }));
  }

  restore(chunks: readonly SerializedDeformationChunk[]): void {
    this.chunks.clear();
    for (const chunk of chunks.slice(0, this.maxChunks)) {
      if (chunk.resolution !== this.resolution || chunk.values.length !== this.resolution * this.resolution) continue;
      this.chunks.set(chunk.key, Float32Array.from(chunk.values));
    }
    this._revision++;
  }
}
