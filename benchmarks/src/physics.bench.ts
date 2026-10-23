/**
 * Phase 22.4 physics benchmark matrix.
 *
 * The physics implementation already has deterministic broadphase, narrowphase, solver, query and
 * vehicle APIs. This matrix keeps those paths measurable as one reproducible CPU workload rather
 * than treating the existence of a physics test as a performance result:
 *
 * - broadphase runs sparse/dense AABB sets and records both candidate generation and pruning;
 * - narrowphase visits every supported shape-pair dispatcher with real contact manifolds;
 * - solver rows measure sequential impulses and a fixed-step resting-contact scenario;
 * - query rows cover world raycasts and registered heightfield samples; and
 * - vehicle rows run several deterministic fixed-step fleets through the tire/drivetrain model.
 *
 * Timings are intentionally reported without a cross-host threshold. The runner's guards validate
 * work shape, finite state, deterministic digests and broad catastrophe bounds; Phase 22.7 owns
 * repeated same-host history and statistical regression policy.
 */

import {
  AABB,
  BoxShape,
  ContactManifold,
  HeightfieldShape,
  PhysicsWorld,
  PlaneShape,
  Ray,
  RayHit,
  RigidBody,
  SequentialImpulseSolver,
  SphereShape,
  SweepAndPruneBroadphase,
  Vec3,
  Vehicle,
  collideBodies,
  createVehicleConfig,
  slopeGround,
  type GroundQuery,
} from "@forge/engine";
import type { BenchmarkResult } from "./ecs.bench.ts";

export interface PhysicsBenchmarkOptions {
  /** Body counts used by the sweep-and-prune matrix. */
  broadphaseCounts?: readonly number[];
  /** Number of repeated contacts per supported narrowphase pair. */
  narrowphasePairs?: number;
  /** Dynamic contacts used by the direct sequential-impulse row. */
  solverBodies?: number;
  /** Dynamic bodies used by the fixed-step stability row. */
  stabilityBodies?: number;
  /** Fixed steps in the resting-contact stability row. */
  stabilitySteps?: number;
  /** Static colliders placed in the raycast world. */
  queryBodies?: number;
  /** Downward rays cast through the query world. */
  queryRays?: number;
  /** Heightfield samples issued through PhysicsWorld.queryHeight. */
  heightfieldQueries?: number;
  /** Vehicle counts in the fleet matrix. */
  vehicleCounts?: readonly number[];
  /** Fixed steps per vehicle fleet. */
  vehicleSteps?: number;
  /** Median samples for repeatable CPU rows. */
  runs?: number;
}

export interface BroadphaseTiming {
  bodyCount: number;
  possiblePairs: number;
  axisCandidates: number;
  overlapPairs: number;
  pairDigest: number;
  deterministic: boolean;
  durationMs: number;
}

export interface NarrowphaseTiming {
  pairKind: NarrowphasePairKind;
  pairCount: number;
  collisions: number;
  contacts: number;
  contactDigest: number;
  deterministic: boolean;
  durationMs: number;
}

export interface SolverTiming {
  bodyCount: number;
  manifoldCount: number;
  contactCount: number;
  normalImpulse: number;
  maxSpeed: number;
  deterministic: boolean;
  durationMs: number;
}

export interface StabilityTiming {
  bodyCount: number;
  steps: number;
  maxPenetration: number;
  maxSpeed: number;
  stateDigest: number;
  deterministic: boolean;
  durationMs: number;
}

export interface RaycastTiming {
  bodyCount: number;
  rayCount: number;
  hits: number;
  distanceSum: number;
  hitDigest: number;
  deterministic: boolean;
  durationMs: number;
}

export interface HeightfieldQueryTiming {
  bodyCount: number;
  queryCount: number;
  heightSum: number;
  minHeight: number;
  maxHeight: number;
  deterministic: boolean;
  durationMs: number;
}

export interface VehicleTiming {
  vehicleCount: number;
  steps: number;
  stateDigest: number;
  finalSpeed: number;
  contactWheels: number;
  deterministic: boolean;
  durationMs: number;
}

export interface PhysicsBenchmarkReport {
  results: BenchmarkResult[];
  broadphase: { timings: BroadphaseTiming[] };
  narrowphase: { timings: NarrowphaseTiming[] };
  solver: SolverTiming;
  stability: StabilityTiming;
  queries: {
    raycasts: RaycastTiming;
    heightfield: HeightfieldQueryTiming;
  };
  vehicles: { timings: VehicleTiming[] };
  notes: string[];
}

const DEFAULT_BROADPHASE_COUNTS = [128, 512, 2_048];
const DEFAULT_NARROWPHASE_PAIRS = 512;
const DEFAULT_SOLVER_BODIES = 64;
const DEFAULT_STABILITY_BODIES = 32;
const DEFAULT_STABILITY_STEPS = 90;
const DEFAULT_QUERY_BODIES = 256;
const DEFAULT_QUERY_RAYS = 512;
const DEFAULT_HEIGHTFIELD_QUERIES = 4_096;
const DEFAULT_VEHICLE_COUNTS = [8, 32, 64];
const DEFAULT_VEHICLE_STEPS = 120;
const DEFAULT_RUNS = 3;
const FIXED_DT = 1 / 60;

const numberBits = new DataView(new ArrayBuffer(8));

type NarrowphasePairKind =
  | "sphere-sphere"
  | "sphere-box"
  | "box-box"
  | "sphere-plane"
  | "box-plane"
  | "sphere-heightfield"
  | "box-heightfield";

const NARROWPHASE_KINDS: readonly NarrowphasePairKind[] = [
  "sphere-sphere",
  "sphere-box",
  "box-box",
  "sphere-plane",
  "box-plane",
  "sphere-heightfield",
  "box-heightfield",
];

function median(samples: readonly number[]): number {
  const ordered = [...samples].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)] ?? 0;
}

function finite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`physics benchmark produced a non-finite ${label}`);
}

function mixNumber(hash: number, value: number): number {
  finite(value, "digest input");
  numberBits.setFloat64(0, value, true);
  hash = Math.imul(hash ^ numberBits.getUint32(0, true), 16_777_619) >>> 0;
  return Math.imul(hash ^ numberBits.getUint32(4, true), 16_777_619) >>> 0;
}

function mixInteger(hash: number, value: number): number {
  return Math.imul(hash ^ (value >>> 0), 16_777_619) >>> 0;
}

function benchmarkResult(name: string, count: number, durationMs: number): BenchmarkResult {
  return {
    name,
    count,
    durationMs,
    opsPerSec: (count * 1000) / Math.max(durationMs, 1e-9),
  };
}

function timed(runs: number, fn: () => void): number {
  fn();
  const samples: number[] = [];
  for (let i = 0; i < Math.max(1, runs); i++) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return median(samples);
}

function makeBroadphaseBodies(count: number): RigidBody[] {
  const bodies: RigidBody[] = [];
  const columns = 32;
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / columns);
    const type = i % 19 === 0 ? "static" : "dynamic";
    bodies.push(new RigidBody({
      type,
      shape: new BoxShape(0.5, 0.5, 0.5),
      position: {
        x: (i % columns) * 0.78 - (columns - 1) * 0.39,
        y: (row % 4) * 1.5,
        z: Math.floor(row / 4) * 1.6,
      },
    }));
  }
  return bodies;
}

function broadphaseDigest(pairs: readonly { a: number; b: number }[]): number {
  let hash = 2_166_136_261;
  for (const pair of pairs) {
    hash = mixInteger(hash, pair.a);
    hash = mixInteger(hash, pair.b);
  }
  return hash >>> 0;
}

function runBroadphaseBenchmark(counts: readonly number[], runs: number): { timings: BroadphaseTiming[]; results: BenchmarkResult[] } {
  const timings: BroadphaseTiming[] = [];
  for (const requested of counts) {
    const bodyCount = Math.max(2, Math.floor(requested));
    const bodies = makeBroadphaseBodies(bodyCount);
    const broadphase = new SweepAndPruneBroadphase();
    let pairDigest = 0;
    let stats = { bodyCount: 0, possiblePairs: 0, axisCandidates: 0, overlapPairs: 0 };
    const execute = (): void => {
      const pairs = broadphase.query(bodies);
      pairDigest = broadphaseDigest(pairs);
      stats = { ...broadphase.stats };
    };
    const durationMs = timed(runs, execute);
    const referenceDigest = pairDigest;
    execute();
    const deterministic = pairDigest === referenceDigest && stats.overlapPairs >= 0;
    timings.push({ ...stats, pairDigest, deterministic, durationMs });
  }
  return {
    timings,
    results: timings.map((timing) => benchmarkResult(
      `physics broadphase pair generation + pruning ${timing.bodyCount} bodies`,
      timing.bodyCount,
      timing.durationMs,
    )),
  };
}

function heightAt(x: number, z: number): number {
  return Math.sin(x * 0.07) * 0.35 + Math.cos(z * 0.05) * 0.2 + Math.sin((x + z) * 0.025) * 0.12;
}

function heightNormalAt(x: number, z: number, out = new Vec3()): Vec3 {
  const dx = 0.07 * 0.35 * Math.cos(x * 0.07) + 0.025 * 0.12 * Math.cos((x + z) * 0.025);
  const dz = -0.05 * 0.2 * Math.sin(z * 0.05) + 0.025 * 0.12 * Math.cos((x + z) * 0.025);
  return out.set(-dx, 1, -dz).normalize();
}

function makeNarrowphasePair(kind: NarrowphasePairKind, index: number): [RigidBody, RigidBody] {
  // Small, deterministic offsets exercise the same dispatch path without allowing a pair to become
  // separated. The offset also prevents a benchmark from accidentally measuring one cached answer.
  const offset = (index % 17) * 0.001;
  const heightfield = (): HeightfieldShape => new HeightfieldShape({
    sampleHeight: heightAt,
    sampleNormal: heightNormalAt,
    bounds: new AABB(new Vec3(-100, -10, -100), new Vec3(100, 10, 100)),
  });
  switch (kind) {
    case "sphere-sphere":
      return [
        new RigidBody({ shape: new SphereShape(0.5), position: { x: 0, y: 0, z: 0 } }),
        new RigidBody({ type: "static", shape: new SphereShape(0.5), position: { x: 0.7 + offset, y: 0, z: 0 } }),
      ];
    case "sphere-box":
      return [
        new RigidBody({ shape: new SphereShape(0.4), position: { x: 0.75 + offset, y: 0, z: 0 } }),
        new RigidBody({ type: "static", shape: new BoxShape(0.5, 0.5, 0.5), position: { x: 0, y: 0, z: 0 } }),
      ];
    case "box-box":
      return [
        new RigidBody({ shape: new BoxShape(0.5, 0.5, 0.5), position: { x: 0, y: 0, z: 0 } }),
        new RigidBody({ type: "static", shape: new BoxShape(0.5, 0.5, 0.5), position: { x: 0.7 + offset, y: 0, z: 0 } }),
      ];
    case "sphere-plane":
      return [
        new RigidBody({ shape: new SphereShape(0.5), position: { x: offset, y: 0.3, z: 0 } }),
        new RigidBody({ type: "static", shape: new PlaneShape(new Vec3(0, 1, 0), 0) }),
      ];
    case "box-plane":
      return [
        new RigidBody({ shape: new BoxShape(0.5, 0.5, 0.5), position: { x: offset, y: 0.3, z: 0 } }),
        new RigidBody({ type: "static", shape: new PlaneShape(new Vec3(0, 1, 0), 0) }),
      ];
    case "sphere-heightfield":
      return [
        new RigidBody({ shape: new SphereShape(0.5), position: { x: offset, y: heightAt(offset, 0) + 0.3, z: 0 } }),
        new RigidBody({ type: "static", shape: heightfield() }),
      ];
    case "box-heightfield":
      return [
        new RigidBody({ shape: new BoxShape(0.5, 0.5, 0.5), position: { x: offset, y: heightAt(offset, 0) + 0.3, z: 0 } }),
        new RigidBody({ type: "static", shape: heightfield() }),
      ];
  }
}

function contactDigest(manifold: ContactManifold): number {
  let hash = 2_166_136_261;
  hash = mixInteger(hash, manifold.contacts.length);
  for (const contact of manifold.contacts) {
    hash = mixNumber(hash, contact.penetration);
    hash = mixNumber(hash, contact.point.x);
    hash = mixNumber(hash, contact.point.y);
    hash = mixNumber(hash, contact.point.z);
    hash = mixNumber(hash, contact.normal.x);
    hash = mixNumber(hash, contact.normal.y);
    hash = mixNumber(hash, contact.normal.z);
  }
  return hash >>> 0;
}

function runNarrowphaseBenchmark(pairCountOption: number, runs: number): { timings: NarrowphaseTiming[]; results: BenchmarkResult[] } {
  const pairCount = Math.max(1, Math.floor(pairCountOption));
  const timings: NarrowphaseTiming[] = [];
  for (const pairKind of NARROWPHASE_KINDS) {
    const pairs = Array.from({ length: pairCount }, (_, index) => makeNarrowphasePair(pairKind, index));
    let collisions = 0;
    let contacts = 0;
    let digest = 0;
    const execute = (): void => {
      collisions = 0;
      contacts = 0;
      digest = 2_166_136_261;
      for (const [bodyA, bodyB] of pairs) {
        const manifold = collideBodies(bodyA, bodyB);
        if (!manifold) continue;
        collisions++;
        contacts += manifold.contacts.length;
        digest = mixInteger(digest, contactDigest(manifold));
      }
    };
    const durationMs = timed(runs, execute);
    const referenceDigest = digest;
    const referenceCollisions = collisions;
    const referenceContacts = contacts;
    execute();
    timings.push({
      pairKind,
      pairCount,
      collisions,
      contacts,
      contactDigest: digest,
      deterministic: digest === referenceDigest && collisions === referenceCollisions && contacts === referenceContacts,
      durationMs,
    });
  }
  return {
    timings,
    results: timings.map((timing) => benchmarkResult(
      `physics narrowphase ${timing.pairKind} manifold generation`,
      timing.pairCount,
      timing.durationMs,
    )),
  };
}

interface ContactSet {
  bodies: RigidBody[];
  manifolds: ContactManifold[];
}

function makeSolverContactSet(bodyCount: number): ContactSet {
  const plane = new RigidBody({ type: "static", shape: new PlaneShape(new Vec3(0, 1, 0), 0) });
  const bodies: RigidBody[] = [];
  const manifolds: ContactManifold[] = [];
  for (let i = 0; i < bodyCount; i++) {
    const body = new RigidBody({
      shape: new BoxShape(0.45, 0.45, 0.45),
      mass: 2,
      friction: 0.7,
      position: {
        x: (i % 8) * 1.1 - 3.85,
        y: 0.43,
        z: Math.floor(i / 8) * 1.1 - 3.3,
      },
    });
    const manifold = collideBodies(body, plane);
    if (!manifold || manifold.contacts.length === 0) throw new Error("solver benchmark failed to create a contact manifold");
    bodies.push(body);
    manifolds.push(manifold);
  }
  return { bodies, manifolds };
}

function resetSolverState(set: ContactSet): void {
  for (let i = 0; i < set.bodies.length; i++) {
    const body = set.bodies[i]!;
    body.linearVelocity.set(((i % 3) - 1) * 0.4, -1.25 - (i % 5) * 0.05, ((i % 5) - 2) * 0.1);
    body.angularVelocity.set(0.01 * (i % 2), -0.015 * (i % 3), 0.02 * (i % 4));
  }
  for (const manifold of set.manifolds) {
    for (const contact of manifold.contacts) {
      contact.normalImpulse = 0;
      contact.tangentImpulse1 = 0;
      contact.tangentImpulse2 = 0;
    }
  }
}

function solverStateDigest(set: ContactSet): number {
  let hash = 2_166_136_261;
  for (const body of set.bodies) {
    hash = mixNumber(hash, body.linearVelocity.x);
    hash = mixNumber(hash, body.linearVelocity.y);
    hash = mixNumber(hash, body.linearVelocity.z);
    hash = mixNumber(hash, body.angularVelocity.x);
    hash = mixNumber(hash, body.angularVelocity.y);
    hash = mixNumber(hash, body.angularVelocity.z);
  }
  return hash >>> 0;
}

function runSolverBenchmark(bodyCountOption: number, runs: number): { timing: SolverTiming; result: BenchmarkResult } {
  const bodyCount = Math.max(1, Math.floor(bodyCountOption));
  const set = makeSolverContactSet(bodyCount);
  const solver = new SequentialImpulseSolver({ velocityIterations: 8, positionIterations: 2 });
  let normalImpulse = 0;
  let maxSpeed = 0;
  let stateDigest = 0;
  const execute = (): void => {
    resetSolverState(set);
    solver.solve(set.manifolds, FIXED_DT);
    normalImpulse = 0;
    maxSpeed = 0;
    for (const manifold of set.manifolds) {
      for (const contact of manifold.contacts) normalImpulse += contact.normalImpulse;
    }
    for (const body of set.bodies) {
      maxSpeed = Math.max(maxSpeed, Math.hypot(body.linearVelocity.x, body.linearVelocity.y, body.linearVelocity.z));
    }
    stateDigest = solverStateDigest(set);
  };
  const durationMs = timed(runs, execute);
  const referenceDigest = stateDigest;
  const referenceImpulse = normalImpulse;
  const referenceSpeed = maxSpeed;
  execute();
  const timing: SolverTiming = {
    bodyCount,
    manifoldCount: set.manifolds.length,
    contactCount: set.manifolds.reduce((sum, manifold) => sum + manifold.contacts.length, 0),
    normalImpulse,
    maxSpeed,
    deterministic: stateDigest === referenceDigest && normalImpulse === referenceImpulse && maxSpeed === referenceSpeed,
    durationMs,
  };
  return {
    timing,
    result: benchmarkResult("physics sequential-impulse solver contact batch", timing.contactCount, durationMs),
  };
}

interface StabilityRun {
  durationMs: number;
  maxPenetration: number;
  maxSpeed: number;
  digest: number;
}

function makeStabilityWorld(bodyCount: number): PhysicsWorld {
  const world = new PhysicsWorld({ gravity: new Vec3(0, -9.81, 0), fixedDt: FIXED_DT });
  world.addBody(new RigidBody({ type: "static", shape: new PlaneShape(new Vec3(0, 1, 0), 0) }));
  for (let i = 0; i < bodyCount; i++) {
    world.addBody(new RigidBody({
      shape: new BoxShape(0.45, 0.45, 0.45),
      mass: 1,
      friction: 0.8,
      position: {
        x: (i % 8) * 1.1 - 3.85,
        y: 0.7 + (i % 3) * 0.02,
        z: Math.floor(i / 8) * 1.1 - 2.0,
      },
    }));
  }
  return world;
}

function digestWorld(world: PhysicsWorld): number {
  let hash = 2_166_136_261;
  for (const body of world.bodies) {
    hash = mixNumber(hash, body.position.x);
    hash = mixNumber(hash, body.position.y);
    hash = mixNumber(hash, body.position.z);
    hash = mixNumber(hash, body.linearVelocity.x);
    hash = mixNumber(hash, body.linearVelocity.y);
    hash = mixNumber(hash, body.linearVelocity.z);
  }
  return hash >>> 0;
}

function simulateStability(bodyCount: number, steps: number): StabilityRun {
  const world = makeStabilityWorld(bodyCount);
  const start = performance.now();
  for (let i = 0; i < steps; i++) world.stepOnce();
  const durationMs = performance.now() - start;
  let maxPenetration = 0;
  let maxSpeed = 0;
  const plane = world.bodies[0]!;
  for (const body of world.bodies.slice(1)) {
    maxSpeed = Math.max(maxSpeed, Math.hypot(body.linearVelocity.x, body.linearVelocity.y, body.linearVelocity.z));
    const manifold = collideBodies(body, plane);
    if (manifold) {
      for (const contact of manifold.contacts) maxPenetration = Math.max(maxPenetration, contact.penetration);
    }
  }
  return { durationMs, maxPenetration, maxSpeed, digest: digestWorld(world) };
}

function runStabilityBenchmark(bodyCountOption: number, stepsOption: number): { timing: StabilityTiming; result: BenchmarkResult } {
  const bodyCount = Math.max(1, Math.floor(bodyCountOption));
  const steps = Math.max(1, Math.floor(stepsOption));
  const warm = simulateStability(bodyCount, steps);
  const samples = Array.from({ length: DEFAULT_RUNS }, () => simulateStability(bodyCount, steps));
  const latest = samples.at(-1)!;
  const durationMs = median(samples.map((sample) => sample.durationMs));
  const timing: StabilityTiming = {
    bodyCount,
    steps,
    maxPenetration: latest.maxPenetration,
    maxSpeed: latest.maxSpeed,
    stateDigest: latest.digest,
    deterministic: latest.digest === warm.digest && samples.every((sample) => sample.digest === warm.digest),
    durationMs,
  };
  return {
    timing,
    result: benchmarkResult("physics fixed-step resting-contact stability", bodyCount * steps, durationMs),
  };
}

interface QueryWorld {
  world: PhysicsWorld;
  bodyCount: number;
  rays: { x: number; z: number }[];
  samples: { x: number; z: number }[];
}

function makeQueryWorld(bodyCountOption: number, rayCount: number, sampleCount: number): QueryWorld {
  const bodyCount = Math.max(1, Math.floor(bodyCountOption));
  const world = new PhysicsWorld({ gravity: new Vec3(0, -9.81, 0), fixedDt: FIXED_DT });
  const heightfield = new HeightfieldShape({
    sampleHeight: heightAt,
    sampleNormal: heightNormalAt,
    bounds: new AABB(new Vec3(-100, -10, -100), new Vec3(100, 10, 100)),
  });
  world.setHeightfield(heightfield);
  for (let i = 0; i < bodyCount; i++) {
    const x = (i % 16) * 2.4 - 18;
    const z = Math.floor(i / 16) * 2.4 - 18;
    const sphere = i % 2 === 0;
    const radius = sphere ? 0.35 : 0.45;
    world.addBody(new RigidBody({
      type: "static",
      shape: sphere ? new SphereShape(radius) : new BoxShape(radius, radius, radius),
      position: { x, y: heightAt(x, z) + radius, z },
    }));
  }
  const rays = Array.from({ length: rayCount }, (_, i) => ({
    x: ((i * 37) % 120) - 60,
    z: ((i * 53) % 120) - 60,
  }));
  const samples = Array.from({ length: sampleCount }, (_, i) => ({
    x: ((i * 17) % 140) - 70,
    z: ((i * 29) % 140) - 70,
  }));
  return { world, bodyCount, rays, samples };
}

function castRays(query: QueryWorld): { hits: number; distanceSum: number; digest: number } {
  const ray = new Ray({ x: 0, y: 25, z: 0 }, { x: 0, y: -1, z: 0 }, 50);
  const hit = new RayHit();
  let hits = 0;
  let distanceSum = 0;
  let digest = 2_166_136_261;
  for (const sample of query.rays) {
    ray.setFrom({ x: sample.x, y: 25, z: sample.z }, { x: 0, y: -1, z: 0 }, 50);
    hit.reset();
    if (!query.world.raycast(ray, hit)) continue;
    hits++;
    distanceSum += hit.distance;
    digest = mixNumber(digest, hit.distance);
    digest = mixNumber(digest, hit.point.y);
    digest = mixNumber(digest, hit.normal.y);
  }
  return { hits, distanceSum, digest: digest >>> 0 };
}

function queryHeights(query: QueryWorld): { heightSum: number; minHeight: number; maxHeight: number; digest: number } {
  let heightSum = 0;
  let minHeight = Infinity;
  let maxHeight = -Infinity;
  let digest = 2_166_136_261;
  for (const sample of query.samples) {
    const height = query.world.queryHeight(sample.x, sample.z);
    if (height === null) throw new Error("heightfield query benchmark lost its registered heightfield");
    heightSum += height;
    minHeight = Math.min(minHeight, height);
    maxHeight = Math.max(maxHeight, height);
    digest = mixNumber(digest, height);
  }
  return { heightSum, minHeight, maxHeight, digest: digest >>> 0 };
}

function runQueryBenchmark(options: {
  bodyCount: number;
  rayCount: number;
  sampleCount: number;
  runs: number;
}): { raycasts: RaycastTiming; heightfield: HeightfieldQueryTiming; results: BenchmarkResult[] } {
  const query = makeQueryWorld(options.bodyCount, options.rayCount, options.sampleCount);
  let rayResult = castRays(query);
  const rayDurationMs = timed(options.runs, () => {
    rayResult = castRays(query);
  });
  const referenceRay = rayResult;
  rayResult = castRays(query);
  const raycasts: RaycastTiming = {
    bodyCount: query.bodyCount,
    rayCount: query.rays.length,
    hits: rayResult.hits,
    distanceSum: rayResult.distanceSum,
    hitDigest: rayResult.digest,
    deterministic: rayResult.digest === referenceRay.digest && rayResult.hits === referenceRay.hits && rayResult.distanceSum === referenceRay.distanceSum,
    durationMs: rayDurationMs,
  };

  let heightResult = queryHeights(query);
  const heightDurationMs = timed(options.runs, () => {
    heightResult = queryHeights(query);
  });
  const referenceHeight = heightResult;
  heightResult = queryHeights(query);
  const heightfield: HeightfieldQueryTiming = {
    bodyCount: query.bodyCount,
    queryCount: query.samples.length,
    heightSum: heightResult.heightSum,
    minHeight: heightResult.minHeight,
    maxHeight: heightResult.maxHeight,
    deterministic: heightResult.digest === referenceHeight.digest && heightResult.heightSum === referenceHeight.heightSum,
    durationMs: heightDurationMs,
  };
  return {
    raycasts,
    heightfield,
    results: [
      benchmarkResult(`physics spatial raycasts (${query.bodyCount} colliders)`, query.rays.length, rayDurationMs),
      benchmarkResult(`physics heightfield queries (${query.bodyCount} colliders)`, heightfield.queryCount, heightDurationMs),
    ],
  };
}

function makeVehicleFleet(count: number, ground: GroundQuery): Vehicle[] {
  const fleet: Vehicle[] = [];
  for (let i = 0; i < count; i++) {
    const vehicle = new Vehicle(createVehicleConfig({
      mass: 1_150 + (i % 5) * 25,
      mu: 0.95 + (i % 3) * 0.03,
      rollingResistance: 0.012,
      layout: i % 2 === 0 ? "rwd" : "awd",
    }));
    vehicle.position.set((i % 8) * 5.5 - 19.25, 0, Math.floor(i / 8) * 5.5 - 19.25);
    vehicle.placeOnGround(ground);
    vehicle.setVelocity(0, 0, 5 + (i % 4) * 0.5);
    vehicle.input.throttle = 0.62 + (i % 3) * 0.04;
    vehicle.input.brake = i % 11 === 0 ? 0.08 : 0;
    vehicle.input.steer = ((i % 5) - 2) * 0.035;
    vehicle.input.handbrake = i % 17 === 0 ? 0.05 : 0;
    vehicle.input.parkingBrake = 0;
    fleet.push(vehicle);
  }
  return fleet;
}

function vehicleDigest(fleet: readonly Vehicle[]): number {
  let hash = 2_166_136_261;
  for (const vehicle of fleet) {
    hash = mixNumber(hash, vehicle.position.x);
    hash = mixNumber(hash, vehicle.position.y);
    hash = mixNumber(hash, vehicle.position.z);
    hash = mixNumber(hash, vehicle.velocity.x);
    hash = mixNumber(hash, vehicle.velocity.y);
    hash = mixNumber(hash, vehicle.velocity.z);
    hash = mixNumber(hash, vehicle.yaw);
    hash = mixNumber(hash, vehicle.rpm);
    for (const wheel of vehicle.wheels) {
      hash = mixNumber(hash, wheel.omega);
      hash = mixNumber(hash, wheel.compression);
      hash = mixNumber(hash, wheel.kappa);
    }
  }
  return hash >>> 0;
}

interface VehicleRun {
  durationMs: number;
  digest: number;
  finalSpeed: number;
  contactWheels: number;
}

function runVehicleFleet(count: number, steps: number, ground: GroundQuery): VehicleRun {
  const fleet = makeVehicleFleet(count, ground);
  const start = performance.now();
  for (let step = 0; step < steps; step++) {
    for (const vehicle of fleet) vehicle.step(FIXED_DT, ground);
  }
  const durationMs = performance.now() - start;
  let contactWheels = 0;
  for (const vehicle of fleet) {
    for (const wheel of vehicle.wheels) if (wheel.inContact) contactWheels++;
  }
  return {
    durationMs,
    digest: vehicleDigest(fleet),
    finalSpeed: fleet.reduce((sum, vehicle) => sum + vehicle.speed, 0) / Math.max(1, fleet.length),
    contactWheels,
  };
}

function runVehicleBenchmark(counts: readonly number[], stepsOption: number, runs: number): { timings: VehicleTiming[]; results: BenchmarkResult[] } {
  const steps = Math.max(1, Math.floor(stepsOption));
  const ground = slopeGround(0.035, "z");
  const timings: VehicleTiming[] = [];
  for (const requested of counts) {
    const vehicleCount = Math.max(1, Math.floor(requested));
    const warm = runVehicleFleet(vehicleCount, steps, ground);
    const samples = Array.from({ length: Math.max(1, runs) }, () => runVehicleFleet(vehicleCount, steps, ground));
    const latest = samples.at(-1)!;
    const reference = runVehicleFleet(vehicleCount, steps, ground);
    const durationMs = median(samples.map((sample) => sample.durationMs));
    timings.push({
      vehicleCount,
      steps,
      stateDigest: latest.digest,
      finalSpeed: latest.finalSpeed,
      contactWheels: latest.contactWheels,
      deterministic: latest.digest === warm.digest && latest.digest === reference.digest && samples.every((sample) => sample.digest === warm.digest),
      durationMs,
    });
  }
  return {
    timings,
    results: timings.map((timing) => benchmarkResult(
      `physics vehicle simulation ${timing.vehicleCount} vehicles × ${timing.steps} steps`,
      timing.vehicleCount * timing.steps,
      timing.durationMs,
    )),
  };
}

/** Run the renderer-independent Phase 22.4 physics matrix. */
export function runPhysicsBenchmark(options: PhysicsBenchmarkOptions = {}): PhysicsBenchmarkReport {
  const runs = Math.max(1, Math.floor(options.runs ?? DEFAULT_RUNS));
  const broadphase = runBroadphaseBenchmark(options.broadphaseCounts ?? DEFAULT_BROADPHASE_COUNTS, runs);
  const narrowphase = runNarrowphaseBenchmark(options.narrowphasePairs ?? DEFAULT_NARROWPHASE_PAIRS, runs);
  const solver = runSolverBenchmark(options.solverBodies ?? DEFAULT_SOLVER_BODIES, runs);
  const stability = runStabilityBenchmark(options.stabilityBodies ?? DEFAULT_STABILITY_BODIES, options.stabilitySteps ?? DEFAULT_STABILITY_STEPS);
  const queries = runQueryBenchmark({
    bodyCount: options.queryBodies ?? DEFAULT_QUERY_BODIES,
    rayCount: options.queryRays ?? DEFAULT_QUERY_RAYS,
    sampleCount: options.heightfieldQueries ?? DEFAULT_HEIGHTFIELD_QUERIES,
    runs,
  });
  const vehicles = runVehicleBenchmark(options.vehicleCounts ?? DEFAULT_VEHICLE_COUNTS, options.vehicleSteps ?? DEFAULT_VEHICLE_STEPS, runs);
  return {
    results: [...broadphase.results, ...narrowphase.results, solver.result, stability.result, ...queries.results, ...vehicles.results],
    broadphase,
    narrowphase,
    solver: solver.timing,
    stability: stability.timing,
    queries,
    vehicles,
    notes: [],
  };
}

/** Correctness, work-shape and catastrophe guards for Phase 22.4. */
export function assertPhysicsBenchmark(report: PhysicsBenchmarkReport): string[] {
  const notes: string[] = [];
  if (report.broadphase.timings.length === 0) throw new Error("physics benchmark produced no broadphase rows");
  for (const timing of report.broadphase.timings) {
    const expectedPossible = (timing.bodyCount * (timing.bodyCount - 1)) / 2;
    if (timing.possiblePairs !== expectedPossible) throw new Error(`broadphase ${timing.bodyCount} has incorrect possible-pair count`);
    if (timing.axisCandidates < timing.overlapPairs || timing.overlapPairs < 1) throw new Error(`broadphase ${timing.bodyCount} did not generate/prune overlap pairs`);
    if (timing.axisCandidates >= timing.possiblePairs) throw new Error(`broadphase ${timing.bodyCount} did not prune any candidate pairs`);
    if (!timing.deterministic) throw new Error(`broadphase ${timing.bodyCount} pair order is not deterministic`);
    finite(timing.durationMs, `broadphase ${timing.bodyCount} duration`);
  }
  const largestBroadphase = report.broadphase.timings.at(-1)!;
  notes.push(`broadphase: ${report.broadphase.timings.length} body counts, largest ${largestBroadphase.bodyCount} generated ${largestBroadphase.overlapPairs} pairs from ${largestBroadphase.axisCandidates} axis candidates (${largestBroadphase.possiblePairs} possible)`);

  if (report.narrowphase.timings.length !== NARROWPHASE_KINDS.length) throw new Error(`narrowphase covered ${report.narrowphase.timings.length}/${NARROWPHASE_KINDS.length} supported pair kinds`);
  for (const timing of report.narrowphase.timings) {
    if (timing.collisions !== timing.pairCount || timing.contacts < timing.collisions) throw new Error(`narrowphase ${timing.pairKind} missed contacts (${timing.collisions}/${timing.pairCount})`);
    if (!timing.deterministic) throw new Error(`narrowphase ${timing.pairKind} manifold generation is not deterministic`);
    finite(timing.durationMs, `narrowphase ${timing.pairKind} duration`);
  }
  notes.push(`narrowphase: ${report.narrowphase.timings.length} supported shape pairs, ${report.narrowphase.timings.reduce((sum, timing) => sum + timing.contacts, 0).toLocaleString()} contacts generated deterministically`);

  if (report.solver.manifoldCount !== report.solver.bodyCount || report.solver.contactCount < report.solver.manifoldCount || !(report.solver.normalImpulse > 0)) throw new Error("sequential-impulse solver did not resolve its contact batch");
  if (!(report.solver.maxSpeed >= 0) || !report.solver.deterministic) throw new Error("sequential-impulse solver produced unstable or non-deterministic state");
  finite(report.solver.durationMs, "solver duration");
  notes.push(`solver: ${report.solver.bodyCount} bodies / ${report.solver.contactCount} contacts, total normal impulse ${report.solver.normalImpulse.toFixed(3)} in ${report.solver.durationMs.toFixed(2)} ms`);

  if (!(report.stability.maxPenetration >= 0) || report.stability.maxPenetration > 0.25 || report.stability.maxSpeed > 20 || !report.stability.deterministic) {
    throw new Error(`resting-contact stability exceeded bounds (penetration ${report.stability.maxPenetration}, speed ${report.stability.maxSpeed})`);
  }
  finite(report.stability.durationMs, "stability duration");
  notes.push(`stability: ${report.stability.bodyCount} bodies × ${report.stability.steps} fixed steps, max penetration ${report.stability.maxPenetration.toFixed(4)} m, max speed ${report.stability.maxSpeed.toFixed(3)} m/s`);

  const raycasts = report.queries.raycasts;
  if (raycasts.hits !== raycasts.rayCount || !(raycasts.distanceSum > 0) || !raycasts.deterministic) throw new Error(`physics raycasts missed deterministic terrain/collider hits (${raycasts.hits}/${raycasts.rayCount})`);
  finite(raycasts.durationMs, "raycast duration");
  const heightfield = report.queries.heightfield;
  if (!(heightfield.queryCount > 0) || !(heightfield.maxHeight > heightfield.minHeight) || !heightfield.deterministic) throw new Error("heightfield query matrix produced no finite terrain range or changed between runs");
  finite(heightfield.durationMs, "heightfield query duration");
  notes.push(`queries: ${raycasts.hits} raycasts hit in ${raycasts.durationMs.toFixed(2)} ms; ${heightfield.queryCount} heightfield samples ranged ${heightfield.minHeight.toFixed(3)}..${heightfield.maxHeight.toFixed(3)} in ${heightfield.durationMs.toFixed(2)} ms`);

  for (const timing of report.vehicles.timings) {
    if (timing.contactWheels !== timing.vehicleCount * 4 || !(timing.finalSpeed > 0) || !timing.deterministic) throw new Error(`vehicle fleet ${timing.vehicleCount} did not maintain deterministic four-wheel contact`);
    finite(timing.durationMs, `vehicle ${timing.vehicleCount} duration`);
  }
  const largestFleet = report.vehicles.timings.at(-1)!;
  notes.push(`vehicles: ${report.vehicles.timings.length} fleet sizes, largest ${largestFleet.vehicleCount} vehicles × ${largestFleet.steps} steps in ${largestFleet.durationMs.toFixed(2)} ms, ${largestFleet.contactWheels} wheel contacts`);

  const totalMs = report.results.reduce((sum, entry) => sum + entry.durationMs, 0);
  if (totalMs >= 30_000) throw new Error(`physics benchmark matrix exceeded catastrophe bound (${totalMs.toFixed(1)} ms)`);
  return notes;
}
