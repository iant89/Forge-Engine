/**
 * 100k-particle CPU integrator benchmark.
 *
 * Same workload as the unit gate: drag 0, every slot alive, 30 steps of semi-implicit Euler.
 * The GPU shader is the same curve; this measures the CPU fallback the demo and the tests share.
 */

import { FLAG_ALIVE, P_FLAGS, P_LIFE, P_MAX_LIFE, P_VY, P_Y, PARTICLE_FLOATS, ParticleSimulation, analyticGravity } from "@forge/engine";
import type { BenchmarkResult } from "./ecs.bench.ts";

export interface ParticleBenchmarkReport {
  results: BenchmarkResult[];
  /** |simulated y − analytic y| for the particle that started at rest. */
  analyticError: number;
  alive: number;
}

export function runParticleBenchmark(count = 100_000, steps = 30): ParticleBenchmarkReport {
  const sim = new ParticleSimulation({ capacity: count, gravity: { x: 0, y: -9.81, z: 0 }, drag: 0 });
  const t0 = performance.now();
  for (let i = 0; i < count; i++) {
    const o = i * PARTICLE_FLOATS;
    sim.state[o + P_LIFE] = 8;
    sim.state[o + P_MAX_LIFE] = 8;
    sim.state[o + P_FLAGS] = FLAG_ALIVE;
    sim.state[o + P_VY] = (i % 17) * 0.01;
  }
  const setupMs = performance.now() - t0;

  const t1 = performance.now();
  for (let s = 0; s < steps; s++) sim.integrateAll(1 / 60);
  const integrateMs = performance.now() - t1;

  const analytic = analyticGravity(0, -9.81, steps, 1 / 60);
  const analyticError = Math.abs(sim.state[P_Y]! - analytic.y);
  const integrations = count * steps;

  return {
    analyticError,
    alive: sim.alive,
    results: [
      {
        name: "100k particle buffer fill",
        count,
        durationMs: setupMs,
        opsPerSec: Math.round((count / Math.max(setupMs, 1e-6)) * 1000),
      },
      {
        name: "100k particle integrate × 30",
        count: integrations,
        durationMs: integrateMs,
        opsPerSec: Math.round((integrations / Math.max(integrateMs, 1e-6)) * 1000),
      },
    ],
  };
}
