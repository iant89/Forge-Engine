/**
 * Physics backend interface (Phase 11.1).
 *
 * Gameplay talks to {@link PhysicsBackend}. {@link ForgeJSPhysics} wraps a
 * {@link PhysicsWorld} (creates one by default, or adopts via `{ world }` / {@link ForgeJSPhysics.wrap}).
 * {@link ForgeWasmPhysics} is a future stub (Phase 25) so callers can select a backend without
 * rewriting vehicle or prop code.
 */

import { Vec3 } from "../math/vec.js";
import { Ray, RayHit } from "../math/geometry.js";
import type { GroundSample } from "../vehicles/ground.js";
import { RigidBody } from "./body.js";
import { HeightfieldShape } from "./shapes.js";
import { PhysicsWorld, type PhysicsWorldOptions, type RaycastFilter } from "./world.js";

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
    } else {
      this.world = new PhysicsWorld(options);
      this.ownsWorld = true;
    }
  }

  /** Adopt an existing world without copying PhysicsWorldOptions (shared-world helper). */
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

/**
 * Future WASM physics backend (Phase 25). Constructing or stepping throws until the WASM module lands.
 */
export class ForgeWasmPhysics implements PhysicsBackend {
  readonly kind = "wasm" as const;
  readonly world: PhysicsWorld | null = null;

  constructor(_options?: PhysicsWorldOptions) {
    // Intentionally empty — Phase 25 fills this in.
  }

  private fail(): never {
    throw new Error("ForgeWasmPhysics is not implemented yet (roadmap Phase 25)");
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

export function createPhysicsBackend(
  kind: PhysicsBackendKind = "js",
  options?: ForgeJSPhysicsOptions,
): PhysicsBackend {
  if (kind === "wasm") return new ForgeWasmPhysics(options);
  return new ForgeJSPhysics(options);
}
