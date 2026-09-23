/**
 * Physics backend interface (Phase 11.1).
 *
 * Gameplay talks to {@link PhysicsBackend}. {@link ForgeJSPhysics} wraps the existing
 * {@link PhysicsWorld}. {@link ForgeWasmPhysics} is a future stub (Phase 25) so callers can
 * select a backend without rewriting vehicle or prop code.
 */

import { Vec3 } from "../math/vec.js";
import { Ray, RayHit } from "../math/geometry.js";
import type { GroundSample } from "../vehicles/ground.js";
import { RigidBody } from "./body.js";
import { HeightfieldShape } from "./shapes.js";
import { PhysicsWorld, type PhysicsWorldOptions } from "./world.js";

export type PhysicsBackendKind = "js" | "wasm";

export interface PhysicsBackend {
  readonly kind: PhysicsBackendKind;
  /** Underlying JS world when `kind === "js"`; otherwise null. */
  readonly world: PhysicsWorld | null;

  step(dt: number): number;
  addBody(body: RigidBody): RigidBody;
  removeBody(body: RigidBody): boolean;
  raycast(ray: Ray, hit: RayHit): boolean;
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
 * JavaScript rigid-body backend — thin adapter over {@link PhysicsWorld}.
 */
export class ForgeJSPhysics implements PhysicsBackend {
  readonly kind = "js" as const;
  readonly world: PhysicsWorld;
  private readonly normalScratch = new Vec3();

  constructor(options: PhysicsWorldOptions = {}) {
    this.world = new PhysicsWorld(options);
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

  raycast(ray: Ray, hit: RayHit): boolean {
    return this.world.raycast(ray, hit);
  }

  clear(): void {
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
  raycast(_ray: Ray, _hit: RayHit): boolean {
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
  options?: PhysicsWorldOptions,
): PhysicsBackend {
  if (kind === "wasm") return new ForgeWasmPhysics(options);
  return new ForgeJSPhysics(options);
}
