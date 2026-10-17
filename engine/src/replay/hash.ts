/**
 * State hashing (Phase 19.4): a fingerprint of the simulation that two runs can compare.
 *
 * `StateHasher` folds exact IEEE-754 bits into two independent 32-bit lanes (an FNV-1a style lane
 * and a multiply-rotate lane, each finished with the murmur3 avalanche) and prints 64 bits as hex.
 * Exact bits, not rounded values: replays are meant to be bit-identical, and a rounding tolerance
 * would hide the first divergence until it had grown. All NaNs hash alike (payloads are not
 * simulation state). It is a fingerprint, not a cryptographic hash.
 *
 * `hashSceneState(scene)` hashes the scene part by part — each part is a named contributor — so a
 * mismatch says *what* diverged (`vehicles` before `transforms` points at the vehicle step). Built-in
 * parts:
 *
 *  - `transforms`: every live entity with a transform, in id order: id and local TRS from the store
 *  - `physics`: every body of every physics world the scene's systems or vehicles use, in world order
 *  - `vehicles`: every `VehicleComponent`'s vehicle — pose, velocities, attitude, drivetrain, the
 *    input it last saw, and each wheel's spin, steering, suspension, forces, slip and contact
 *  - `objects`: each scene object's `saveState()` (weather, day/night, terrain settings), as
 *    canonical JSON
 *
 * Games add their own state with `registerStateHashContributor(name, fn)`. A contributor must read
 * state only and visit it in a deterministic order (ids, insertion order — never `Map` iteration over
 * object keys that depend on timing, never wall time).
 *
 * The algorithm is part of the replay format (`STATE_HASH_ALGORITHM` is stored in every recording);
 * `tests/replay/replay.test.ts` pins its output so an accidental change cannot silently invalidate
 * saved recordings.
 */

import { UsageError } from "../core/errors.js";
import { TRS } from "../math/transform.js";
import { PhysicsSystem } from "../physics/system.js";
import type { PhysicsWorld } from "../physics/world.js";
import type { Scene } from "../scene/scene.js";
import { VehicleComponent } from "../vehicles/components.js";

/** Identifies the hash function inside recordings; bump it if the folding ever changes. */
export const STATE_HASH_ALGORITHM = "forge-sh1";

const F64 = new Float64Array(1);
const U32 = new Uint32Array(F64.buffer);

function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export class StateHasher {
  private a = 0x811c9dc5;
  private b = 0x9e3779b9;
  private words = 0;

  /** Fold one unsigned 32-bit word. */
  u32(w: number): this {
    w >>>= 0;
    this.a = Math.imul(this.a ^ w, 0x01000193);
    let b = (this.b ^ Math.imul(w, 0xcc9e2d51)) >>> 0;
    b = ((b << 13) | (b >>> 19)) >>> 0;
    this.b = (Math.imul(b, 5) + 0xe6546b64) >>> 0;
    this.words++;
    return this;
  }

  /** Exact bits of a double (all NaNs alike; +0 and −0 differ, as they do in the simulation). */
  f64(v: number): this {
    if (Number.isNaN(v)) return this.u32(0x7ff80000).u32(0);
    F64[0] = v;
    return this.u32(U32[0]!).u32(U32[1]!);
  }

  bool(v: boolean): this {
    return this.u32(v ? 1 : 0);
  }

  /** Length-prefixed UTF-16 code units, so "ab"+"c" and "a"+"bc" differ. */
  str(s: string): this {
    this.u32(s.length);
    for (let i = 0; i < s.length; i++) this.u32(s.charCodeAt(i));
    return this;
  }

  vec3(v: { readonly x: number; readonly y: number; readonly z: number }): this {
    return this.f64(v.x).f64(v.y).f64(v.z);
  }

  quat(q: { readonly x: number; readonly y: number; readonly z: number; readonly w: number }): this {
    return this.f64(q.x).f64(q.y).f64(q.z).f64(q.w);
  }

  /** Canonical JSON-like walk: object keys sorted, numbers by exact bits. */
  value(v: unknown, depth = 0): this {
    if (depth > 32) throw new UsageError("state hash: value nested deeper than 32 levels (a cycle?)");
    if (v === null || v === undefined) return this.u32(0);
    if (typeof v === "number") return this.u32(1).f64(v);
    if (typeof v === "boolean") return this.u32(2).bool(v);
    if (typeof v === "string") return this.u32(3).str(v);
    if (Array.isArray(v) || ArrayBuffer.isView(v)) {
      const arr = v as ArrayLike<unknown>;
      this.u32(4).u32(arr.length);
      for (let i = 0; i < arr.length; i++) this.value(arr[i], depth + 1);
      return this;
    }
    if (typeof v === "object") {
      const keys = Object.keys(v as object).sort();
      this.u32(5).u32(keys.length);
      for (const k of keys) this.str(k).value((v as Record<string, unknown>)[k], depth + 1);
      return this;
    }
    return this.u32(6);
  }

  /** 64-bit digest as 16 hex digits. Does not reset the hasher. */
  digest(): string {
    const a = fmix32((this.a ^ this.words) >>> 0);
    const b = fmix32((this.b ^ Math.imul(this.words, 0x27d4eb2f)) >>> 0);
    return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
  }
}

/** Hashes one part of the scene's state into `h`. Read only; visit in a deterministic order. */
export type StateHashContributor = (scene: Scene, h: StateHasher) => void;

export interface StateHash {
  /** Combined hash over every part, in part-name order. */
  hash: string;
  /** Per-part hashes, for locating a divergence. */
  parts: Record<string, string>;
}

const contributors = new Map<string, StateHashContributor>();

/** Add (or with `replace`, swap) a named part of `hashSceneState`. */
export function registerStateHashContributor(name: string, fn: StateHashContributor, options: { replace?: boolean } = {}): void {
  if (!/^[\w.-]+$/.test(name)) throw new UsageError(`state hash: "${name}" is not a valid part name`);
  if (contributors.has(name) && !options.replace) throw new UsageError(`state hash: part "${name}" is already registered; pass { replace: true } to swap it`);
  contributors.set(name, fn);
}

export function unregisterStateHashContributor(name: string): boolean {
  return contributors.delete(name);
}

/** Registered part names, sorted. */
export function stateHashParts(): string[] {
  return [...contributors.keys()].sort();
}

export interface HashSceneStateOptions {
  /** Only these parts (default: every registered part). Unknown names throw. */
  parts?: readonly string[];
}

export function hashSceneState(scene: Scene, options: HashSceneStateOptions = {}): StateHash {
  const names = options.parts ? [...options.parts].sort() : stateHashParts();
  const parts: Record<string, string> = {};
  const all = new StateHasher();
  for (const name of names) {
    const fn = contributors.get(name);
    if (!fn) throw new UsageError(`state hash: unknown part "${name}" (registered: ${stateHashParts().join(", ")})`);
    const h = new StateHasher();
    fn(scene, h);
    parts[name] = h.digest();
    all.str(name).str(parts[name]);
  }
  return { hash: all.digest(), parts };
}

// ---------------------------------------------------------------- built-in parts

const trs = new TRS();

registerStateHashContributor("transforms", (scene, h) => {
  const world = scene.world;
  for (const id of world.liveEntityIds()) {
    if (!world.hasTransform(id)) continue;
    world.getTRS(id, trs);
    h.u32(id as number).vec3(trs.position).quat(trs.rotation).vec3(trs.scale);
  }
});

/** Physics worlds the scene simulates: physics systems' worlds, then vehicle chassis worlds. */
function physicsWorlds(scene: Scene): PhysicsWorld[] {
  const out: PhysicsWorld[] = [];
  for (const s of scene.world.systems) if (s instanceof PhysicsSystem && !out.includes(s.world)) out.push(s.world);
  for (const id of scene.world.liveEntityIds()) {
    const v = scene.world.getComponent(id, VehicleComponent);
    if (v?.chassisWorld && !out.includes(v.chassisWorld)) out.push(v.chassisWorld);
  }
  return out;
}

registerStateHashContributor("physics", (scene, h) => {
  for (const world of physicsWorlds(scene)) {
    h.u32(world.bodies.length);
    for (const b of world.bodies) {
      h.str(b.type).vec3(b.position).quat(b.rotation).vec3(b.linearVelocity).vec3(b.angularVelocity).bool(b.isSleeping).f64(b.sleepTime);
    }
  }
});

registerStateHashContributor("vehicles", (scene, h) => {
  const world = scene.world;
  for (const id of world.liveEntityIds()) {
    const c = world.getComponent(id, VehicleComponent);
    if (!c) continue;
    const v = c.vehicle;
    const t = v.config.transmission;
    h.u32(id as number).vec3(v.position).vec3(v.velocity);
    h.f64(v.yaw).f64(v.yawRate).f64(v.pitch).f64(v.roll).f64(v.pitchRate).f64(v.rollRate);
    h.f64(v.ax).f64(v.ay).f64(v.rpm).f64(v.distance).u32(v.stepCount).bool(v.airborne);
    h.f64(t.gear).f64(t.shiftTimer).u32(t.shiftCount);
    const i = v.input;
    h.f64(i.throttle).f64(i.brake).f64(i.steer).f64(i.handbrake).f64(i.parkingBrake);
    for (const w of v.wheels) {
      h.f64(w.omega).f64(w.spin).f64(w.steerAngle).f64(w.compression).f64(w.compressionRate);
      h.f64(w.normalLoad).f64(w.longForce).f64(w.latForce).f64(w.kappa).f64(w.alpha);
      h.bool(w.inContact).f64(w.contactX).f64(w.contactY).f64(w.contactZ).bool(w.disabled);
    }
  }
});

registerStateHashContributor("objects", (scene, h) => {
  for (const o of scene.objects) {
    const state = o.saveState?.();
    if (state === undefined) continue;
    h.str(o.name).value(state);
  }
});
