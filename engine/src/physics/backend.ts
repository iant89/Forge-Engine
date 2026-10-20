/**
 * Physics backend interface (Phase 11.1).
 *
 * Gameplay talks to {@link PhysicsBackend}. {@link ForgeJSPhysics} wraps a
 * {@link PhysicsWorld} (creates one by default, or adopts via `{ world }` / {@link ForgeJSPhysics.wrap}).
 * Phase 25 gives {@link ForgeWasmPhysics} the versioned linear-memory ABI used by a future solver;
 * it still fails fast instead of silently running the JavaScript solver under a misleading name.
 */

import { Vec3 } from "../math/vec.js";
import { Ray, RayHit } from "../math/geometry.js";
import type { GroundSample } from "../vehicles/ground.js";
import { RigidBody } from "./body.js";
import { HeightfieldShape } from "./shapes.js";
import { PhysicsWorld, type PhysicsWorldOptions, type RaycastFilter } from "./world.js";
import { WasmPhysicsMemory } from "./wasmMemory.js";

/** @experimental The `wasm` backend has a state ABI but no executable solver yet. */
export type PhysicsBackendKind = "js" | "wasm";

export interface PhysicsBackend {
  readonly kind: PhysicsBackendKind;
  /** Underlying JS world when `kind === "js"`; otherwise null. */
  readonly world: PhysicsWorld | null;

  step(dt: number): number;
  addBody(body: RigidBody): RigidBody;
  removeBody(body: RigidBody): boolean;
  raycast(ray: Ray, hit: RayHit, filter?: RaycastFilter): boolean;
  clear(): void;

  /**
   * Register the authoritative terrain heightfield (same sampler used for visuals / vehicle contact).
   * Pass null to clear.
   */
  setHeightfield(shape: HeightfieldShape | null): RigidBody | null;

  /** Height at XZ from the registered heightfield, or null if none. */
  queryHeight(x: number, z: number): number | null;

  /**
   * Sample height + unit normal from the registered heightfield into `out`.
   * Returns false when no heightfield is registered.
   */
  sampleGround(x: number, z: number, out: GroundSample): boolean;
}

/**
 * Options for {@link ForgeJSPhysics}. Extends world construction options and optionally
 * adopts an existing {@link PhysicsWorld} (shared-world path for Vehicle + ECS).
 *
 * Default / single-owner: omit `world` and the backend creates and owns a fresh PhysicsWorld.
 * Shared: pass `world` (or use {@link ForgeJSPhysics.wrap}) so demos/`VehicleSystem` and
 * {@link PhysicsSystem} can see the same heightfield and chassis. Pairing both without sharing
 * silently creates two worlds — props and ground will not interact across them.
 * When adopting, any explicitly provided `gravity` / `fixedDt` / `solverOptions` are copied onto
 * the shared world via {@link PhysicsWorld.applyOptions} (not silently ignored).
 */
export interface ForgeJSPhysicsOptions extends PhysicsWorldOptions {
  /** Adopt this world instead of constructing a new one. Caller coordinates stepping/clearing. */
  world?: PhysicsWorld;
}

/**
 * JavaScript rigid-body backend — thin adapter over {@link PhysicsWorld}.
 *
 * By default owns a new world. Pass `{ world }` or call {@link ForgeJSPhysics.wrap} to adopt
 * an existing world (shared with {@link PhysicsSystem}).
 */
export class ForgeJSPhysics implements PhysicsBackend {
  readonly kind = "js" as const;
  readonly world: PhysicsWorld;
  /** True when this instance constructed the world; false when it adopted one. */
  readonly ownsWorld: boolean;
  private readonly normalScratch = new Vec3();

  constructor(options: ForgeJSPhysicsOptions = {}) {
    if (options.world) {
      this.world = options.world;
      this.ownsWorld = false;
      // Copy explicitly-passed mutable fields onto the shared world (do not ignore).
      this.world.applyOptions(options);
    } else {
      this.world = new PhysicsWorld(options);
      this.ownsWorld = true;
    }
  }

  /**
   * Adopt an existing world. Does not apply PhysicsWorldOptions (pass them on the constructor
   * if the shared world should be retuned).
   */
  static wrap(world: PhysicsWorld): ForgeJSPhysics {
    return new ForgeJSPhysics({ world });
  }

  step(dt: number): number {
    return this.world.step(dt);
  }

  addBody(body: RigidBody): RigidBody {
    return this.world.addBody(body);
  }

  removeBody(body: RigidBody): boolean {
    return this.world.removeBody(body);
  }

  raycast(ray: Ray, hit: RayHit, filter?: RaycastFilter): boolean {
    return this.world.raycast(ray, hit, filter);
  }

  /**
   * Clear all bodies. Throws when this backend adopted the world (`ownsWorld === false`)
   * so a shared Vehicle/ECS world cannot be silently wiped by the non-owner.
   */
  clear(): void {
    if (!this.ownsWorld) {
      throw new Error(
        "ForgeJSPhysics.clear() refused: world is adopted (ownsWorld=false); clearing would wipe a shared PhysicsWorld",
      );
    }
    this.world.clear();
  }

  setHeightfield(shape: HeightfieldShape | null): RigidBody | null {
    return this.world.setHeightfield(shape);
  }

  queryHeight(x: number, z: number): number | null {
    return this.world.queryHeight(x, z);
  }

  sampleGround(x: number, z: number, out: GroundSample): boolean {
    const hf = this.world.getHeightfield();
    if (!hf) return false;
    out.height = hf.sampleHeight(x, z);
    const n = hf.sampleNormal(x, z, this.normalScratch);
    out.nx = n.x;
    out.ny = n.y;
    out.nz = n.z;
    return true;
  }
}

/** @experimental Configuration for the non-executable Phase 25 WASM backend seam. */
export interface ForgeWasmPhysicsOptions {
  /** Fixed body-slot capacity for the Phase 25 linear-memory ABI. */
  bodyCapacity?: number;
  /** SharedArrayBuffer-backed WASM memory for a future worker-hosted solver. Off by default. */
  sharedMemory?: boolean;
}

/**
 * Phase 25 WASM backend seam.
 *
 * The first Phase 25 slice owns a real, versioned {@link WebAssembly.Memory} through
 * {@link stateMemory}; no solver module is shipped yet. Every gameplay method therefore remains
 * fail-fast. In particular, this class never disguises the JS solver as a WASM implementation.
 *
 * @experimental No executable WASM solver ships yet.
 */
export class ForgeWasmPhysics implements PhysicsBackend {
  readonly kind = "wasm" as const;
  readonly world: PhysicsWorld | null = null;
  readonly stateMemory: WasmPhysicsMemory;

  constructor(options: ForgeWasmPhysicsOptions = {}) {
    this.stateMemory = new WasmPhysicsMemory({
      capacity: options.bodyCapacity,
      shared: options.sharedMemory,
    });
  }

  private fail(): never {
    throw new Error(
      "ForgeWasmPhysics solver module is not available yet; only the Phase 25 linear-memory ABI is implemented",
    );
  }

  step(_dt: number): number {
    return this.fail();
  }
  addBody(_body: RigidBody): RigidBody {
    return this.fail();
  }
  removeBody(_body: RigidBody): boolean {
    return this.fail();
  }
  raycast(_ray: Ray, _hit: RayHit, _filter?: RaycastFilter): boolean {
    return this.fail();
  }
  clear(): void {
    this.fail();
  }
  setHeightfield(_shape: HeightfieldShape | null): RigidBody | null {
    return this.fail();
  }
  queryHeight(_x: number, _z: number): number | null {
    return this.fail();
  }
  sampleGround(_x: number, _z: number, _out: GroundSample): boolean {
    return this.fail();
  }
}

/** @experimental Backend selection includes the non-executable `wasm` option. */
export function createPhysicsBackend(kind?: "js", options?: ForgeJSPhysicsOptions): ForgeJSPhysics;
export function createPhysicsBackend(kind: "wasm", options?: ForgeWasmPhysicsOptions): ForgeWasmPhysics;
export function createPhysicsBackend(
  kind: PhysicsBackendKind,
  options?: ForgeJSPhysicsOptions | ForgeWasmPhysicsOptions,
): PhysicsBackend;
export function createPhysicsBackend(
  kind: PhysicsBackendKind = "js",
  options?: ForgeJSPhysicsOptions | ForgeWasmPhysicsOptions,
): PhysicsBackend {
  if (kind === "wasm") return new ForgeWasmPhysics(options as ForgeWasmPhysicsOptions | undefined);
  return new ForgeJSPhysics(options as ForgeJSPhysicsOptions | undefined);
}
