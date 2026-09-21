/**
 * Structured CPU-side writers for GPU uniform/storage buffers.
 *
 * The writer never guesses offsets: it asks the `StructDef` for them, so the bytes on disk and the
 * shader's view of memory cannot drift apart. Setters are per-field and cheap (a typed-array index
 * computation); array fields support both in-place writes and bulk copies from typed arrays.
 *
 * Padding members are *not* zeroed on every write — `clear()` does that once — because a per-frame
 * full clear of a 4 MB per-frame uniform buffer measured as costly as the writes themselves.
 */

import { alignUp } from "../math/scalar.js";
import { StructDef, strideOf, type AddressSpace, type FieldLayout, type FieldType } from "./layout.js";
import { UsageError } from "../core/errors.js";

export interface WriteTarget {
  readonly buffer: ArrayBufferLike;
  readonly bytes: Uint8Array;
  readonly f32: Float32Array;
  readonly u32: Uint32Array;
  readonly i32: Int32Array;
}

/** A `Uint8Array`-backed destination that keeps matching views alive for reuse. */
export class WriteBuffer implements WriteTarget {
  readonly buffer: ArrayBuffer;
  bytes: Uint8Array;
  f32: Float32Array;
  u32: Uint32Array;
  i32: Int32Array;

  constructor(public byteLength: number) {
    if (byteLength % 4 !== 0) byteLength = alignUp(byteLength, 4);
    this.byteLength = byteLength;
    this.buffer = new ArrayBuffer(byteLength);
    this.bytes = new Uint8Array(this.buffer);
    this.f32 = new Float32Array(this.buffer);
    this.u32 = new Uint32Array(this.buffer);
    this.i32 = new Int32Array(this.buffer);
  }

  grow(newByteLength: number): void {
    if (newByteLength <= this.byteLength) return;
    const grown = alignUp(newByteLength, 256);
    const buffer = new ArrayBuffer(grown);
    new Uint8Array(buffer).set(this.bytes);
    this.byteLength = grown;
    (this as { buffer: ArrayBuffer }).buffer = buffer;
    this.bytes = new Uint8Array(buffer);
    this.f32 = new Float32Array(buffer);
    this.u32 = new Uint32Array(buffer);
    this.i32 = new Int32Array(buffer);
  }

  clear(): void {
    this.bytes.fill(0);
  }
}

/**
 * Field-addressable view onto `offsetBytes..offsetBytes+struct.size()` of a target.
 *
 * One accessor per (struct, slot). `relocate()` retargets it (used when a growable buffer changes
 * identity) so callers can keep holding the same accessor.
 */
export class StructAccessor {
  private readonly layouts: Map<string, FieldLayout>;
  offsetBytes: number;
  floatOffset: number;

  constructor(
    readonly struct: StructDef,
    readonly target: WriteTarget,
    offsetBytes = 0,
    readonly space: AddressSpace = "uniform",
  ) {
    this.layouts = new Map(struct.layouts(space).map((l) => [l.name, l]));
    this.offsetBytes = offsetBytes;
    this.floatOffset = offsetBytes >> 2;
  }

  private layout(name: string): FieldLayout {
    const l = this.layouts.get(name);
    if (!l) throw new UsageError(`${this.struct.name} has no field "${name}"`);
    return l;
  }

  /** Field offset in bytes from the start of the struct. */
  offsetOf(name: string): number {
    return this.layout(name).offset;
  }

  get byteLength(): number {
    return this.struct.size(this.space);
  }

  clear(): void {
    this.target.bytes.fill(0, this.offsetBytes, this.offsetBytes + this.byteLength);
  }

  relocate(offsetBytes: number): void {
    this.offsetBytes = offsetBytes;
    this.floatOffset = offsetBytes >> 2;
  }

  // ---- scalars ----

  setF32(name: string, value: number): void {
    const l = this.layout(name);
    this.target.f32[this.floatOffset + (l.offset >> 2)] = value;
  }

  setU32(name: string, value: number): void {
    const l = this.layout(name);
    this.target.u32[this.floatOffset + (l.offset >> 2)] = value >>> 0;
  }

  setI32(name: string, value: number): void {
    const l = this.layout(name);
    this.target.i32[this.floatOffset + (l.offset >> 2)] = value | 0;
  }

  setBool(name: string, value: boolean): void {
    this.setU32(name, value ? 1 : 0);
  }

  // ---- vectors ----

  setVec2(name: string, x: number, y: number): void {
    const l = this.layout(name);
    const f = this.target.f32;
    const o = this.floatOffset + (l.offset >> 2);
    f[o] = x;
    f[o + 1] = y;
  }

  setVec3(name: string, x: number, y: number, z: number): void {
    const l = this.layout(name);
    const f = this.target.f32;
    const o = this.floatOffset + (l.offset >> 2);
    f[o] = x;
    f[o + 1] = y;
    f[o + 2] = z;
  }

  setVec4(name: string, x: number, y: number, z: number, w: number): void {
    const l = this.layout(name);
    const f = this.target.f32;
    const o = this.floatOffset + (l.offset >> 2);
    f[o] = x;
    f[o + 1] = y;
    f[o + 2] = z;
    f[o + 3] = w;
  }

  /** Pack three floats + one float (commonly a flag/roughness slot) into vec4 storage. */
  setVec4From(src: ArrayLike<number>, name: string, srcOffset = 0): void {
    const l = this.layout(name);
    const f = this.target.f32;
    const o = this.floatOffset + (l.offset >> 2);
    for (let i = 0; i < 4; i++) f[o + i] = src[srcOffset + i] as number;
  }

  // ---- matrices ----

  setMat4(name: string, m: Float32Array, srcOffset = 0): void {
    const l = this.layout(name);
    const f = this.target.f32;
    const o = this.floatOffset + (l.offset >> 2);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) f[o + c * 4 + r] = m[srcOffset + c * 4 + r]!;
    }
  }

  setMat3x3(name: string, m: Float32Array, srcOffset = 0): void {
    // mat3x3 in uniform space is 3 columns of vec3 padded to 16 bytes.
    const l = this.layout(name);
    const f = this.target.f32;
    const o = this.floatOffset + (l.offset >> 2);
    for (let c = 0; c < 3; c++) {
      for (let r = 0; r < 3; r++) f[o + c * 4 + r] = m[srcOffset + c * 3 + r]!;
      f[o + c * 4 + 3] = 0;
    }
  }

  setMat2x2(name: string, m: Float32Array, srcOffset = 0): void {
    const l = this.layout(name);
    const f = this.target.f32;
    const o = this.floatOffset + (l.offset >> 2);
    for (let c = 0; c < 2; c++) {
      for (let r = 0; r < 2; r++) f[o + c * 2 + r] = m[srcOffset + c * 2 + r]!;
    }
  }

  // ---- arrays ----

  arrayStride(name: string): number {
    const l = this.layout(name);
    if (l.type.kind !== "array") throw new UsageError(`${this.struct.name}.${name} is not an array`);
    return l.stride ?? strideOf(l.type.element, this.space);
  }

  /** Element accessor for `name[i]` — used for per-light / per-cascade writes. */
  element(name: string, index: number): StructAccessor | FloatAccessor {
    const l = this.layout(name);
    if (l.type.kind !== "array") throw new UsageError(`${this.struct.name}.${name} is not an array`);
    if (index < 0 || index >= l.type.count) {
      throw new UsageError(`${this.struct.name}.${name}[${index}] out of range (count ${l.type.count})`);
    }
    const stride = l.stride ?? strideOf(l.type.element, this.space);
    const base = this.offsetBytes + l.offset + index * stride;
    if (l.type.element.kind === "struct") {
      return new StructAccessor(l.type.element.struct, this.target, base, this.space);
    }
    return new FloatAccessor(this.target, base, l.type.element.kind, stride, l.type.element);
  }

  setArrayF32(name: string, values: ArrayLike<number>, srcOffset = 0, count = values.length - srcOffset): void {
    const l = this.layout(name);
    if (l.type.kind !== "array" || l.type.element.kind !== "f32") {
      throw new UsageError(`${this.struct.name}.${name} is not array<f32, N>`);
    }
    const stride = l.stride ?? 16;
    if (this.space === "uniform" && stride !== 16) throw new UsageError("uniform array<f32> stride must be 16");
    const f = this.target.f32;
    const max = Math.min(count, l.count ?? count);
    for (let i = 0; i < max; i++) {
      f[(this.offsetBytes + l.offset) / 4 + (i * stride) / 4] = values[srcOffset + i] as number;
    }
  }

  /** Write a packed array of vec4 (stride 16) from a source Float32Array of 4*N floats. */
  setArrayVec4(name: string, src: Float32Array, srcOffset = 0, count = src.length / 4 - srcOffset / 4): void {
    const l = this.layout(name);
    if (l.type.kind !== "array") throw new UsageError(`${this.struct.name}.${name} is not an array`);
    const stride = l.stride ?? 16;
    const f = this.target.f32;
    const base = (this.offsetBytes + l.offset) / 4;
    const n = Math.min(count, l.count ?? count);
    if (stride === 16) {
      for (let i = 0; i < n; i++) {
        const s = srcOffset + i * 4;
        f[base + i * 4] = src[s]!;
        f[base + i * 4 + 1] = src[s + 1]!;
        f[base + i * 4 + 2] = src[s + 2]!;
        f[base + i * 4 + 3] = src[s + 3]!;
      }
    } else {
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < 4; c++) f[base + (i * stride) / 4 + c] = src[srcOffset + i * 4 + c]!;
      }
    }
  }

  setArrayU32(name: string, values: ArrayLike<number>, srcOffset = 0, count = values.length - srcOffset): void {
    const l = this.layout(name);
    if (l.type.kind !== "array") throw new UsageError(`${this.struct.name}.${name} is not an array`);
    const stride = l.stride ?? 4;
    const u = this.target.u32;
    const base = (this.offsetBytes + l.offset) / 4;
    const n = Math.min(count, l.count ?? count);
    for (let i = 0; i < n; i++) u[base + (i * stride) / 4] = values[srcOffset + i] as number;
  }

  /** Direct view over the whole struct (for `copyWithin`-style bulk updates). */
  rawFloats(): Float32Array {
    return this.target.f32.subarray(this.floatOffset, this.floatOffset + this.byteLength / 4);
  }
}

/** Non-struct array element writer (scalars, vectors, matrices). */
export class FloatAccessor {
  constructor(
    private readonly target: WriteTarget,
    private readonly offsetBytes: number,
    private readonly kind: FieldType["kind"],
    /** Byte distance between consecutive array elements. */
    private readonly stride: number,
    private readonly type: FieldType,
  ) {}

  /** Number of float32 slots the element occupies (used by `setRange`). */
  get floatSlots(): number {
    switch (this.kind) {
      case "f32":
      case "i32":
      case "u32":
      case "bool":
        return 1;
      case "vec2":
        return 2;
      case "vec3":
        return 3;
      case "vec4":
        return 4;
      case "mat2x2":
        return 8; // column-major, 2 columns of 2 + padding to the vec2 alignment
      case "mat3x3":
      case "mat4x4":
        return 16;
      default:
        return 1;
    }
  }

  /** Write `count` consecutive elements starting at this element (uses the array stride). */
  setRange(values: ArrayLike<number>, count: number): void {
    const f = this.target.f32;
    const perElement = this.floatSlots;
    const strideFloats = this.stride / 4;
    for (let i = 0; i < count; i++) {
      const base = this.offsetBytes / 4 + i * strideFloats;
      for (let k = 0; k < perElement; k++) f[base + k] = values[i * perElement + k] as number;
    }
  }

  set(...values: number[]): void {
    void this.type;
    const f = this.target.f32;
    const o = this.offsetBytes / 4;
    switch (this.kind) {
      case "f32":
        f[o] = values[0]!;
        break;
      case "u32":
      case "bool":
        this.target.u32[o] = (values[0] ?? 0) >>> 0;
        break;
      case "i32":
        this.target.i32[o] = values[0]! | 0;
        break;
      default: {
        const n = this.kind === "vec2" ? 2 : this.kind === "vec3" ? 3 : 4;
        for (let i = 0; i < n; i++) f[o + i] = values[i]!;
      }
    }
  }
}

/**
 * Sequential builder for dynamic buffers (per-frame instance/vertex/uniform streams).
 *
 * Appends fixed-size records into a growable `WriteBuffer`, tracking the write cursor. The engine
 * uploads `bytes.subarray(0, used)` — one `writeBuffer` call per buffer per frame, which is much
 * cheaper than many small uploads (see docs/PERFORMANCE.md#buffer-streaming).
 */
export class BufferBuilder {
  readonly target: WriteBuffer;
  private cursor = 0;

  constructor(initialCapacity = 16 * 1024) {
    this.target = new WriteBuffer(initialCapacity);
  }

  get usedBytes(): number {
    return this.cursor;
  }

  get usedFloats(): number {
    return this.cursor >> 2;
  }

  reset(): void {
    this.cursor = 0;
  }

  /** Reserve `bytes` and return the byte offset, growing the backing buffer when needed. */
  reserve(bytes: number, alignment = 16): number {
    const at = alignUp(this.cursor, alignment);
    const need = at + bytes;
    if (need > this.target.byteLength) this.target.grow(need * 2);
    this.cursor = need;
    return at;
  }

  writeStruct(struct: StructDef, space: AddressSpace = "uniform"): StructAccessor {
    const offset = this.reserve(struct.size(space), Math.max(16, struct.align(space)));
    return new StructAccessor(struct, this.target, offset, space);
  }

  writeFloats(values: ArrayLike<number>): number {
    const offset = this.reserve(values.length * 4, 4);
    this.target.f32.set(values as ArrayLike<number>, offset >> 2);
    return offset;
  }

  writeUint16s(values: ArrayLike<number>): number {
    const offset = this.reserve(values.length * 2, 2);
    new Uint16Array(this.target.buffer, offset, values.length).set(values as ArrayLike<number>);
    return offset;
  }

  writeBytes(values: ArrayLike<number>): number {
    const offset = this.reserve(values.length, 4);
    this.target.bytes.set(values as ArrayLike<number>, offset);
    return offset;
  }

  /** View of the written region, ready for `queue.writeBuffer`. */
  written(): Uint8Array {
    return this.target.bytes.subarray(0, alignUp(this.cursor, 4));
  }
}
