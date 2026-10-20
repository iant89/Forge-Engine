/**
 * Versioned linear-memory ABI for the Phase 25 WASM physics backend.
 *
 * JavaScript remains the only solver in this slice. This module does the ownership work that must
 * exist before a solver can move into WebAssembly: one fixed-capacity `WebAssembly.Memory`, a stable
 * body layout, an optional SharedArrayBuffer-backed seqlock, and transferable binary state frames.
 * Body creation, destruction, shapes and heightfield callbacks remain host-owned; applying a frame
 * therefore requires the same body ids, order, types and shape parameters in the target world.
 */

import { UsageError } from "../core/errors.js";
import type { RigidBody, BodyType } from "./body.js";
import {
  BoxShape,
  CapsuleShape,
  CylinderShape,
  HeightfieldShape,
  PlaneShape,
  SphereShape,
  type Shape,
  type ShapeType,
} from "./shapes.js";
import type { PhysicsWorld } from "./world.js";

const WASM_PAGE_BYTES = 65_536;
const HEADER_U32_WORDS = 8;
const HEADER_F64_BYTE_OFFSET = HEADER_U32_WORDS * 4;
const HEADER_F64_INDEX = HEADER_F64_BYTE_OFFSET / 8;
const BODY_META_BYTES = 16;
const BODY_F64_BYTE_OFFSET = BODY_META_BYTES;

/**
 * Transfer object schema. Bump this together with {@link WASM_PHYSICS_LAYOUT.version}.
 * @experimental The Phase 25 WASM backend does not execute a solver yet.
 */
export const WASM_PHYSICS_STATE_SCHEMA = "forge.physics-wasm-state/1" as const;

/**
 * Public ABI consumed by a future `forge-physics.wasm` module. All offsets are bytes from the start
 * of the memory (header) or body slot. As required by WebAssembly linear memory, fields are
 * little-endian: numerical body state is f64 and metadata is u32.
 *
 * @experimental The Phase 25 WASM backend does not execute a solver yet.
 */
export const WASM_PHYSICS_LAYOUT = Object.freeze({
  /** `FPW1` bytes when the u32 is stored in WebAssembly's little-endian linear memory. */
  magic: 0x31575046,
  version: 1,
  headerBytes: 192,
  bodyStride: 448,
  header: Object.freeze({
    magic: 0,
    version: 4,
    headerBytes: 8,
    bodyStride: 12,
    capacity: 16,
    count: 20,
    sequence: 24,
    flags: 28,
    accumulator: 32,
    time: 40,
    fixedDt: 48,
    gravityX: 56,
    gravityY: 64,
    gravityZ: 72,
    stepCount: 80,
    maxSubsteps: 88,
    velocityIterations: 96,
    positionIterations: 104,
    baumgarte: 112,
    penetrationSlop: 120,
    velocityRestThreshold: 128,
  }),
  body: Object.freeze({
    id: 0,
    type: 4,
    shape: 8,
    flags: 12,
    position: 16,
    rotation: 40,
    linearVelocity: 72,
    angularVelocity: 96,
    force: 120,
    torque: 144,
    previousPosition: 168,
    previousRotation: 192,
    renderPosition: 224,
    renderRotation: 248,
    mass: 280,
    inverseMass: 288,
    inertiaLocal: 296,
    inverseInertiaLocal: 320,
    restitution: 344,
    friction: 352,
    linearDamping: 360,
    angularDamping: 368,
    gravityScale: 376,
    sleepTime: 384,
    shapeParameters: 392,
  }),
  bodyTypes: Object.freeze({ dynamic: 1, static: 2, kinematic: 3 }),
  shapeTypes: Object.freeze({ sphere: 1, box: 2, capsule: 3, cylinder: 4, plane: 5, heightfield: 6 }),
  flags: Object.freeze({ sharedMemory: 1, sleeping: 1 }),
} as const);

const H_MAGIC = WASM_PHYSICS_LAYOUT.header.magic >> 2;
const H_VERSION = WASM_PHYSICS_LAYOUT.header.version >> 2;
const H_HEADER_BYTES = WASM_PHYSICS_LAYOUT.header.headerBytes >> 2;
const H_BODY_STRIDE = WASM_PHYSICS_LAYOUT.header.bodyStride >> 2;
const H_CAPACITY = WASM_PHYSICS_LAYOUT.header.capacity >> 2;
const H_COUNT = WASM_PHYSICS_LAYOUT.header.count >> 2;
const H_SEQUENCE = WASM_PHYSICS_LAYOUT.header.sequence >> 2;
const H_FLAGS = WASM_PHYSICS_LAYOUT.header.flags >> 2;

const W_ACCUMULATOR = (WASM_PHYSICS_LAYOUT.header.accumulator - HEADER_F64_BYTE_OFFSET) >> 3;
const W_TIME = (WASM_PHYSICS_LAYOUT.header.time - HEADER_F64_BYTE_OFFSET) >> 3;
const W_FIXED_DT = (WASM_PHYSICS_LAYOUT.header.fixedDt - HEADER_F64_BYTE_OFFSET) >> 3;
const W_GRAVITY_X = (WASM_PHYSICS_LAYOUT.header.gravityX - HEADER_F64_BYTE_OFFSET) >> 3;
const W_GRAVITY_Y = (WASM_PHYSICS_LAYOUT.header.gravityY - HEADER_F64_BYTE_OFFSET) >> 3;
const W_GRAVITY_Z = (WASM_PHYSICS_LAYOUT.header.gravityZ - HEADER_F64_BYTE_OFFSET) >> 3;
const W_STEP_COUNT = (WASM_PHYSICS_LAYOUT.header.stepCount - HEADER_F64_BYTE_OFFSET) >> 3;
const W_MAX_SUBSTEPS = (WASM_PHYSICS_LAYOUT.header.maxSubsteps - HEADER_F64_BYTE_OFFSET) >> 3;
const W_VELOCITY_ITERATIONS = (WASM_PHYSICS_LAYOUT.header.velocityIterations - HEADER_F64_BYTE_OFFSET) >> 3;
const W_POSITION_ITERATIONS = (WASM_PHYSICS_LAYOUT.header.positionIterations - HEADER_F64_BYTE_OFFSET) >> 3;
const W_BAUMGARTE = (WASM_PHYSICS_LAYOUT.header.baumgarte - HEADER_F64_BYTE_OFFSET) >> 3;
const W_PENETRATION_SLOP = (WASM_PHYSICS_LAYOUT.header.penetrationSlop - HEADER_F64_BYTE_OFFSET) >> 3;
const W_VELOCITY_REST_THRESHOLD = (WASM_PHYSICS_LAYOUT.header.velocityRestThreshold - HEADER_F64_BYTE_OFFSET) >> 3;

const B_POSITION = (WASM_PHYSICS_LAYOUT.body.position - BODY_F64_BYTE_OFFSET) >> 3;
const B_ROTATION = (WASM_PHYSICS_LAYOUT.body.rotation - BODY_F64_BYTE_OFFSET) >> 3;
const B_LINEAR_VELOCITY = (WASM_PHYSICS_LAYOUT.body.linearVelocity - BODY_F64_BYTE_OFFSET) >> 3;
const B_ANGULAR_VELOCITY = (WASM_PHYSICS_LAYOUT.body.angularVelocity - BODY_F64_BYTE_OFFSET) >> 3;
const B_FORCE = (WASM_PHYSICS_LAYOUT.body.force - BODY_F64_BYTE_OFFSET) >> 3;
const B_TORQUE = (WASM_PHYSICS_LAYOUT.body.torque - BODY_F64_BYTE_OFFSET) >> 3;
const B_PREVIOUS_POSITION = (WASM_PHYSICS_LAYOUT.body.previousPosition - BODY_F64_BYTE_OFFSET) >> 3;
const B_PREVIOUS_ROTATION = (WASM_PHYSICS_LAYOUT.body.previousRotation - BODY_F64_BYTE_OFFSET) >> 3;
const B_RENDER_POSITION = (WASM_PHYSICS_LAYOUT.body.renderPosition - BODY_F64_BYTE_OFFSET) >> 3;
const B_RENDER_ROTATION = (WASM_PHYSICS_LAYOUT.body.renderRotation - BODY_F64_BYTE_OFFSET) >> 3;
const B_MASS = (WASM_PHYSICS_LAYOUT.body.mass - BODY_F64_BYTE_OFFSET) >> 3;
const B_INVERSE_MASS = (WASM_PHYSICS_LAYOUT.body.inverseMass - BODY_F64_BYTE_OFFSET) >> 3;
const B_INERTIA_LOCAL = (WASM_PHYSICS_LAYOUT.body.inertiaLocal - BODY_F64_BYTE_OFFSET) >> 3;
const B_INVERSE_INERTIA_LOCAL = (WASM_PHYSICS_LAYOUT.body.inverseInertiaLocal - BODY_F64_BYTE_OFFSET) >> 3;
const B_RESTITUTION = (WASM_PHYSICS_LAYOUT.body.restitution - BODY_F64_BYTE_OFFSET) >> 3;
const B_FRICTION = (WASM_PHYSICS_LAYOUT.body.friction - BODY_F64_BYTE_OFFSET) >> 3;
const B_LINEAR_DAMPING = (WASM_PHYSICS_LAYOUT.body.linearDamping - BODY_F64_BYTE_OFFSET) >> 3;
const B_ANGULAR_DAMPING = (WASM_PHYSICS_LAYOUT.body.angularDamping - BODY_F64_BYTE_OFFSET) >> 3;
const B_GRAVITY_SCALE = (WASM_PHYSICS_LAYOUT.body.gravityScale - BODY_F64_BYTE_OFFSET) >> 3;
const B_SLEEP_TIME = (WASM_PHYSICS_LAYOUT.body.sleepTime - BODY_F64_BYTE_OFFSET) >> 3;
const B_SHAPE_PARAMETERS = (WASM_PHYSICS_LAYOUT.body.shapeParameters - BODY_F64_BYTE_OFFSET) >> 3;

const BODY_TYPE_TO_CODE: Readonly<Record<BodyType, number>> = WASM_PHYSICS_LAYOUT.bodyTypes;
const SHAPE_TYPE_TO_CODE: Readonly<Record<ShapeType, number>> = WASM_PHYSICS_LAYOUT.shapeTypes;

/** @experimental Options for the Phase 25 solver-memory seam. */
export interface WasmPhysicsMemoryOptions {
  /** Fixed number of body slots. The first ABI version never grows behind a WASM module's back. */
  capacity?: number;
  /** Use shared WebAssembly memory for a future worker-hosted solver. Requires SharedArrayBuffer. */
  shared?: boolean;
}

/**
 * A copy-safe and transferable stable frame from {@link WasmPhysicsMemory.takeSnapshot}.
 * @experimental The state format exists, but no executable WASM solver consumes it yet.
 */
export interface WasmPhysicsStateSnapshot {
  readonly schema: typeof WASM_PHYSICS_STATE_SCHEMA;
  readonly version: typeof WASM_PHYSICS_LAYOUT.version;
  readonly sequence: number;
  readonly bodyCount: number;
  readonly byteLength: number;
  readonly bytes: ArrayBuffer;
}

/**
 * Host-side owner of the future WASM solver's linear memory.
 *
 * `captureWorld` and `applyToWorld` are validation/reference seams, not a second solver. Runtime
 * topology stays in JS, while the numerical state is flat and directly importable by WebAssembly.
 *
 * @experimental No executable WASM solver ships yet.
 */
export class WasmPhysicsMemory {
  readonly memory: WebAssembly.Memory;
  readonly capacity: number;
  readonly shared: boolean;
  /** Bytes described by the ABI (the underlying memory rounds this up to whole WASM pages). */
  readonly layoutByteLength: number;

  private readonly bytes: Uint8Array;
  private readonly u32: Uint32Array;
  private readonly f64: Float64Array;
  private readonly ids = new Set<number>();

  constructor(options: WasmPhysicsMemoryOptions = {}) {
    const capacity = options.capacity ?? 1024;
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new UsageError(`WasmPhysicsMemory.capacity must be a positive safe integer, got ${capacity}`);
    }
    if (typeof WebAssembly === "undefined" || typeof WebAssembly.Memory !== "function") {
      throw new UsageError("WasmPhysicsMemory requires WebAssembly.Memory");
    }
    const shared = options.shared === true;
    if (shared && typeof SharedArrayBuffer === "undefined") {
      throw new UsageError("shared WasmPhysicsMemory requires SharedArrayBuffer (cross-origin isolation in browsers)");
    }
    const layoutByteLength = WASM_PHYSICS_LAYOUT.headerBytes + capacity * WASM_PHYSICS_LAYOUT.bodyStride;
    const pages = Math.ceil(layoutByteLength / WASM_PAGE_BYTES);
    try {
      this.memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared });
    } catch (error) {
      throw new UsageError(`could not allocate ${shared ? "shared " : ""}WASM physics memory: ${String(error)}`);
    }
    this.capacity = capacity;
    this.shared = shared;
    this.layoutByteLength = layoutByteLength;
    this.bytes = new Uint8Array(this.memory.buffer);
    this.u32 = new Uint32Array(this.memory.buffer);
    this.f64 = new Float64Array(this.memory.buffer);
    this.initializeHeader();
  }

  /** Number of body records currently published in memory. */
  get bodyCount(): number {
    return this.loadWord(H_COUNT);
  }

  /** Even when stable, odd while the single writer is publishing a frame. */
  get sequence(): number {
    return this.loadWord(H_SEQUENCE);
  }

  /** Header plus the currently published body prefix (not page-rounded allocation size). */
  get usedByteLength(): number {
    return this.usedBytes(this.validatedPublishedCount());
  }

  /**
   * Publish a JS reference world's numerical state into linear memory without reallocating views.
   * Returns the stable even sequence written by this capture.
   */
  captureWorld(world: PhysicsWorld): number {
    const bodies = world.bodies;
    this.validateWorldForCapture(world);
    const previousCount = this.validatedPublishedCount();
    const writing = this.beginWrite();

    const w = HEADER_F64_INDEX;
    this.f64[w + W_ACCUMULATOR] = world.accumulator;
    this.f64[w + W_TIME] = world.time;
    this.f64[w + W_FIXED_DT] = world.fixedDt;
    this.f64[w + W_GRAVITY_X] = world.gravity.x;
    this.f64[w + W_GRAVITY_Y] = world.gravity.y;
    this.f64[w + W_GRAVITY_Z] = world.gravity.z;
    this.f64[w + W_STEP_COUNT] = world.stepCount;
    this.f64[w + W_MAX_SUBSTEPS] = world.maxSubsteps;
    this.f64[w + W_VELOCITY_ITERATIONS] = world.solver.velocityIterations;
    this.f64[w + W_POSITION_ITERATIONS] = world.solver.positionIterations;
    this.f64[w + W_BAUMGARTE] = world.solver.baumgarte;
    this.f64[w + W_PENETRATION_SLOP] = world.solver.penetrationSlop;
    this.f64[w + W_VELOCITY_REST_THRESHOLD] = world.solver.velocityRestThreshold;

    for (let i = 0; i < bodies.length; i++) this.writeBody(i, bodies[i]!);
    for (let i = bodies.length; i < previousCount; i++) {
      this.u32[this.bodyMetaIndex(i)] = 0;
    }
    this.storeWord(H_COUNT, bodies.length);
    return this.endWrite(writing);
  }

  /**
   * Apply the published frame to an identically constructed JS world. Validation of all ids/types/
   * shapes happens before mutation, so a topology mismatch cannot half-restore the target.
   */
  applyToWorld(world: PhysicsWorld): void {
    const stable = this.shared ? this.copyStableBytes() : this.memory.buffer;
    this.applyBufferToWorld(stable, world);
  }

  /** Copy one seqlock-stable used prefix into a transferable `ArrayBuffer`. */
  takeSnapshot(): WasmPhysicsStateSnapshot {
    const bytes = this.copyStableBytes();
    const { u32 } = this.validateBuffer(bytes);
    const sequence = u32[H_SEQUENCE]!;
    const bodyCount = u32[H_COUNT]!;
    return {
      schema: WASM_PHYSICS_STATE_SCHEMA,
      version: WASM_PHYSICS_LAYOUT.version,
      sequence,
      bodyCount,
      byteLength: bytes.byteLength,
      bytes,
    };
  }

  /**
   * Load a transferred frame into this memory. Target capacity/flags stay local; source body capacity
   * may differ. Call {@link applyToWorld} separately after loading.
   */
  loadSnapshot(snapshot: WasmPhysicsStateSnapshot): number {
    if (snapshot.schema !== WASM_PHYSICS_STATE_SCHEMA || snapshot.version !== WASM_PHYSICS_LAYOUT.version) {
      throw new UsageError(`unsupported WASM physics snapshot ${String(snapshot.schema)} v${String(snapshot.version)}`);
    }
    if (!(snapshot.bytes instanceof ArrayBuffer) || snapshot.bytes.byteLength === 0) {
      throw new UsageError("WASM physics snapshot bytes are missing or detached");
    }
    const source = this.validateBuffer(snapshot.bytes);
    const count = source.u32[H_COUNT]!;
    const sequence = source.u32[H_SEQUENCE]!;
    const required = this.usedBytes(count);
    if (snapshot.bodyCount !== count || snapshot.byteLength !== snapshot.bytes.byteLength || snapshot.bytes.byteLength !== required) {
      throw new UsageError("WASM physics snapshot metadata does not match its linear-memory header");
    }
    if (snapshot.sequence !== sequence || (sequence & 1) !== 0) {
      throw new UsageError("WASM physics snapshot is not a stable even sequence");
    }
    if (count > this.capacity) {
      throw new UsageError(`WASM physics snapshot has ${count} bodies but target capacity is ${this.capacity}`);
    }

    const previousCount = this.validatedPublishedCount();
    const writing = this.beginWrite();
    const headerF64Count = (WASM_PHYSICS_LAYOUT.headerBytes - HEADER_F64_BYTE_OFFSET) >> 3;
    this.f64.set(source.f64.subarray(HEADER_F64_INDEX, HEADER_F64_INDEX + headerF64Count), HEADER_F64_INDEX);
    this.bytes.set(
      source.bytes.subarray(WASM_PHYSICS_LAYOUT.headerBytes, required),
      WASM_PHYSICS_LAYOUT.headerBytes,
    );
    for (let i = count; i < previousCount; i++) this.u32[this.bodyMetaIndex(i)] = 0;
    this.storeWord(H_COUNT, count);
    return this.endWrite(writing);
  }

  private initializeHeader(): void {
    this.bytes.fill(0, 0, this.layoutByteLength);
    this.u32[H_MAGIC] = WASM_PHYSICS_LAYOUT.magic;
    this.u32[H_VERSION] = WASM_PHYSICS_LAYOUT.version;
    this.u32[H_HEADER_BYTES] = WASM_PHYSICS_LAYOUT.headerBytes;
    this.u32[H_BODY_STRIDE] = WASM_PHYSICS_LAYOUT.bodyStride;
    this.u32[H_CAPACITY] = this.capacity;
    this.u32[H_FLAGS] = this.shared ? WASM_PHYSICS_LAYOUT.flags.sharedMemory : 0;
  }

  private beginWrite(): number {
    const sequence = this.loadWord(H_SEQUENCE);
    if ((sequence & 1) !== 0) throw new UsageError("WASM physics memory already has a writer in progress");
    const writing = (sequence + 1) >>> 0;
    this.storeWord(H_SEQUENCE, writing);
    return writing;
  }

  private endWrite(writing: number): number {
    const stable = (writing + 1) >>> 0;
    this.storeWord(H_SEQUENCE, stable);
    return stable;
  }

  private loadWord(index: number): number {
    return this.shared ? Atomics.load(this.u32, index) : this.u32[index]!;
  }

  private storeWord(index: number, value: number): void {
    if (this.shared) Atomics.store(this.u32, index, value >>> 0);
    else this.u32[index] = value >>> 0;
  }

  private validatedPublishedCount(): number {
    const count = this.bodyCount;
    if (count > this.capacity) {
      throw new UsageError(`WASM physics header count ${count} exceeds capacity ${this.capacity}`);
    }
    return count;
  }

  private usedBytes(count: number): number {
    return WASM_PHYSICS_LAYOUT.headerBytes + count * WASM_PHYSICS_LAYOUT.bodyStride;
  }

  private bodyByteOffset(index: number): number {
    return WASM_PHYSICS_LAYOUT.headerBytes + index * WASM_PHYSICS_LAYOUT.bodyStride;
  }

  private bodyMetaIndex(index: number): number {
    return this.bodyByteOffset(index) >> 2;
  }

  private bodyF64Index(index: number): number {
    return (this.bodyByteOffset(index) + BODY_F64_BYTE_OFFSET) >> 3;
  }

  private validateWorldForCapture(world: PhysicsWorld): void {
    const bodies = world.bodies;
    if (bodies.length > this.capacity) {
      throw new UsageError(`physics world has ${bodies.length} bodies but WASM capacity is ${this.capacity}`);
    }
    if (!worldNumericalStateIsFinite(world)) {
      throw new UsageError("physics world header contains non-finite numerical state");
    }

    this.ids.clear();
    for (let i = 0; i < bodies.length; i++) {
      const body = bodies[i]!;
      if (!Number.isInteger(body.id) || body.id <= 0 || body.id > 0xffff_ffff) {
        throw new UsageError(`physics body slot ${i} has invalid u32 id ${body.id}`);
      }
      if (this.ids.has(body.id)) throw new UsageError(`physics body id ${body.id} occurs more than once`);
      this.ids.add(body.id);
      if (BODY_TYPE_TO_CODE[body.type] === undefined) {
        throw new UsageError(`physics body ${body.id} has unsupported WASM body type ${String(body.type)}`);
      }
      if (SHAPE_TYPE_TO_CODE[body.shape.type] === undefined) {
        throw new UsageError(`physics body ${body.id} has unsupported WASM shape ${String(body.shape.type)}`);
      }
      if (!bodyNumericalStateIsFinite(body)) {
        throw new UsageError(`physics body ${body.id} contains non-finite numerical state`);
      }
    }
  }

  private writeBody(index: number, body: RigidBody): void {
    const meta = this.bodyMetaIndex(index);
    this.u32[meta] = body.id;
    this.u32[meta + 1] = BODY_TYPE_TO_CODE[body.type];
    this.u32[meta + 2] = SHAPE_TYPE_TO_CODE[body.shape.type];
    this.u32[meta + 3] = body.isSleeping ? WASM_PHYSICS_LAYOUT.flags.sleeping : 0;

    const o = this.bodyF64Index(index);
    writeVec3(this.f64, o + B_POSITION, body.position);
    writeQuat(this.f64, o + B_ROTATION, body.rotation);
    writeVec3(this.f64, o + B_LINEAR_VELOCITY, body.linearVelocity);
    writeVec3(this.f64, o + B_ANGULAR_VELOCITY, body.angularVelocity);
    writeVec3(this.f64, o + B_FORCE, body.force);
    writeVec3(this.f64, o + B_TORQUE, body.torque);
    writeVec3(this.f64, o + B_PREVIOUS_POSITION, body.prevPosition);
    writeQuat(this.f64, o + B_PREVIOUS_ROTATION, body.prevRotation);
    writeVec3(this.f64, o + B_RENDER_POSITION, body.renderPosition);
    writeQuat(this.f64, o + B_RENDER_ROTATION, body.renderRotation);
    this.f64[o + B_MASS] = body.mass;
    this.f64[o + B_INVERSE_MASS] = body.invMass;
    writeVec3(this.f64, o + B_INERTIA_LOCAL, body.inertiaLocal);
    writeVec3(this.f64, o + B_INVERSE_INERTIA_LOCAL, body.invInertiaLocal);
    this.f64[o + B_RESTITUTION] = body.restitution;
    this.f64[o + B_FRICTION] = body.friction;
    this.f64[o + B_LINEAR_DAMPING] = body.linearDamping;
    this.f64[o + B_ANGULAR_DAMPING] = body.angularDamping;
    this.f64[o + B_GRAVITY_SCALE] = body.gravityScale;
    this.f64[o + B_SLEEP_TIME] = body.sleepTime;
    writeShape(this.f64, o + B_SHAPE_PARAMETERS, body.shape);
  }

  private copyStableBytes(): ArrayBuffer {
    for (let attempt = 0; attempt < 8; attempt++) {
      const before = this.sequence;
      if ((before & 1) !== 0) continue;
      const count = this.bodyCount;
      if (count > this.capacity) throw new UsageError(`WASM physics header count ${count} exceeds capacity ${this.capacity}`);
      const used = this.usedBytes(count);
      const copy = new ArrayBuffer(used);
      new Uint8Array(copy).set(this.bytes.subarray(0, used));
      const after = this.sequence;
      if (before === after && (after & 1) === 0) return copy;
    }
    throw new UsageError("could not read a stable WASM physics frame after 8 seqlock attempts");
  }

  private validateBuffer(buffer: ArrayBuffer): { bytes: Uint8Array; u32: Uint32Array; f64: Float64Array } {
    if (buffer.byteLength < WASM_PHYSICS_LAYOUT.headerBytes) {
      throw new UsageError(`WASM physics buffer is ${buffer.byteLength} bytes; header needs ${WASM_PHYSICS_LAYOUT.headerBytes}`);
    }
    if ((buffer.byteLength & 7) !== 0) {
      throw new UsageError(`WASM physics buffer length ${buffer.byteLength} is not f64-aligned`);
    }
    const u32 = new Uint32Array(buffer);
    if (
      u32[H_MAGIC] !== WASM_PHYSICS_LAYOUT.magic ||
      u32[H_VERSION] !== WASM_PHYSICS_LAYOUT.version ||
      u32[H_HEADER_BYTES] !== WASM_PHYSICS_LAYOUT.headerBytes ||
      u32[H_BODY_STRIDE] !== WASM_PHYSICS_LAYOUT.bodyStride
    ) {
      throw new UsageError("WASM physics buffer layout marker/version/stride does not match this engine");
    }
    if ((u32[H_FLAGS]! & ~WASM_PHYSICS_LAYOUT.flags.sharedMemory) !== 0) {
      throw new UsageError(`WASM physics buffer has unknown header flags ${u32[H_FLAGS]}`);
    }
    const count = u32[H_COUNT]!;
    const capacity = u32[H_CAPACITY]!;
    if (capacity === 0 || count > capacity) {
      throw new UsageError(`WASM physics buffer count ${count} exceeds its declared capacity ${capacity}`);
    }
    const required = this.usedBytes(count);
    if (buffer.byteLength < required) {
      throw new UsageError(`WASM physics buffer is truncated (${buffer.byteLength} < ${required} bytes)`);
    }
    const f64 = new Float64Array(buffer);
    this.validateNumericalState(u32, f64, count);
    return { bytes: new Uint8Array(buffer), u32, f64 };
  }

  private validateNumericalState(u32: Uint32Array, f64: Float64Array, count: number): void {
    if ((u32[H_SEQUENCE]! & 1) !== 0) {
      throw new UsageError("WASM physics buffer has an unstable odd sequence");
    }
    for (let field = W_ACCUMULATOR; field <= W_VELOCITY_REST_THRESHOLD; field++) {
      if (!Number.isFinite(f64[HEADER_F64_INDEX + field])) {
        throw new UsageError(`WASM physics header f64 field ${field} is not finite`);
      }
    }

    this.ids.clear();
    for (let i = 0; i < count; i++) {
      const meta = this.bodyMetaIndex(i);
      const id = u32[meta]!;
      const type = u32[meta + 1]!;
      const shape = u32[meta + 2]!;
      const flags = u32[meta + 3]!;
      if (id === 0 || this.ids.has(id)) {
        throw new UsageError(`WASM physics slot ${i} has ${id === 0 ? "a zero" : `duplicate ${id}`} body id`);
      }
      this.ids.add(id);
      if (type < WASM_PHYSICS_LAYOUT.bodyTypes.dynamic || type > WASM_PHYSICS_LAYOUT.bodyTypes.kinematic) {
        throw new UsageError(`WASM physics body ${id} has unknown body type code ${type}`);
      }
      if (shape < WASM_PHYSICS_LAYOUT.shapeTypes.sphere || shape > WASM_PHYSICS_LAYOUT.shapeTypes.heightfield) {
        throw new UsageError(`WASM physics body ${id} has unknown shape code ${shape}`);
      }
      if ((flags & ~WASM_PHYSICS_LAYOUT.flags.sleeping) !== 0) {
        throw new UsageError(`WASM physics body ${id} has unknown flags ${flags}`);
      }
      const body = this.bodyF64Index(i);
      for (let field = B_POSITION; field < B_SHAPE_PARAMETERS + 6; field++) {
        if (!Number.isFinite(f64[body + field])) {
          throw new UsageError(`WASM physics body ${id} f64 field ${field} is not finite`);
        }
      }
    }
  }

  private applyBufferToWorld(buffer: ArrayBufferLike, world: PhysicsWorld): void {
    // Shared reads use copyStableBytes(), so this cast is always a private ArrayBuffer in that arm.
    const readable = buffer instanceof ArrayBuffer ? buffer : this.copyStableBytes();
    const source = this.validateBuffer(readable);
    const count = source.u32[H_COUNT]!;
    if (count !== world.bodies.length) {
      throw new UsageError(`WASM physics frame bodies (${count}) do not match target world (${world.bodies.length})`);
    }
    const headerBase = HEADER_F64_INDEX;
    const frameMaxSubsteps = source.f64[headerBase + W_MAX_SUBSTEPS]!;
    if (frameMaxSubsteps !== world.maxSubsteps) {
      throw new UsageError(`WASM physics frame maxSubsteps ${frameMaxSubsteps} does not match target ${world.maxSubsteps}`);
    }

    // Validate the complete host-owned topology before changing any numerical state.
    for (let i = 0; i < count; i++) {
      const body = world.bodies[i]!;
      const meta = (WASM_PHYSICS_LAYOUT.headerBytes + i * WASM_PHYSICS_LAYOUT.bodyStride) >> 2;
      const id = source.u32[meta]!;
      const type = source.u32[meta + 1]!;
      const shape = source.u32[meta + 2]!;
      if (id !== body.id) throw new UsageError(`WASM physics slot ${i} id ${id} does not match target ${body.id}`);
      if (type !== BODY_TYPE_TO_CODE[body.type]) {
        throw new UsageError(`WASM physics body ${id} type does not match target ${body.type}`);
      }
      if (shape !== SHAPE_TYPE_TO_CODE[body.shape.type]) {
        throw new UsageError(`WASM physics body ${id} shape does not match target ${body.shape.type}`);
      }
      const o = (WASM_PHYSICS_LAYOUT.headerBytes + i * WASM_PHYSICS_LAYOUT.bodyStride + BODY_F64_BYTE_OFFSET) >> 3;
      if (!shapeMatches(source.f64, o + B_SHAPE_PARAMETERS, body.shape)) {
        throw new UsageError(`WASM physics body ${id} shape parameters do not match the target topology`);
      }
    }

    world.accumulator = source.f64[headerBase + W_ACCUMULATOR]!;
    world.time = source.f64[headerBase + W_TIME]!;
    world.fixedDt = source.f64[headerBase + W_FIXED_DT]!;
    world.gravity.set(
      source.f64[headerBase + W_GRAVITY_X]!,
      source.f64[headerBase + W_GRAVITY_Y]!,
      source.f64[headerBase + W_GRAVITY_Z]!,
    );
    world.stepCount = source.f64[headerBase + W_STEP_COUNT]!;
    world.solver.velocityIterations = source.f64[headerBase + W_VELOCITY_ITERATIONS]!;
    world.solver.positionIterations = source.f64[headerBase + W_POSITION_ITERATIONS]!;
    world.solver.baumgarte = source.f64[headerBase + W_BAUMGARTE]!;
    world.solver.penetrationSlop = source.f64[headerBase + W_PENETRATION_SLOP]!;
    world.solver.velocityRestThreshold = source.f64[headerBase + W_VELOCITY_REST_THRESHOLD]!;

    for (let i = 0; i < count; i++) {
      const body = world.bodies[i]!;
      const meta = (WASM_PHYSICS_LAYOUT.headerBytes + i * WASM_PHYSICS_LAYOUT.bodyStride) >> 2;
      const o = (WASM_PHYSICS_LAYOUT.headerBytes + i * WASM_PHYSICS_LAYOUT.bodyStride + BODY_F64_BYTE_OFFSET) >> 3;
      readVec3(source.f64, o + B_POSITION, body.position);
      readQuat(source.f64, o + B_ROTATION, body.rotation);
      readVec3(source.f64, o + B_LINEAR_VELOCITY, body.linearVelocity);
      readVec3(source.f64, o + B_ANGULAR_VELOCITY, body.angularVelocity);
      readVec3(source.f64, o + B_FORCE, body.force);
      readVec3(source.f64, o + B_TORQUE, body.torque);
      readVec3(source.f64, o + B_PREVIOUS_POSITION, body.prevPosition);
      readQuat(source.f64, o + B_PREVIOUS_ROTATION, body.prevRotation);
      readVec3(source.f64, o + B_RENDER_POSITION, body.renderPosition);
      readQuat(source.f64, o + B_RENDER_ROTATION, body.renderRotation);
      body.mass = source.f64[o + B_MASS]!;
      body.invMass = source.f64[o + B_INVERSE_MASS]!;
      readVec3(source.f64, o + B_INERTIA_LOCAL, body.inertiaLocal);
      readVec3(source.f64, o + B_INVERSE_INERTIA_LOCAL, body.invInertiaLocal);
      body.restitution = source.f64[o + B_RESTITUTION]!;
      body.friction = source.f64[o + B_FRICTION]!;
      body.linearDamping = source.f64[o + B_LINEAR_DAMPING]!;
      body.angularDamping = source.f64[o + B_ANGULAR_DAMPING]!;
      body.gravityScale = source.f64[o + B_GRAVITY_SCALE]!;
      body.sleepTime = source.f64[o + B_SLEEP_TIME]!;
      body.isSleeping = (source.u32[meta + 3]! & WASM_PHYSICS_LAYOUT.flags.sleeping) !== 0;
      body.updateInertiaWorld();
      body.updateAABB();
    }
  }
}

function worldNumericalStateIsFinite(world: PhysicsWorld): boolean {
  return Number.isFinite(world.accumulator) && Number.isFinite(world.time) &&
    Number.isFinite(world.fixedDt) && finiteVec3(world.gravity) && Number.isFinite(world.stepCount) &&
    Number.isFinite(world.maxSubsteps) && Number.isFinite(world.solver.velocityIterations) &&
    Number.isFinite(world.solver.positionIterations) && Number.isFinite(world.solver.baumgarte) &&
    Number.isFinite(world.solver.penetrationSlop) && Number.isFinite(world.solver.velocityRestThreshold);
}

function bodyNumericalStateIsFinite(body: RigidBody): boolean {
  return finiteVec3(body.position) && finiteQuat(body.rotation) &&
    finiteVec3(body.linearVelocity) && finiteVec3(body.angularVelocity) &&
    finiteVec3(body.force) && finiteVec3(body.torque) &&
    finiteVec3(body.prevPosition) && finiteQuat(body.prevRotation) &&
    finiteVec3(body.renderPosition) && finiteQuat(body.renderRotation) &&
    Number.isFinite(body.mass) && Number.isFinite(body.invMass) &&
    finiteVec3(body.inertiaLocal) && finiteVec3(body.invInertiaLocal) &&
    Number.isFinite(body.restitution) && Number.isFinite(body.friction) &&
    Number.isFinite(body.linearDamping) && Number.isFinite(body.angularDamping) &&
    Number.isFinite(body.gravityScale) && Number.isFinite(body.sleepTime) &&
    shapeNumericalStateIsFinite(body.shape);
}

function finiteVec3(value: { x: number; y: number; z: number }): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function finiteQuat(value: { x: number; y: number; z: number; w: number }): boolean {
  return finiteVec3(value) && Number.isFinite(value.w);
}

function shapeNumericalStateIsFinite(shape: Shape): boolean {
  switch (shape.type) {
    case "sphere":
      return Number.isFinite((shape as SphereShape).radius);
    case "box":
      return finiteVec3((shape as BoxShape).halfExtents);
    case "capsule": {
      const capsule = shape as CapsuleShape;
      return Number.isFinite(capsule.radius) && Number.isFinite(capsule.halfHeight);
    }
    case "cylinder": {
      const cylinder = shape as CylinderShape;
      return Number.isFinite(cylinder.radius) && Number.isFinite(cylinder.halfHeight);
    }
    case "plane": {
      const plane = shape as PlaneShape;
      return finiteVec3(plane.normal) && Number.isFinite(plane.constant);
    }
    case "heightfield": {
      const bounds = (shape as HeightfieldShape).bounds;
      return finiteVec3(bounds.min) && finiteVec3(bounds.max);
    }
  }
}

function writeVec3(out: Float64Array, offset: number, value: { x: number; y: number; z: number }): void {
  out[offset] = value.x;
  out[offset + 1] = value.y;
  out[offset + 2] = value.z;
}

function writeQuat(out: Float64Array, offset: number, value: { x: number; y: number; z: number; w: number }): void {
  out[offset] = value.x;
  out[offset + 1] = value.y;
  out[offset + 2] = value.z;
  out[offset + 3] = value.w;
}

function readVec3(source: Float64Array, offset: number, out: { x: number; y: number; z: number }): void {
  out.x = source[offset]!;
  out.y = source[offset + 1]!;
  out.z = source[offset + 2]!;
}

function readQuat(source: Float64Array, offset: number, out: { x: number; y: number; z: number; w: number }): void {
  out.x = source[offset]!;
  out.y = source[offset + 1]!;
  out.z = source[offset + 2]!;
  out.w = source[offset + 3]!;
}

function writeShape(out: Float64Array, offset: number, shape: Shape): void {
  for (let i = 0; i < 6; i++) out[offset + i] = 0;
  switch (shape.type) {
    case "sphere":
      out[offset] = (shape as SphereShape).radius;
      break;
    case "box": {
      const half = (shape as BoxShape).halfExtents;
      out[offset] = half.x;
      out[offset + 1] = half.y;
      out[offset + 2] = half.z;
      break;
    }
    case "capsule":
      out[offset] = (shape as CapsuleShape).radius;
      out[offset + 1] = (shape as CapsuleShape).halfHeight;
      break;
    case "cylinder":
      out[offset] = (shape as CylinderShape).radius;
      out[offset + 1] = (shape as CylinderShape).halfHeight;
      break;
    case "plane": {
      const plane = shape as PlaneShape;
      out[offset] = plane.normal.x;
      out[offset + 1] = plane.normal.y;
      out[offset + 2] = plane.normal.z;
      out[offset + 3] = plane.constant;
      break;
    }
    case "heightfield": {
      const bounds = (shape as HeightfieldShape).bounds;
      out[offset] = bounds.min.x;
      out[offset + 1] = bounds.min.y;
      out[offset + 2] = bounds.min.z;
      out[offset + 3] = bounds.max.x;
      out[offset + 4] = bounds.max.y;
      out[offset + 5] = bounds.max.z;
      break;
    }
  }
}

function shapeMatches(source: Float64Array, offset: number, shape: Shape): boolean {
  switch (shape.type) {
    case "sphere":
      return source[offset] === (shape as SphereShape).radius;
    case "box": {
      const half = (shape as BoxShape).halfExtents;
      return source[offset] === half.x && source[offset + 1] === half.y && source[offset + 2] === half.z;
    }
    case "capsule":
      return source[offset] === (shape as CapsuleShape).radius && source[offset + 1] === (shape as CapsuleShape).halfHeight;
    case "cylinder":
      return source[offset] === (shape as CylinderShape).radius && source[offset + 1] === (shape as CylinderShape).halfHeight;
    case "plane": {
      const plane = shape as PlaneShape;
      return source[offset] === plane.normal.x && source[offset + 1] === plane.normal.y &&
        source[offset + 2] === plane.normal.z && source[offset + 3] === plane.constant;
    }
    case "heightfield": {
      const bounds = (shape as HeightfieldShape).bounds;
      return source[offset] === bounds.min.x && source[offset + 1] === bounds.min.y &&
        source[offset + 2] === bounds.min.z && source[offset + 3] === bounds.max.x &&
        source[offset + 4] === bounds.max.y && source[offset + 5] === bounds.max.z;
    }
  }
}
