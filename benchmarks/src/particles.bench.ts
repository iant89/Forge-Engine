/**
 * Phase 22.5 particle benchmark matrix.
 *
 * Particle capacity is a buffer concern, not an ECS-entity concern. The matrix therefore measures
 * both sides of the existing implementation at the four roadmap bands:
 *
 * - CPU reference setup and fixed-step integration at 10K, 100K, 500K and 1M particles;
 * - mock-GPU storage allocation and per-frame uniform preparation at the same capacities; and
 * - deterministic state/shape checks, zero ECS entities, and complete mock-buffer teardown.
 *
 * The mock GPU does not execute WGSL. Its rows are command/allocation/API measurements, not claims
 * about device shader throughput; real-device timing remains the browser/device gate.
 */

import {
  FLAG_ALIVE,
  GraphicsDevice,
  GpuParticleSystem,
  P_FLAGS,
  P_LIFE,
  P_MAX_LIFE,
  P_VY,
  P_Y,
  PARTICLE_FLOATS,
  ParticleSimulation,
  analyticGravity,
} from "@forge/engine";
import type { BenchmarkResult } from "./ecs.bench.ts";

export interface ParticleBenchmarkOptions {
  /** Capacity bands required by Phase 22.5 by default. */
  capacities?: readonly number[];
  /** Fixed CPU integration steps per band. */
  cpuSteps?: number;
  /** Mock-GPU prepare calls per capacity. */
  gpuFrames?: number;
  /** Repeat each stress scenario; one sample is the default to keep 1M practical in CI. */
  runs?: number;
}

export interface CpuParticleTiming {
  capacity: number;
  steps: number;
  bytes: number;
  setupMs: number;
  integrateMs: number;
  alive: number;
  analyticError: number;
  stateDigest: number;
  deterministic: boolean;
}

export interface GpuParticleTiming {
  capacity: number;
  frames: number;
  storageBytes: number;
  peakBytes: number;
  cleanupBytes: number;
  initMs: number;
  prepareMs: number;
  emitted: number;
  emitBudget: number;
  entityCount: number;
  simulationSteps: number;
  ready: boolean;
  errors: number;
  deterministic: boolean;
}

export interface ParticleBenchmarkReport {
  results: BenchmarkResult[];
  cpu: { timings: CpuParticleTiming[] };
  gpu: {
    timings: GpuParticleTiming[];
    baseBytes: number;
    remainingBytes: number;
    errors: number;
  };
  notes: string[];
}

export const DEFAULT_PARTICLE_CAPACITIES = [10_000, 100_000, 500_000, 1_000_000] as const;
const DEFAULT_CPU_STEPS = 30;
const DEFAULT_GPU_FRAMES = 3;
const DEFAULT_RUNS = 1;
const FIXED_DT = 1 / 60;

const VIEW_PROJ = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

function median(samples: readonly number[]): number {
  const ordered = [...samples].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)] ?? 0;
}

function finite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`particle benchmark produced a non-finite ${label}`);
}

function result(name: string, count: number, durationMs: number): BenchmarkResult {
  return {
    name,
    count,
    durationMs,
    opsPerSec: (count * 1000) / Math.max(durationMs, 1e-9),
  };
}

function stateDigest(state: Float32Array): number {
  const words = new Uint32Array(state.buffer, state.byteOffset, state.byteLength / 4);
  let hash = 2_166_136_261;
  for (let i = 0; i < state.length; i++) {
    if (!Number.isFinite(state[i]!)) throw new Error(`particle state contains a non-finite value at ${i}`);
    hash = Math.imul(hash ^ words[i]!, 16_777_619) >>> 0;
  }
  return hash >>> 0;
}

function seedCpuState(sim: ParticleSimulation, steps: number): number {
  const count = sim.capacity;
  const lifetime = steps * FIXED_DT + 1;
  const setupStart = performance.now();
  for (let i = 0; i < count; i++) {
    const offset = i * PARTICLE_FLOATS;
    sim.state[offset + P_LIFE] = lifetime;
    sim.state[offset + P_MAX_LIFE] = lifetime;
    sim.state[offset + P_FLAGS] = FLAG_ALIVE;
    sim.state[offset + P_VY] = (i % 17) * 0.01;
  }
  return performance.now() - setupStart;
}

interface CpuRun {
  setupMs: number;
  integrateMs: number;
  alive: number;
  analyticError: number;
  stateDigest: number;
}

function runCpuOnce(capacity: number, steps: number): CpuRun {
  const sim = new ParticleSimulation({
    capacity,
    gravity: { x: 0, y: -9.81, z: 0 },
    drag: 0,
  });
  const setupMs = seedCpuState(sim, steps);
  const integrateStart = performance.now();
  for (let step = 0; step < steps; step++) sim.integrateAll(FIXED_DT);
  const integrateMs = performance.now() - integrateStart;
  const analytic = analyticGravity(0, -9.81, steps, FIXED_DT);
  const analyticError = Math.max(
    Math.abs(sim.state[P_Y]! - analytic.y),
    Math.abs(sim.state[P_VY]! - analytic.vy),
  );
  return {
    setupMs,
    integrateMs,
    alive: sim.alive,
    analyticError,
    stateDigest: stateDigest(sim.state),
  };
}

function runCpuBenchmark(capacities: readonly number[], stepsOption: number, runsOption: number): {
  timings: CpuParticleTiming[];
  results: BenchmarkResult[];
} {
  const steps = Math.max(1, Math.floor(stepsOption));
  const runs = Math.max(1, Math.floor(runsOption));
  const timings: CpuParticleTiming[] = [];
  for (const requested of capacities) {
    const capacity = Math.max(1, Math.floor(requested));
    const samples = Array.from({ length: runs }, () => runCpuOnce(capacity, steps));
    const reference = samples[0]!;
    const latest = samples.at(-1)!;
    const deterministic = samples.every((sample) => (
      sample.stateDigest === reference.stateDigest &&
      sample.alive === reference.alive &&
      sample.analyticError === reference.analyticError
    ));
    timings.push({
      capacity,
      steps,
      bytes: capacity * PARTICLE_FLOATS * 4,
      setupMs: median(samples.map((sample) => sample.setupMs)),
      integrateMs: median(samples.map((sample) => sample.integrateMs)),
      alive: latest.alive,
      analyticError: latest.analyticError,
      stateDigest: latest.stateDigest,
      deterministic,
    });
  }
  return {
    timings,
    results: timings.flatMap((timing) => [
      result(`particles CPU setup ${timing.capacity.toLocaleString()}`, timing.capacity, timing.setupMs),
      result(`particles CPU integrate ${timing.capacity.toLocaleString()} × ${timing.steps}`, timing.capacity * timing.steps, timing.integrateMs),
    ]),
  };
}

interface GpuRun {
  initMs: number;
  prepareMs: number;
  peakBytes: number;
  cleanupBytes: number;
  storageBytes: number;
  emitted: number;
  emitBudget: number;
  entityCount: number;
  simulationSteps: number;
  ready: boolean;
  errors: number;
}

async function runGpuOnce(device: GraphicsDevice, capacity: number, frames: number): Promise<GpuRun> {
  const system = new GpuParticleSystem(device, {
    capacity,
    seed: capacity,
    maxEmitsPerFrame: 4_096,
  });
  const initStart = performance.now();
  await system.init();
  const initMs = performance.now() - initStart;
  const peakBytes = device.memoryStats().bytes;

  const prepareStart = performance.now();
  for (let frame = 0; frame < frames; frame++) {
    system.prepare({
      dt: FIXED_DT,
      simulationSteps: 1,
      viewProj: VIEW_PROJ,
      cameraPos: { x: 0, y: 1, z: 5 },
      cameraRight: { x: 1, y: 0, z: 0 },
      cameraUp: { x: 0, y: 1, z: 0 },
    });
  }
  const prepareMs = performance.now() - prepareStart;
  const stats = system.stats();
  if (typeof stats.capacity !== "number" || stats.capacity !== capacity) {
    throw new Error(`GPU particle stats reported ${String(stats.capacity)}, expected ${capacity}`);
  }
  if (typeof stats.steps !== "number" || typeof stats.ready !== "boolean") {
    throw new Error("GPU particle stats did not report numeric steps and boolean readiness");
  }
  const run: GpuRun = {
    initMs,
    prepareMs,
    peakBytes,
    cleanupBytes: peakBytes,
    storageBytes: system.storageBytes(),
    emitted: system.emitted,
    emitBudget: system.lastEmitBudget,
    entityCount: system.entityCount(),
    simulationSteps: stats.steps,
    ready: stats.ready,
    errors: device.mock.errors.length,
  };
  system.dispose();
  run.cleanupBytes = device.memoryStats().bytes;
  return run;
}

async function runGpuBenchmark(capacities: readonly number[], framesOption: number, runsOption: number): Promise<{
  timings: GpuParticleTiming[];
  baseBytes: number;
  remainingBytes: number;
  errors: number;
  results: BenchmarkResult[];
}> {
  const frames = Math.max(1, Math.floor(framesOption));
  const runs = Math.max(1, Math.floor(runsOption));
  const device = await GraphicsDevice.create({ forceMock: true, allowMockFallback: true });
  const baseBytes = device.memoryStats().bytes;
  const timings: GpuParticleTiming[] = [];
  try {
    for (const requested of capacities) {
      const capacity = Math.max(1, Math.floor(requested));
      const samples: GpuRun[] = [];
      for (let runIndex = 0; runIndex < runs; runIndex++) samples.push(await runGpuOnce(device, capacity, frames));
      const reference = samples[0]!;
      const latest = samples.at(-1)!;
      const deterministic = samples.every((sample) => (
        sample.storageBytes === reference.storageBytes &&
        sample.emitted === reference.emitted &&
        sample.emitBudget === reference.emitBudget &&
        sample.simulationSteps === reference.simulationSteps &&
        sample.ready === reference.ready &&
        sample.errors === reference.errors
      ));
      timings.push({
        capacity,
        frames,
        storageBytes: latest.storageBytes,
        peakBytes: Math.max(...samples.map((sample) => sample.peakBytes)),
        cleanupBytes: latest.cleanupBytes,
        initMs: median(samples.map((sample) => sample.initMs)),
        prepareMs: median(samples.map((sample) => sample.prepareMs)),
        emitted: latest.emitted,
        emitBudget: latest.emitBudget,
        entityCount: latest.entityCount,
        simulationSteps: latest.simulationSteps,
        ready: latest.ready,
        errors: latest.errors,
        deterministic,
      });
    }
    const remainingBytes = device.memoryStats().bytes;
    return {
      timings,
      baseBytes,
      remainingBytes,
      errors: device.mock.errors.length,
      results: timings.flatMap((timing) => [
        result(`particles mock GPU allocate ${timing.capacity.toLocaleString()}`, timing.capacity, timing.initMs),
        result(`particles mock GPU prepare ${timing.capacity.toLocaleString()} × ${timing.frames}`, timing.frames, timing.prepareMs),
      ]),
    };
  } finally {
    await device.dispose();
  }
}

/** Run the Phase 22.5 CPU and mock-GPU particle capacity matrix. */
export async function runParticleBenchmark(options: ParticleBenchmarkOptions = {}): Promise<ParticleBenchmarkReport> {
  const capacities = options.capacities ?? DEFAULT_PARTICLE_CAPACITIES;
  const runs = Math.max(1, Math.floor(options.runs ?? DEFAULT_RUNS));
  const cpu = runCpuBenchmark(capacities, options.cpuSteps ?? DEFAULT_CPU_STEPS, runs);
  const gpu = await runGpuBenchmark(capacities, options.gpuFrames ?? DEFAULT_GPU_FRAMES, runs);
  return {
    results: [...cpu.results, ...gpu.results],
    cpu,
    gpu,
    notes: [],
  };
}

/** Correctness, work-shape, accounting and catastrophe guards for Phase 22.5. */
export function assertParticleBenchmark(
  report: ParticleBenchmarkReport,
  requiredCapacities: readonly number[] = DEFAULT_PARTICLE_CAPACITIES,
): string[] {
  const notes: string[] = [];
  const required = requiredCapacities.map((capacity) => Math.max(1, Math.floor(capacity)));
  const cpuByCapacity = new Map(report.cpu.timings.map((timing) => [timing.capacity, timing]));
  const gpuByCapacity = new Map(report.gpu.timings.map((timing) => [timing.capacity, timing]));
  for (const capacity of required) {
    const cpu = cpuByCapacity.get(capacity);
    const gpu = gpuByCapacity.get(capacity);
    if (!cpu || !gpu) throw new Error(`particle matrix is missing the ${capacity.toLocaleString()} capacity band`);
    if (cpu.alive !== capacity || !(cpu.bytes === capacity * PARTICLE_FLOATS * 4)) throw new Error(`CPU particle ${capacity} band has incorrect live/byte shape`);
    if (!(cpu.analyticError < 1e-3) || !cpu.deterministic) throw new Error(`CPU particle ${capacity} band diverged or is not deterministic`);
    if (!(cpu.setupMs >= 0) || !(cpu.integrateMs > 0)) throw new Error(`CPU particle ${capacity} band did not measure setup/integration`);
    if (gpu.capacity !== capacity || gpu.storageBytes !== capacity * PARTICLE_FLOATS * 4) throw new Error(`GPU particle ${capacity} band has incorrect storage shape`);
    if (gpu.entityCount !== 0 || gpu.simulationSteps !== 0 || !gpu.ready || !(gpu.emitted > 0) || !(gpu.emitBudget > 0) || !gpu.deterministic) throw new Error(`GPU particle ${capacity} band did not exercise deterministic preparation without entities`);
    if (gpu.errors !== 0 || gpu.cleanupBytes !== report.gpu.baseBytes) throw new Error(`GPU particle ${capacity} band left mock errors or live buffers`);
    finite(cpu.integrateMs, `CPU ${capacity} integration duration`);
    finite(gpu.initMs, `GPU ${capacity} initialization duration`);
    finite(gpu.prepareMs, `GPU ${capacity} prepare duration`);
  }
  if (report.gpu.remainingBytes !== report.gpu.baseBytes || report.gpu.errors !== 0) throw new Error("particle GPU matrix did not return the mock device to its baseline");
  const largest = required.at(-1)!;
  const largestCpu = cpuByCapacity.get(largest)!;
  if (largestCpu.integrateMs >= 10_000) throw new Error(`the ${largest.toLocaleString()} CPU particle pass took ${largestCpu.integrateMs.toFixed(1)} ms`);
  const totalMs = report.results.reduce((sum, entry) => sum + entry.durationMs, 0);
  if (totalMs >= 30_000) throw new Error(`particle benchmark matrix exceeded catastrophe bound (${totalMs.toFixed(1)} ms)`);
  notes.push(`CPU: ${report.cpu.timings.length} capacity bands through ${largest.toLocaleString()}, largest integration ${largestCpu.integrateMs.toFixed(2)} ms with analytic error ${largestCpu.analyticError.toExponential(2)}`);
  notes.push(`mock GPU: ${report.gpu.timings.length} capacity bands through ${largest.toLocaleString()}, largest allocation ${report.gpu.timings.at(-1)!.peakBytes} bytes, zero ECS entities and zero live buffers after teardown`);
  return notes;
}
