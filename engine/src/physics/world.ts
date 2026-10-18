/**
 * `PhysicsWorld` — rigid body dynamics simulation world.
 *
 * Implements:
 *  - Fixed timestep simulation with substepping and interpolation
 *  - Deterministic broadphase and narrowphase contact generation
 *  - Bit-for-bit trajectory reproducibility across varying display frame rates
 */

import { Vec3, type Vec3Ops } from "../math/vec.js";
import { Ray, RayHit } from "../math/geometry.js";
import { RigidBody } from "./body.js";
import { ContactManifold, collideBodies } from "./collision.js";
import { SequentialImpulseSolver, type SolverOptions } from "./solver.js";
import { SphereShape, BoxShape, PlaneShape, HeightfieldShape } from "./shapes.js";
import { SweepAndPruneBroadphase, type BroadphaseStats } from "./broadphase.js";
import { UsageError } from "../core/errors.js";
import { captureState, restoreState, type StateRecord } from "../core/snapshot.js";

export interface RaycastFilter {
  /** Skip these rigid bodies (e.g. the casting vehicle chassis). */
  excludeBodies?: ReadonlyArray<RigidBody> | null;
  /** Skip kinematic bodies (default false on world; ground helpers may enable). */
  skipKinematic?: boolean;
  /** Skip static bodies. */
  skipStatic?: boolean;
}

export interface PhysicsWorldOptions {
  gravity?: Vec3Ops;
  fixedDt?: number;
  maxSubsteps?: number;
  solverOptions?: SolverOptions;
}

/**
 * One contact manifold after a step was solved, for listeners that react to contacts (impact
 * audio, effects, gameplay). Read-only data; the object is reused for every report, so copy what
 * you keep.
 */
export interface ContactReport {
  readonly bodyA: RigidBody;
  readonly bodyB: RigidBody;
  /** Mean contact point. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Contact normal (from A to B) of the first point. */
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  /** Largest approach speed along the normal before the solver ran (m/s, ≥ 0): the hit. */
  readonly closingSpeed: number;
  /** Tangential relative speed at the mean point after the solver ran (m/s): the slide. */
  readonly slideSpeed: number;
  /** Total normal impulse the solver applied this step (N·s). */
  readonly impulse: number;
  readonly contacts: number;
  /** Step length (s). */
  readonly dt: number;
}

export class PhysicsWorld {
  readonly bodies: RigidBody[] = [];
  private nextBodyId = 1;
  private readonly broadphase = new SweepAndPruneBroadphase();

  readonly gravity = new Vec3(0, -9.81, 0);
  /** Mutable so adopt paths ({@link applyOptions}) can retune without rebuilding the world. */
  fixedDt: number;
  readonly maxSubsteps: number;
  readonly solver: SequentialImpulseSolver;

  /** Authoritative terrain collider, when registered via setHeightfield. */
  private heightfieldBody: RigidBody | null = null;
  private heightfieldShape: HeightfieldShape | null = null;

  accumulator = 0;
  time = 0;
  stepCount = 0;
  /**
   * Called once per contact manifold after each step's solve (Phase 20.8). It only reads: the solve,
   * the integration and every snapshot are the same with or without it, and none is installed by
   * default, so a world without listeners does no extra work. Not part of a snapshot.
   */
  contactListener: ((report: ContactReport) => void) | null = null;

  constructor(options: PhysicsWorldOptions = {}) {
    if (options.gravity) this.gravity.copyFrom(options.gravity);
    this.fixedDt = options.fixedDt ?? 1 / 60;
    this.maxSubsteps = options.maxSubsteps ?? 8;
    this.solver = new SequentialImpulseSolver(options.solverOptions);
  }

  /** Snapshot counters from the most recent broadphase query. */
  get broadphaseStats(): Readonly<BroadphaseStats> {
    return this.broadphase.stats;
  }

  /**
   * Copy explicitly-provided options onto this world (adopt / share path).
   * Only defined fields are applied — `undefined` does not clobber existing values.
   * Used by {@link PhysicsSystem} and {@link ForgeJSPhysics} when constructed with `world`
   * (or `backend`) plus gravity / fixedDt / solverOptions.
   */
  applyOptions(options: PhysicsWorldOptions): void {
    if (options.gravity !== undefined) this.gravity.copyFrom(options.gravity);
    if (options.fixedDt !== undefined) this.fixedDt = options.fixedDt;
    if (options.solverOptions !== undefined) {
      const s = options.solverOptions;
      if (s.velocityIterations !== undefined) this.solver.velocityIterations = s.velocityIterations;
      if (s.positionIterations !== undefined) this.solver.positionIterations = s.positionIterations;
      if (s.baumgarte !== undefined) this.solver.baumgarte = s.baumgarte;
      if (s.penetrationSlop !== undefined) this.solver.penetrationSlop = s.penetrationSlop;
      if (s.velocityRestThreshold !== undefined) {
        this.solver.velocityRestThreshold = s.velocityRestThreshold;
      }
    }
  }

  addBody(body: RigidBody): RigidBody {
    if (body.id === 0) {
      body.id = this.nextBodyId++;
    }
    if (!this.bodies.includes(body)) {
      this.bodies.push(body);
      body.updateAABB();
    }
    return body;
  }

  removeBody(body: RigidBody): boolean {
    const idx = this.bodies.indexOf(body);
    if (idx >= 0) {
      this.bodies.splice(idx, 1);
      if (body === this.heightfieldBody) {
        this.heightfieldBody = null;
        this.heightfieldShape = null;
      }
      return true;
    }
    return false;
  }

  /**
   * Phase 19.3: the world's mid-run state — every body's pose, velocities, force accumulators,
   * interpolation poses, sleep state and material/mass parameters, plus the world's clock, step
   * count, accumulator, gravity and next body id. Shapes are construction data and are not included.
   * Restore into this world (or one built the same way): bodies are matched by id, in order.
   */
  snapshot(): PhysicsWorldSnapshot {
    return {
      world: { accumulator: this.accumulator, time: this.time, stepCount: this.stepCount, fixedDt: this.fixedDt, nextBodyId: this.nextBodyId, gravity: [this.gravity.x, this.gravity.y, this.gravity.z] },
      bodies: this.bodies.map((b) => ({ id: b.id, state: captureState(b, { skip: BODY_SNAPSHOT_SKIP }) })),
    };
  }

  /**
   * Restore a `snapshot()`. The world must hold the same bodies in the same order (body order sets
   * pair and manifold order, so anything else would not continue identically); otherwise this throws
   * before changing anything.
   */
  restoreSnapshot(snap: PhysicsWorldSnapshot): void {
    const ids = this.bodies.map((b) => b.id);
    const saved = snap.bodies.map((b) => b.id);
    if (ids.length !== saved.length || ids.some((id, i) => id !== saved[i])) {
      throw new UsageError(`PhysicsWorld.restoreSnapshot: bodies [${ids.join(",")}] do not match the snapshot's [${saved.join(",")}]`);
    }
    const w = snap.world;
    this.accumulator = w.accumulator;
    this.time = w.time;
    this.stepCount = w.stepCount;
    this.fixedDt = w.fixedDt;
    this.nextBodyId = w.nextBodyId;
    this.gravity.set(w.gravity[0], w.gravity[1], w.gravity[2]);
    snap.bodies.forEach((entry, i) => {
      const body = this.bodies[i]!;
      restoreState(body, entry.state, `body ${entry.id}`);
      body.updateInertiaWorld();
      body.updateAABB();
    });
  }

  /**
   * Register a static heightfield collider that uses the same sampleHeight/sampleNormal
   * as visual terrain and vehicle ground queries (Phase 11.2).
   */
  setHeightfield(shape: HeightfieldShape | null): RigidBody | null {
    if (this.heightfieldBody) {
      this.removeBody(this.heightfieldBody);
    }
    if (!shape) return null;
    const body = new RigidBody({
      type: "static",
      shape,
      position: { x: 0, y: 0, z: 0 },
    });
    this.addBody(body);
    this.heightfieldBody = body;
    this.heightfieldShape = shape;
    return body;
  }

  getHeightfield(): HeightfieldShape | null {
    return this.heightfieldShape;
  }

  /** Height from the registered heightfield, or null. */
  queryHeight(x: number, z: number): number | null {
    return this.heightfieldShape ? this.heightfieldShape.sampleHeight(x, z) : null;
  }

  /**
   * Advance simulation by variable frame time `dt`.
   * Executes zero or more fixed steps deterministically and computes render interpolation.
   */
  step(dt: number): number {
    const clampedDt = Math.min(0.2, Math.max(0, dt));
    this.accumulator += clampedDt;

    let substeps = 0;
    while (this.accumulator >= this.fixedDt && substeps < this.maxSubsteps) {
      this.fixedStep(this.fixedDt);
      this.accumulator -= this.fixedDt;
      substeps++;
    }

    // If accumulator exceeds maxSubsteps * fixedDt (e.g. background tab), clamp to prevent spiral of death
    if (this.accumulator > this.fixedDt * 2) {
      this.accumulator = 0;
    }

    const alpha = this.accumulator / this.fixedDt;
    for (const body of this.bodies) {
      body.interpolate(alpha);
    }

    return substeps;
  }

  /**
   * Run exact integer number of fixed steps without interpolation.
   * Guaranteed deterministic across platforms and framerates.
   */
  stepDeterministic(fixedSteps: number): void {
    for (let i = 0; i < fixedSteps; i++) {
      this.fixedStep(this.fixedDt);
    }
  }

  /**
   * Run exactly one solver step with timestep `dt` (defaults to {@link fixedDt}).
   * Does **not** use the variable-dt accumulator — callers that already own a fixed
   * clock (e.g. {@link PhysicsSystem} via `context.fixedDt`) get one step per call,
   * never 0/N from leftover accumulator state. Render poses snap to the post-step pose.
   */
  stepOnce(dt: number = this.fixedDt): void {
    this.fixedStep(dt);
    // ECS / deterministic callers have no leftover frame alpha — snap render = sim.
    for (const body of this.bodies) {
      body.interpolate(1);
    }
  }

  private fixedStep(dt: number): void {
    const n = this.bodies.length;

    // 1. Integrate external forces & gravity to velocities
    for (let i = 0; i < n; i++) {
      this.bodies[i]!.integrateVelocity(dt, this.gravity);
    }

    // 2. Broadphase & Narrowphase: generate contact manifolds
    const manifolds: ContactManifold[] = [];

    // Keep every proxy current (including externally moved kinematics) before generating candidates.
    for (const body of this.bodies) body.updateAABB();
    // The sweep-and-prune index reduces pair checks; candidate order is restored to insertion order,
    // preserving deterministic manifold/solver ordering from the original nested loop.
    const pairs = this.broadphase.query(this.bodies);
    for (const pair of pairs) {
      const bA = this.bodies[pair.a]!;
      const bB = this.bodies[pair.b]!;
      const manifold = collideBodies(bA, bB);
      if (manifold && manifold.contacts.length > 0) manifolds.push(manifold);
    }

    // 3. Solve velocity & position constraints
    const listener = this.contactListener;
    if (listener) {
      CLOSING.length = manifolds.length;
      for (let i = 0; i < manifolds.length; i++) CLOSING[i] = closingSpeed(manifolds[i]!);
    }
    this.solver.solve(manifolds, dt);
    if (listener) {
      for (let i = 0; i < manifolds.length; i++) listener(fillReport(manifolds[i]!, CLOSING[i]!, dt));
    }

    // 4. Integrate velocities to positions and update AABBs
    for (let i = 0; i < n; i++) {
      this.bodies[i]!.integratePosition(dt);
    }

    this.time += dt;
    this.stepCount++;
  }

  /**
   * Raycast against physics colliders in the world.
   *
   * **BoxShape hits are AABB-only** (axis-aligned bounds via {@link Ray.intersectsAABB}),
   * not oriented OBB. Rotated decks / ramps therefore do not produce correct wheel-ray
   * contact against non-heightfield boxes in Phase 11 — prefer {@link HeightfieldShape}
   * / `physicsGroundQuery` for vehicle ground. OBB box rays are intentionally out of scope.
   */
  raycast(ray: Ray, hit: RayHit, filter?: RaycastFilter): boolean {
    let closestDist = Infinity;
    let hitFound = false;
    const scratchHit = PhysicsWorld.rayScratch;
    const exclude = filter?.excludeBodies;

    for (const body of this.bodies) {
      // RigidBody pose fields are intentionally authorable; refresh before using the AABB as a ray
      // broadphase so direct pose edits cannot produce stale-bound false negatives.
      body.updateAABB();
      if (filter?.skipKinematic && body.type === "kinematic") continue;
      if (filter?.skipStatic && body.type === "static") continue;
      if (exclude && exclude.length > 0 && exclude.includes(body)) continue;
      const shape = body.shape;
      if (!(shape instanceof PlaneShape)) {
        const boundsHit = PhysicsWorld.rayAabbScratch;
        if (!ray.intersectsAABB(body.aabb, boundsHit) || boundsHit.distance >= closestDist) continue;
      }
      if (shape instanceof SphereShape) {
        const t = ray.intersectsSphere(body.position, shape.radius);
        if (t >= 0 && t < ray.maxDistance && t < closestDist) {
          closestDist = t;
          hit.distance = t;
          ray.at(t, hit.point);
          hit.normal.set(
            (hit.point.x - body.position.x) / shape.radius,
            (hit.point.y - body.position.y) / shape.radius,
            (hit.point.z - body.position.z) / shape.radius,
          ).normalize();
          hit.isValid = true;
          hitFound = true;
        }
      } else if (shape instanceof PlaneShape) {
        const denom = ray.direction.dot(shape.normal);
        if (Math.abs(denom) > 1e-6) {
          const t = -(ray.origin.dot(shape.normal) + shape.constant) / denom;
          if (t >= 0 && t < ray.maxDistance && t < closestDist) {
            closestDist = t;
            hit.distance = t;
            ray.at(t, hit.point);
            hit.normal.copyFrom(shape.normal);
            hit.isValid = true;
            hitFound = true;
          }
        }
      } else if (shape instanceof BoxShape) {
        if (ray.intersectsAABB(body.aabb, scratchHit) && scratchHit.distance < closestDist) {
          closestDist = scratchHit.distance;
          hit.distance = scratchHit.distance;
          hit.point.copyFrom(scratchHit.point);
          hit.normal.copyFrom(scratchHit.normal);
          hit.isValid = true;
          hitFound = true;
        }
      } else if (shape instanceof HeightfieldShape) {
        if (raycastHeightfield(ray, shape, scratchHit) && scratchHit.distance < closestDist) {
          closestDist = scratchHit.distance;
          hit.distance = scratchHit.distance;
          hit.point.copyFrom(scratchHit.point);
          hit.normal.copyFrom(scratchHit.normal);
          hit.isValid = true;
          hitFound = true;
        }
      }
    }

    return hitFound;
  }

  clear(): void {
    this.bodies.length = 0;
    this.broadphase.query(this.bodies);
    this.heightfieldBody = null;
    this.heightfieldShape = null;
    this.accumulator = 0;
    this.time = 0;
    this.stepCount = 0;
  }

  private static readonly rayScratch = new RayHit();
  private static readonly rayAabbScratch = new RayHit();
}

/** Scratch for heightfield raycast normals (avoids per-hit Vec3 alloc in default sampler). */
const heightfieldNormalScratch = new Vec3();

/**
 * March a ray against a heightfield sampler. Preferential for downward wheel rays;
 * also works for general directions via uniform steps along the ray.
 */
export function raycastHeightfield(ray: Ray, hf: HeightfieldShape, hit: RayHit, steps = 48): boolean {
  const maxT = Math.min(ray.maxDistance, 500);
  if (!(maxT > 0)) return false;
  const dt = maxT / steps;
  let prevAbove = true;
  let prevT = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i * dt;
    const x = ray.origin.x + ray.direction.x * t;
    const y = ray.origin.y + ray.direction.y * t;
    const z = ray.origin.z + ray.direction.z * t;
    const h = hf.sampleHeight(x, z);
    const above = y > h;
    if (i > 0 && prevAbove && !above) {
      // Bisect the crossing for a tighter hit.
      let lo = prevT;
      let hi = t;
      for (let k = 0; k < 8; k++) {
        const mid = (lo + hi) * 0.5;
        const mx = ray.origin.x + ray.direction.x * mid;
        const my = ray.origin.y + ray.direction.y * mid;
        const mz = ray.origin.z + ray.direction.z * mid;
        if (my > hf.sampleHeight(mx, mz)) lo = mid;
        else hi = mid;
      }
      const hitT = hi;
      if (hitT < 0 || hitT > maxT) return false;
      hit.distance = hitT;
      ray.at(hitT, hit.point);
      const n = hf.sampleNormal(hit.point.x, hit.point.z, heightfieldNormalScratch);
      hit.normal.copyFrom(n);
      hit.isValid = true;
      return true;
    }
    // Start already below surface: report t=0 contact.
    if (i === 0 && !above) {
      hit.distance = 0;
      hit.point.set(ray.origin.x, h, ray.origin.z);
      const n = hf.sampleNormal(ray.origin.x, ray.origin.z, heightfieldNormalScratch);
      hit.normal.copyFrom(n);
      hit.isValid = true;
      return true;
    }
    prevAbove = above;
    prevT = t;
  }
  return false;
}

// Contact-report scratch lives at module scope, not on the world, so snapshots and state hashes
// (which only see bodies, and would see world fields) are unaffected by listening.
const CLOSING: number[] = [];
const REL = new Vec3();
const REPORT = {
  bodyA: null as unknown as RigidBody,
  bodyB: null as unknown as RigidBody,
  x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0,
  closingSpeed: 0, slideSpeed: 0, impulse: 0, contacts: 0, dt: 0,
};

/** Velocity of B relative to A at a contact point (lever arms rA / rB). */
function relativeVelocity(a: RigidBody, b: RigidBody, rA: Vec3Ops, rB: Vec3Ops, out: Vec3): Vec3 {
  const wa = a.angularVelocity, wb = b.angularVelocity;
  return out.set(
    b.linearVelocity.x + (wb.y * rB.z - wb.z * rB.y) - (a.linearVelocity.x + (wa.y * rA.z - wa.z * rA.y)),
    b.linearVelocity.y + (wb.z * rB.x - wb.x * rB.z) - (a.linearVelocity.y + (wa.z * rA.x - wa.x * rA.z)),
    b.linearVelocity.z + (wb.x * rB.y - wb.y * rB.x) - (a.linearVelocity.z + (wa.x * rA.y - wa.y * rA.x)),
  );
}

function closingSpeed(m: ContactManifold): number {
  let best = 0;
  for (const c of m.contacts) {
    const v = relativeVelocity(m.bodyA, m.bodyB, c.rA, c.rB, REL);
    const vn = v.x * c.normal.x + v.y * c.normal.y + v.z * c.normal.z;
    if (-vn > best) best = -vn;
  }
  return best;
}

function fillReport(m: ContactManifold, closing: number, dt: number): ContactReport {
  const n = m.contacts.length;
  let x = 0, y = 0, z = 0, impulse = 0, sx = 0, sy = 0, sz = 0;
  for (const c of m.contacts) {
    x += c.point.x;
    y += c.point.y;
    z += c.point.z;
    impulse += c.normalImpulse;
    const v = relativeVelocity(m.bodyA, m.bodyB, c.rA, c.rB, REL);
    const vn = v.x * c.normal.x + v.y * c.normal.y + v.z * c.normal.z;
    sx += v.x - vn * c.normal.x;
    sy += v.y - vn * c.normal.y;
    sz += v.z - vn * c.normal.z;
  }
  const first = m.contacts[0]!;
  const r = REPORT;
  r.bodyA = m.bodyA;
  r.bodyB = m.bodyB;
  r.x = x / n;
  r.y = y / n;
  r.z = z / n;
  r.nx = first.normal.x;
  r.ny = first.normal.y;
  r.nz = first.normal.z;
  r.closingSpeed = closing;
  r.slideSpeed = Math.sqrt(sx * sx + sy * sy + sz * sz) / n;
  r.impulse = impulse;
  r.contacts = n;
  r.dt = dt;
  return r;
}

/** Derived or construction-time body fields a snapshot leaves out (rebuilt on restore). */
const BODY_SNAPSHOT_SKIP = ["shape", "aabb", "invInertiaWorld"] as const;

/** A `PhysicsWorld.snapshot()` (JSON-safe). */
export interface PhysicsWorldSnapshot {
  world: { accumulator: number; time: number; stepCount: number; fixedDt: number; nextBodyId: number; gravity: [number, number, number] };
  bodies: { id: number; state: StateRecord }[];
}
