/**
 * Phase 22.6 world-scale object benchmark matrix.
 *
 * This is the CPU/ECS world counterpart to the particle capacity matrix. It deliberately uses the
 * public EntityWorld path with one Transform and one Renderable per object, then exercises the same
 * world-scale work a frame needs today: allocation/attachment, flat transform composition and a
 * frustum visibility query. The four roadmap bands are measured independently so a 1M-object run
 * does not turn into one monolithic special case.
 *
 * This matrix does not claim GPU-driven world-scale rendering. GPU instance generation and complete
 * visibility compaction remain Phase 24 work; the mock/device browser gates are the evidence for
 * device-side timing.
 */

import {
  AABB,
  Camera,
  EntityWorld,
  Frustum,
  Mat4,
  Renderable,
  Transform,
  Vec3,
} from "@forge/engine";
import type { BenchmarkResult } from "./ecs.bench.ts";

export interface WorldBenchmarkOptions {
  /** Object-capacity bands required by Phase 22.6 by default. */
  capacities?: readonly number[];
  /** Repeat each capacity scenario; one sample keeps the 1M run practical in CI. */
  runs?: number;
}

export interface WorldObjectTiming {
  capacity: number;
  gridSide: number;
  objectCount: number;
  renderableCount: number;
  componentCount: number;
  transformSlots: number;
  changedSlots: number;
  queryCount: number;
  visible: number;
  culled: number;
  transformStorageBytes: number;
  stateDigest: number;
  setupMs: number;
  transformMs: number;
  cullMs: number;
  disposed: boolean;
  disposedLiveEntities: number;
  disposedComponents: number;
  deterministic: boolean;
}

export interface WorldBenchmarkReport {
  results: BenchmarkResult[];
  timings: WorldObjectTiming[];
  notes: string[];
}

export const DEFAULT_WORLD_CAPACITIES = [10_000, 100_000, 500_000, 1_000_000] as const;
const DEFAULT_RUNS = 1;
const OBJECT_BOUNDS = new AABB(new Vec3(-0.5, -0.5, -0.5), new Vec3(0.5, 0.5, 0.5));
const HASH_OFFSET = 2_166_136_261;
const HASH_PRIME = 16_777_619;

function median(samples: readonly number[]): number {
  const ordered = [...samples].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)] ?? 0;
}

function finite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`world benchmark produced a non-finite ${label}`);
}

function benchmarkResult(name: string, count: number, durationMs: number): BenchmarkResult {
  return {
    name,
    count,
    durationMs,
    opsPerSec: (count * 1000) / Math.max(durationMs, 1e-9),
  };
}

function transformStorageBytes(world: EntityWorld): number {
  const store = world.transforms;
  return store.local.byteLength +
    store.world.byteLength +
    store.parent.byteLength +
    store.localVersion.byteLength +
    store.worldVersion.byteLength +
    store.worldParentVersion.byteLength +
    store.depth.byteLength +
    store.owner.byteLength;
}

function hashStep(hash: number, value: number): number {
  return Math.imul(hash ^ (value >>> 0), HASH_PRIME) >>> 0;
}

interface WorldRun {
  gridSide: number;
  objectCount: number;
  renderableCount: number;
  componentCount: number;
  transformSlots: number;
  changedSlots: number;
  queryCount: number;
  visible: number;
  culled: number;
  transformStorageBytes: number;
  stateDigest: number;
  setupMs: number;
  transformMs: number;
  cullMs: number;
  disposed: boolean;
  disposedLiveEntities: number;
  disposedComponents: number;
}

function createWorldObjects(world: EntityWorld, count: number, side: number): number {
  const start = performance.now();
  for (let i = 0; i < count; i++) {
    const entity = world.createEntity();
    const transform = entity.add(new Transform());
    const x = i % side;
    const y = Math.floor(i / side) % side;
    const z = Math.floor(i / (side * side));
    transform.setPosition(x * 2, y * 2, z * 2);
    const renderable = entity.add(new Renderable());
    // All objects share one asset-sized bound, as instanced world objects do in the renderer.
    renderable.boundsOverride = OBJECT_BOUNDS;
  }
  return performance.now() - start;
}

function runWorldOnce(capacity: number): WorldRun {
  const side = Math.max(1, Math.ceil(Math.cbrt(capacity)));
  const world = new EntityWorld({ initialCapacity: capacity + 1, maxEntities: capacity });
  const setupMs = createWorldObjects(world, capacity, side);
  const stats = world.stats();
  const transformStorage = transformStorageBytes(world);

  const changedSlots: number[] = [];
  const transformStart = performance.now();
  const changedCount = world.updateTransforms(changedSlots, true);
  const transformMs = performance.now() - transformStart;

  const span = Math.max(2, (side - 1) * 2);
  const center = span * 0.5;
  const cameraPosition = new Vec3(center, center, -20);
  const cameraTarget = new Vec3(center, center, center);
  const far = Math.max(40, span * 0.75);
  const camera = new Camera();
  camera.fovY = Math.PI / 3;
  camera.near = 0.1;
  camera.far = far;
  const view = new Mat4().setLookAt(cameraPosition, cameraTarget, new Vec3(0, 1, 0));
  const projection = new Mat4().setPerspective(camera.fovY, 16 / 9, camera.near, camera.far);
  camera.writeMatrices(view, projection, cameraPosition);
  const frustum = new Frustum().setFromViewProjection(camera.viewProjection);

  const cullStart = performance.now();
  const query = world.query([Renderable]);
  query.refresh();
  const localBounds = new AABB();
  const worldBounds = new AABB();
  const worldMatrix = new Mat4();
  let visible = 0;
  let digest = HASH_OFFSET;
  for (let i = 0; i < query.count; i++) {
    const id = query.entity(i);
    const renderable = query.value(0, i) as Renderable;
    renderable.resolveBounds(localBounds);
    world.getWorldMatrix(id, worldMatrix);
    localBounds.transformByMatrix(worldMatrix, worldBounds);
    const isVisible = frustum.intersectsAABB(worldBounds);
    renderable.isVisible = isVisible;
    if (isVisible) visible++;
    digest = hashStep(digest, id);
    digest = hashStep(digest, isVisible ? 1 : 0);
  }
  const cullMs = performance.now() - cullStart;

  // Include the transform-system work order in the digest without allocating a second 1M-entry
  // typed view. This catches a changed slot order as well as a changed visibility verdict.
  for (const slot of changedSlots) digest = hashStep(digest, slot);
  const culled = query.count - visible;
  const run: WorldRun = {
    gridSide: side,
    objectCount: world.liveEntityCount,
    renderableCount: stats.byComponent.find((entry) => entry.name === "Renderable")?.count ?? 0,
    componentCount: world.componentCountValue,
    transformSlots: world.transforms.count,
    changedSlots: changedCount,
    queryCount: query.count,
    visible,
    culled,
    transformStorageBytes: transformStorage,
    stateDigest: digest >>> 0,
    setupMs,
    transformMs,
    cullMs,
    disposed: false,
    disposedLiveEntities: 0,
    disposedComponents: 0,
  };

  world.dispose();
  run.disposed = world.isDisposed;
  run.disposedLiveEntities = world.liveEntityCount;
  run.disposedComponents = world.componentCountValue;
  return run;
}

function runWorldCapacity(capacity: number, runs: number): WorldObjectTiming {
  const samples = Array.from({ length: runs }, () => runWorldOnce(capacity));
  const reference = samples[0]!;
  const latest = samples.at(-1)!;
  const deterministic = samples.every((sample) => (
    sample.stateDigest === reference.stateDigest &&
    sample.objectCount === reference.objectCount &&
    sample.visible === reference.visible &&
    sample.culled === reference.culled &&
    sample.transformStorageBytes === reference.transformStorageBytes
  ));
  return {
    capacity,
    ...latest,
    setupMs: median(samples.map((sample) => sample.setupMs)),
    transformMs: median(samples.map((sample) => sample.transformMs)),
    cullMs: median(samples.map((sample) => sample.cullMs)),
    deterministic,
  };
}

/** Run the Phase 22.6 CPU/ECS world-scale object matrix. */
export function runWorldBenchmark(options: WorldBenchmarkOptions = {}): WorldBenchmarkReport {
  const capacities = options.capacities ?? DEFAULT_WORLD_CAPACITIES;
  const runs = Math.max(1, Math.floor(options.runs ?? DEFAULT_RUNS));
  const timings = capacities.map((requested) => runWorldCapacity(Math.max(1, Math.floor(requested)), runs));
  return {
    results: timings.flatMap((timing) => [
      benchmarkResult(`world objects setup ${timing.capacity.toLocaleString()}`, timing.capacity, timing.setupMs),
      benchmarkResult(`world objects transform ${timing.capacity.toLocaleString()}`, timing.capacity, timing.transformMs),
      benchmarkResult(`world objects cull ${timing.capacity.toLocaleString()}`, timing.queryCount, timing.cullMs),
    ]),
    timings,
    notes: [],
  };
}

/** Correctness, work-shape, teardown and catastrophe guards for Phase 22.6. */
export function assertWorldBenchmark(
  report: WorldBenchmarkReport,
  requiredCapacities: readonly number[] = DEFAULT_WORLD_CAPACITIES,
): string[] {
  const required = requiredCapacities.map((capacity) => Math.max(1, Math.floor(capacity)));
  if (required.length === 0) throw new Error("world benchmark requires at least one capacity band");
  const byCapacity = new Map(report.timings.map((timing) => [timing.capacity, timing]));
  for (const capacity of required) {
    const timing = byCapacity.get(capacity);
    if (!timing) throw new Error(`world matrix is missing the ${capacity.toLocaleString()} object band`);
    if (timing.objectCount !== capacity || timing.renderableCount !== capacity || timing.queryCount !== capacity) {
      throw new Error(`world ${capacity.toLocaleString()} band has an incorrect object/component/query shape`);
    }
    if (timing.componentCount !== capacity * 2 || timing.transformSlots !== capacity || timing.changedSlots !== capacity) {
      throw new Error(`world ${capacity.toLocaleString()} band did not attach and update one Transform and Renderable per object`);
    }
    if (timing.visible <= 0 || timing.culled <= 0 || timing.visible + timing.culled !== capacity) {
      throw new Error(`world ${capacity.toLocaleString()} visibility query was trivial or incomplete (${timing.visible} visible, ${timing.culled} culled)`);
    }
    if (!(timing.transformStorageBytes >= capacity * 136) || !timing.deterministic) {
      throw new Error(`world ${capacity.toLocaleString()} transform storage or determinism guard failed`);
    }
    if (!timing.disposed || timing.disposedLiveEntities !== 0 || timing.disposedComponents !== 0) {
      throw new Error(`world ${capacity.toLocaleString()} did not release all ECS objects during teardown`);
    }
    if (!(timing.setupMs > 0) || !(timing.transformMs > 0) || !(timing.cullMs > 0)) {
      throw new Error(`world ${capacity.toLocaleString()} did not produce setup/transform/cull timings`);
    }
    finite(timing.setupMs, `world ${capacity} setup duration`);
    finite(timing.transformMs, `world ${capacity} transform duration`);
    finite(timing.cullMs, `world ${capacity} cull duration`);
  }

  const largestCapacity = Math.max(...required);
  const largest = byCapacity.get(largestCapacity)!;
  const previousCapacity = required.filter((capacity) => capacity < largestCapacity).at(-1);
  const previous = previousCapacity === undefined ? undefined : byCapacity.get(previousCapacity);
  if (previous) {
    const setupGrowth = (largest.setupMs / largest.capacity) / (previous.setupMs / previous.capacity);
    const cullGrowth = (largest.cullMs / largest.capacity) / (previous.cullMs / previous.capacity);
    if (!(setupGrowth < 8) || !(cullGrowth < 8)) {
      throw new Error(`world per-object cost grew too quickly (${setupGrowth.toFixed(2)}x setup, ${cullGrowth.toFixed(2)}x cull)`);
    }
  }

  const totalMs = report.results.reduce((sum, entry) => sum + entry.durationMs, 0);
  if (totalMs >= 60_000) throw new Error(`world benchmark matrix exceeded catastrophe bound (${totalMs.toFixed(1)} ms)`);
  return [
    `objects: ${report.timings.length} capacity bands through ${largestCapacity.toLocaleString()}, largest setup ${largest.setupMs.toFixed(2)} ms`,
    `transforms/cull: ${largest.transformMs.toFixed(2)} ms / ${largest.cullMs.toFixed(2)} ms, ${largest.visible.toLocaleString()} visible and ${largest.culled.toLocaleString()} culled`,
    `teardown: ${largest.transformStorageBytes.toLocaleString()} typed-storage bytes measured before disposal, zero live ECS objects after every band`,
  ];
}
