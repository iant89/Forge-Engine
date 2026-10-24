/**
 * `PhysicsWorld` — rigid body dynamics simulation world.
 *
 * Implements:
 *  - Fixed timestep simulation with substepping and interpolation
 *  - Deterministic broadphase and narrowphase contact generation
 *  - Bit-for-bit trajectory reproducibility across varying display frame rates
 *
 * Timestep contract (CR-003): `fixedDt` and every `stepOnce` duration are finite and > 0 seconds;
 * `maxSubsteps` and the `stepDeterministic` count are integers (≥ 1 and ≥ 0); `step` takes any
 * non-NaN frame time and clamps it to [0, 0.2]. A violation throws `UsageError` before anything
 * changes, so a bad value can never reach the accumulator or the interpolation factor.
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

function requirePositiveFinite(where: string, name: string, value: number): void {
  if (!(Number.isFinite(value) && value > 0)) {
    throw new UsageError(`${where}: ${name} must be a finite number of seconds > 0 (got ${value})`);
  }
}

function requireInteger(where: string, name: string, value: number, min: number): void {
  if (!(Number.isInteger(value) && value >= min)) {
    throw new UsageError(`${where}: ${name} must be an integer >= ${min} (got ${value})`);
  }
}

/** Small temporal/spatial guards used by the JS continuous-collision path. */
const CCD_TIME_EPS = 1e-8;
const CCD_PENETRATION_EPS = 1e-5;
const MAX_CCD_IMPACTS = 8;

interface CcdHit {
  bodyA: RigidBody;
  bodyB: RigidBody;
  time: number;
  point: Vec3;
  /** Contact normal from the moving body A toward the obstacle B. */
  normal: Vec3;
  indexA: number;
  indexB: number;
}

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
    const fixedDt = options.fixedDt ?? 1 / 60;
    const maxSubsteps = options.maxSubsteps ?? 8;
    requirePositiveFinite("PhysicsWorld", "fixedDt", fixedDt);
    requireInteger("PhysicsWorld", "maxSubsteps", maxSubsteps, 1);
    if (options.gravity) this.gravity.copyFrom(options.gravity);
    this.fixedDt = fixedDt;
    this.maxSubsteps = maxSubsteps;
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
   * (or `backend`) plus gravity / fixedDt / solverOptions. An invalid `fixedDt` throws before any
   * option is applied. `maxSubsteps` is construction-only and is not applied here.
   */
  applyOptions(options: PhysicsWorldOptions): void {
    if (options.fixedDt !== undefined) requirePositiveFinite("PhysicsWorld.applyOptions", "fixedDt", options.fixedDt);
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
    requirePositiveFinite("PhysicsWorld.restoreSnapshot", "fixedDt", w.fixedDt);
    if (!(Number.isFinite(w.accumulator) && w.accumulator >= 0)) {
      throw new UsageError(`PhysicsWorld.restoreSnapshot: accumulator must be a finite number >= 0 (got ${w.accumulator})`);
    }
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
   * `dt` is clamped to [0, 0.2] seconds; `NaN` throws, since it would poison the accumulator and
   * stop the world for good.
   */
  step(dt: number): number {
    if (Number.isNaN(dt)) throw new UsageError("PhysicsWorld.step: dt is NaN");
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
    requireInteger("PhysicsWorld.stepDeterministic", "fixedSteps", fixedSteps, 0);
    for (let i = 0; i < fixedSteps; i++) {
      this.fixedStep(this.fixedDt);
    }
  }

  /**
   * Run exactly one solver step with timestep `dt` (defaults to {@link fixedDt}).
   * Does **not** use the variable-dt accumulator — callers that already own a fixed
   * clock (e.g. {@link PhysicsSystem} via `context.fixedDt`) get one step per call,
   * never 0/N from leftover accumulator state. Render poses snap to the post-step pose.
   * `dt` must be finite and > 0: a zero-length step is rejected rather than counted as a step.
   */
  stepOnce(dt: number = this.fixedDt): void {
    requirePositiveFinite("PhysicsWorld.stepOnce", "dt", dt);
    this.fixedStep(dt);
    // ECS / deterministic callers have no leftover frame alpha — snap render = sim.
    for (const body of this.bodies) {
      body.interpolate(1);
    }
  }

  private fixedStep(dt: number): void {
    const n = this.bodies.length;
    let remaining = dt;
    let firstSegment = true;
    let impacts = 0;
    for (const body of this.bodies) body.updateAABB();

    // A fixed step normally remains one integrate/solve/integrate pass. When a fast dynamic body
    // has a time-of-impact with an immovable collider, split only that step at the impact. This
    // keeps ordinary scenes on the old deterministic path while preventing a thin wall from being
    // skipped by a single large position update.
    while (remaining > CCD_TIME_EPS && impacts < MAX_CCD_IMPACTS) {
      const hit = findCcdHit(this.bodies, remaining);
      const segmentDt = hit ? Math.min(remaining, Math.max(hit.time, CCD_TIME_EPS)) : remaining;
      const finalSegment = !hit || remaining - segmentDt <= CCD_TIME_EPS;

      // 1. Integrate external forces & gravity to velocities for this temporal segment.
      for (let i = 0; i < n; i++) {
        this.bodies[i]!.integrateVelocity(segmentDt, this.gravity);
      }

      if (hit) {
        // Move to the event before solving its impact. The regular discrete manifold may be absent
        // for a conservative bounding-sphere sweep, so a synthetic event contact is added below
        // when the narrowphase has not produced the pair.
        for (let i = 0; i < n; i++) {
          integratePositionSegment(this.bodies[i]!, segmentDt, !finalSegment, !firstSegment);
        }
        firstSegment = false;

        // Move an infinitesimal distance into the obstacle. Exact touching is intentionally not a
        // persistent narrowphase contact in this engine; this nudge makes the next segment's normal
        // contact stable without changing the measurable impact pose.
        hit.bodyA.position.x += hit.normal.x * CCD_PENETRATION_EPS;
        hit.bodyA.position.y += hit.normal.y * CCD_PENETRATION_EPS;
        hit.bodyA.position.z += hit.normal.z * CCD_PENETRATION_EPS;
        hit.bodyA.updateAABB();

        const manifolds = collectManifolds(this.bodies, this.broadphase);
        if (!hasManifoldPair(manifolds, hit.bodyA, hit.bodyB)) {
          const impact = new ContactManifold(hit.bodyA, hit.bodyB);
          impact.addContact(hit.point, hit.normal, CCD_PENETRATION_EPS);
          manifolds.push(impact);
        }
        solveManifolds(manifolds, this.solver, this.contactListener, segmentDt);

        remaining -= segmentDt;
        impacts++;
      } else {
        // 2–3. The ordinary path: contacts at the segment start, then position integration.
        const manifolds = collectManifolds(this.bodies, this.broadphase);
        solveManifolds(manifolds, this.solver, this.contactListener, segmentDt);
        for (let i = 0; i < n; i++) {
          integratePositionSegment(this.bodies[i]!, segmentDt, false, !firstSegment);
        }
        firstSegment = false;
        remaining = 0;
      }
    }

    // Avoid dropping a tiny remainder if the impact budget is exhausted or the remaining time is
    // below the event epsilon. It is still deterministic; the cap only limits pathological stacks.
    if (remaining > 0) {
      for (let i = 0; i < n; i++) this.bodies[i]!.integrateVelocity(remaining, this.gravity);
      const manifolds = collectManifolds(this.bodies, this.broadphase);
      solveManifolds(manifolds, this.solver, this.contactListener, remaining);
      for (let i = 0; i < n; i++) {
        integratePositionSegment(this.bodies[i]!, remaining, false, !firstSegment);
      }
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

/**
 * Run the legacy public position integrator while preserving fixed-step bookkeeping across CCD
 * segments. Keeping this policy outside RigidBody avoids changing its public API for an internal
 * temporal split.
 */
function integratePositionSegment(
  body: RigidBody,
  dt: number,
  preserveForces: boolean,
  preservePrevious: boolean,
): void {
  if (body.invMass === 0) {
    body.integratePosition(dt);
    return;
  }

  const fx = body.force.x;
  const fy = body.force.y;
  const fz = body.force.z;
  const tx = body.torque.x;
  const ty = body.torque.y;
  const tz = body.torque.z;
  const px = body.prevPosition.x;
  const py = body.prevPosition.y;
  const pz = body.prevPosition.z;
  const qx = body.prevRotation.x;
  const qy = body.prevRotation.y;
  const qz = body.prevRotation.z;
  const qw = body.prevRotation.w;

  body.integratePosition(dt);

  if (preserveForces) {
    body.force.set(fx, fy, fz);
    body.torque.set(tx, ty, tz);
  }
  if (preservePrevious) {
    body.prevPosition.set(px, py, pz);
    body.prevRotation.set(qx, qy, qz, qw);
  }
}

/** Refresh the deterministic broadphase and produce narrowphase manifolds in insertion order. */
function collectManifolds(
  bodies: readonly RigidBody[],
  broadphase: SweepAndPruneBroadphase,
): ContactManifold[] {
  const manifolds: ContactManifold[] = [];
  for (const body of bodies) body.updateAABB();
  // The sweep-and-prune index reduces pair checks; candidate order is restored to insertion order,
  // preserving deterministic manifold/solver ordering from the original nested loop.
  const pairs = broadphase.query(bodies);
  for (const pair of pairs) {
    const bA = bodies[pair.a]!;
    const bB = bodies[pair.b]!;
    const manifold = collideBodies(bA, bB);
    if (manifold && manifold.contacts.length > 0) manifolds.push(manifold);
  }
  return manifolds;
}

/** Solve a manifold batch and synchronously publish the existing contact-report view. */
function solveManifolds(
  manifolds: ContactManifold[],
  solver: SequentialImpulseSolver,
  listener: ((report: ContactReport) => void) | null,
  dt: number,
): void {
  if (listener) {
    CLOSING.length = manifolds.length;
    for (let i = 0; i < manifolds.length; i++) CLOSING[i] = closingSpeed(manifolds[i]!);
  }
  solver.solve(manifolds, dt);
  if (listener) {
    for (let i = 0; i < manifolds.length; i++) listener(fillReport(manifolds[i]!, CLOSING[i]!, dt));
  }
}

/** Find the earliest supported dynamic-vs-static/kinematic impact in the remaining interval. */
function findCcdHit(bodies: readonly RigidBody[], maxDt: number): CcdHit | null {
  let best: CcdHit | null = null;
  for (let i = 0; i < bodies.length; i++) {
    const bodyA = bodies[i]!;
    if (bodyA.invMass === 0) continue;
    const speedSq = bodyA.linearVelocity.lengthSq();
    if (speedSq <= 1e-16) continue;
    const speed = Math.sqrt(speedSq);
    if (speed * maxDt <= Math.max(1e-4, ccdTravelThreshold(bodyA, speed))) continue;

    for (let j = 0; j < bodies.length; j++) {
      if (i === j) continue;
      const bodyB = bodies[j]!;
      if (bodyB.invMass !== 0) continue;
      // Existing penetration is handled by the ordinary solver. This also prevents an event at
      // t=0 from retriggering after a zero-restitution impact.
      if (collideBodies(bodyA, bodyB)) continue;

      const radius = ccdBoundingRadius(bodyA);
      if (!(radius > 0)) continue;
      if (!(bodyB.shape instanceof PlaneShape) && !sweptAabbMayOverlap(bodyA, bodyB, maxDt)) continue;
      const hit = sweepBodyAgainst(bodyA, bodyB, maxDt, radius);
      if (!hit || hit.time <= CCD_TIME_EPS || hit.time > maxDt + CCD_TIME_EPS) continue;
      if (!best || hit.time < best.time - CCD_TIME_EPS ||
          (Math.abs(hit.time - best.time) <= CCD_TIME_EPS && (i < best.indexA ||
            (i === best.indexA && j < best.indexB)))) {
        hit.indexA = i;
        hit.indexB = j;
        best = hit;
      }
    }
  }
  return best;
}

function hasManifoldPair(manifolds: readonly ContactManifold[], bodyA: RigidBody, bodyB: RigidBody): boolean {
  return manifolds.some((m) =>
    (m.bodyA === bodyA && m.bodyB === bodyB) || (m.bodyA === bodyB && m.bodyB === bodyA));
}

/** Conservative radius used for shape sweeps. Unsupported shapes stay on the existing discrete path. */
function sweptAabbMayOverlap(bodyA: RigidBody, bodyB: RigidBody, maxDt: number): boolean {
  const dx = (bodyA.linearVelocity.x - bodyB.linearVelocity.x) * maxDt;
  const dy = (bodyA.linearVelocity.y - bodyB.linearVelocity.y) * maxDt;
  const dz = (bodyA.linearVelocity.z - bodyB.linearVelocity.z) * maxDt;
  const minX = Math.min(bodyA.aabb.min.x, bodyA.aabb.min.x + dx);
  const maxX = Math.max(bodyA.aabb.max.x, bodyA.aabb.max.x + dx);
  const minY = Math.min(bodyA.aabb.min.y, bodyA.aabb.min.y + dy);
  const maxY = Math.max(bodyA.aabb.max.y, bodyA.aabb.max.y + dy);
  const minZ = Math.min(bodyA.aabb.min.z, bodyA.aabb.min.z + dz);
  const maxZ = Math.max(bodyA.aabb.max.z, bodyA.aabb.max.z + dz);
  return minX <= bodyB.aabb.max.x && maxX >= bodyB.aabb.min.x &&
    minY <= bodyB.aabb.max.y && maxY >= bodyB.aabb.min.y &&
    minZ <= bodyB.aabb.max.z && maxZ >= bodyB.aabb.min.z;
}

function ccdBoundingRadius(body: RigidBody): number {
  const shape = body.shape;
  if (shape instanceof SphereShape) return shape.radius;
  if (shape instanceof BoxShape) {
    const { x, y, z } = shape.halfExtents;
    return Math.sqrt(x * x + y * y + z * z);
  }
  return 0;
}

/** Do not turn ordinary slow resting motion into a time-of-impact event; discrete contact handles it. */
function ccdTravelThreshold(body: RigidBody, speed: number): number {
  const shape = body.shape;
  if (shape instanceof SphereShape) return shape.radius * 0.5;
  if (shape instanceof BoxShape && speed > 0) {
    const direction = new Vec3(
      body.linearVelocity.x / speed,
      body.linearVelocity.y / speed,
      body.linearVelocity.z / speed,
    );
    return ccdPlaneSupport(body, direction) * 0.5;
  }
  return ccdBoundingRadius(body) * 0.5;
}

function ccdPlaneSupport(body: RigidBody, normal: Vec3): number {
  const shape = body.shape;
  if (shape instanceof SphereShape) return shape.radius;
  if (shape instanceof BoxShape) {
    const x = new Vec3(1, 0, 0);
    const y = new Vec3(0, 1, 0);
    const z = new Vec3(0, 0, 1);
    body.rotation.rotateVector(x, x);
    body.rotation.rotateVector(y, y);
    body.rotation.rotateVector(z, z);
    return shape.halfExtents.x * Math.abs(normal.dot(x)) +
      shape.halfExtents.y * Math.abs(normal.dot(y)) +
      shape.halfExtents.z * Math.abs(normal.dot(z));
  }
  return ccdBoundingRadius(body);
}

function makeCcdHit(
  bodyA: RigidBody,
  bodyB: RigidBody,
  time: number,
  point: Vec3,
  normal: Vec3,
): CcdHit {
  return { bodyA, bodyB, time, point, normal, indexA: -1, indexB: -1 };
}

/** Sweep a supported dynamic primitive against one immovable collider. */
function sweepBodyAgainst(bodyA: RigidBody, bodyB: RigidBody, maxDt: number, radiusA: number): CcdHit | null {
  const target = bodyB.shape;
  if (target instanceof PlaneShape) {
    const n = target.normal;
    const signedDistance = bodyA.position.x * n.x + bodyA.position.y * n.y + bodyA.position.z * n.z + target.constant;
    const support = ccdPlaneSupport(bodyA, n);
    const relativeVelocity = new Vec3(
      bodyA.linearVelocity.x - bodyB.linearVelocity.x,
      bodyA.linearVelocity.y - bodyB.linearVelocity.y,
      bodyA.linearVelocity.z - bodyB.linearVelocity.z,
    );
    const normalSpeed = relativeVelocity.dot(n);
    if (signedDistance - support <= CCD_PENETRATION_EPS || normalSpeed >= -1e-9) return null;
    const time = (signedDistance - support) / -normalSpeed;
    if (time < 0 || time > maxDt) return null;
    const normal = new Vec3(-n.x, -n.y, -n.z);
    const point = new Vec3(
      bodyA.position.x + normal.x * support,
      bodyA.position.y + normal.y * support,
      bodyA.position.z + normal.z * support,
    );
    return makeCcdHit(bodyA, bodyB, time, point, normal);
  }

  if (target instanceof SphereShape) {
    const relativePosition = new Vec3(
      bodyB.position.x - bodyA.position.x,
      bodyB.position.y - bodyA.position.y,
      bodyB.position.z - bodyA.position.z,
    );
    const relativeVelocity = new Vec3(
      bodyA.linearVelocity.x - bodyB.linearVelocity.x,
      bodyA.linearVelocity.y - bodyB.linearVelocity.y,
      bodyA.linearVelocity.z - bodyB.linearVelocity.z,
    );
    const radius = radiusA + target.radius;
    // The separation vector is B - A, while `relativeVelocity` is A - B. The future vector is
    // therefore `relativePosition - relativeVelocity * t`.
    const a = relativeVelocity.dot(relativeVelocity);
    const approach = relativePosition.dot(relativeVelocity);
    const b = -2 * approach;
    const c = relativePosition.dot(relativePosition) - radius * radius;
    const discriminant = b * b - 4 * a * c;
    if (!(a > 1e-12) || discriminant < 0 || approach <= 0) return null;
    const time = (-b - Math.sqrt(discriminant)) / (2 * a);
    if (time < 0 || time > maxDt) return null;
    const ax = bodyA.position.x + bodyA.linearVelocity.x * time;
    const ay = bodyA.position.y + bodyA.linearVelocity.y * time;
    const az = bodyA.position.z + bodyA.linearVelocity.z * time;
    const bx = bodyB.position.x + bodyB.linearVelocity.x * time;
    const by = bodyB.position.y + bodyB.linearVelocity.y * time;
    const bz = bodyB.position.z + bodyB.linearVelocity.z * time;
    const normal = new Vec3(bx - ax, by - ay, bz - az);
    if (normal.lengthSq() <= 1e-12) normal.set(1, 0, 0);
    else normal.normalize();
    const point = new Vec3(ax + normal.x * radiusA, ay + normal.y * radiusA, az + normal.z * radiusA);
    return makeCcdHit(bodyA, bodyB, time, point, normal);
  }

  if (target instanceof BoxShape) {
    const inverseRotation = bodyB.rotation.clone().conjugate();
    const localPosition = new Vec3(
      bodyA.position.x - bodyB.position.x,
      bodyA.position.y - bodyB.position.y,
      bodyA.position.z - bodyB.position.z,
    );
    const localVelocity = new Vec3(
      bodyA.linearVelocity.x - bodyB.linearVelocity.x,
      bodyA.linearVelocity.y - bodyB.linearVelocity.y,
      bodyA.linearVelocity.z - bodyB.linearVelocity.z,
    );
    inverseRotation.rotateVector(localPosition, localPosition);
    inverseRotation.rotateVector(localVelocity, localVelocity);
    const ex = target.halfExtents.x + radiusA;
    const ey = target.halfExtents.y + radiusA;
    const ez = target.halfExtents.z + radiusA;
    const slab = sweepPointAabb(localPosition, localVelocity, -ex, ex, -ey, ey, -ez, ez, maxDt);
    if (!slab) return null;
    const localNormal = new Vec3();
    if (slab.axis === 0) localNormal.set(slab.sign, 0, 0);
    else if (slab.axis === 1) localNormal.set(0, slab.sign, 0);
    else localNormal.set(0, 0, slab.sign);
    const normal = new Vec3();
    bodyB.rotation.rotateVector(localNormal, normal).normalize();
    const ax = bodyA.position.x + bodyA.linearVelocity.x * slab.time;
    const ay = bodyA.position.y + bodyA.linearVelocity.y * slab.time;
    const az = bodyA.position.z + bodyA.linearVelocity.z * slab.time;
    const point = new Vec3(ax + normal.x * radiusA, ay + normal.y * radiusA, az + normal.z * radiusA);
    return makeCcdHit(bodyA, bodyB, slab.time, point, normal);
  }

  if (target instanceof HeightfieldShape) {
    return sweepAgainstHeightfield(bodyA, bodyB, target, maxDt, radiusA);
  }

  return null;
}

interface SlabHit {
  time: number;
  axis: 0 | 1 | 2;
  sign: number;
}

function sweepPointAabb(
  position: Vec3,
  velocity: Vec3,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  minZ: number,
  maxZ: number,
  maxDt: number,
): SlabHit | null {
  const mins = [minX, minY, minZ];
  const maxs = [maxX, maxY, maxZ];
  const points = [position.x, position.y, position.z];
  const speeds = [velocity.x, velocity.y, velocity.z];
  let entry = 0;
  let exit = maxDt;
  let axis: 0 | 1 | 2 = 0;
  let sign = 0;

  for (let i = 0; i < 3; i++) {
    const p = points[i]!;
    const v = speeds[i]!;
    const lo = mins[i]!;
    const hi = maxs[i]!;
    if (Math.abs(v) <= 1e-12) {
      if (p < lo || p > hi) return null;
      continue;
    }
    const tLo = (lo - p) / v;
    const tHi = (hi - p) / v;
    const near = Math.min(tLo, tHi);
    const far = Math.max(tLo, tHi);
    if (near > entry) {
      entry = near;
      axis = i as 0 | 1 | 2;
      sign = v > 0 ? 1 : -1;
    }
    exit = Math.min(exit, far);
    if (entry > exit) return null;
  }

  if (entry < 0 || entry > maxDt || sign === 0) return null;
  return { time: entry, axis, sign };
}

function sweepAgainstHeightfield(
  bodyA: RigidBody,
  bodyB: RigidBody,
  heightfield: HeightfieldShape,
  maxDt: number,
  radius: number,
): CcdHit | null {
  const vx = bodyA.linearVelocity.x - bodyB.linearVelocity.x;
  const vy = bodyA.linearVelocity.y - bodyB.linearVelocity.y;
  const vz = bodyA.linearVelocity.z - bodyB.linearVelocity.z;
  const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
  const gapAt = (time: number): number => {
    const x = bodyA.position.x + vx * time;
    const y = bodyA.position.y + vy * time;
    const z = bodyA.position.z + vz * time;
    return y - radius - heightfield.sampleHeight(x, z);
  };
  const startGap = gapAt(0);
  if (startGap <= CCD_PENETRATION_EPS || !(speed > 0)) return null;
  const samples = Math.max(16, Math.min(96, Math.ceil((speed * maxDt) / Math.max(radius * 0.5, 0.05))));
  let previousTime = 0;
  let previousGap = startGap;
  for (let i = 1; i <= samples; i++) {
    const time = (i / samples) * maxDt;
    const gap = gapAt(time);
    if (gap <= 0 && previousGap > 0) {
      let lo = previousTime;
      let hi = time;
      for (let iteration = 0; iteration < 14; iteration++) {
        const mid = (lo + hi) * 0.5;
        if (gapAt(mid) > 0) lo = mid;
        else hi = mid;
      }
      const hitTime = hi;
      const x = bodyA.position.x + vx * hitTime;
      const y = bodyA.position.y + vy * hitTime;
      const z = bodyA.position.z + vz * hitTime;
      const terrainNormal = heightfield.sampleNormal(x, z);
      const normal = new Vec3(-terrainNormal.x, -terrainNormal.y, -terrainNormal.z);
      const point = new Vec3(x + normal.x * radius, y + normal.y * radius, z + normal.z * radius);
      return makeCcdHit(bodyA, bodyB, hitTime, point, normal);
    }
    previousTime = time;
    previousGap = gap;
  }
  return null;
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
