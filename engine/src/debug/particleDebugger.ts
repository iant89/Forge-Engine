/**
 * Read-only CPU/GPU particle diagnostics and bounded CPU-particle wireframes (Phase 21.7).
 * GPU particle positions stay device-authoritative: this debugger reports their counters/emitter
 * configuration without introducing a synchronization readback.
 */

import type { EntityId } from "../scene/entityId.js";
import type { Scene } from "../scene/scene.js";
import { ParticleComponent } from "../particles/components.js";
import { ParticleWorld } from "../particles/world.js";
import { GpuParticleWorld } from "../particles/gpuWorld.js";
import { isAlive, P_LIFE, P_MAX_LIFE, P_VX, P_VY, P_VZ, P_X, P_Y, P_Z, PARTICLE_FLOATS } from "../particles/layout.js";
import type { ParticleSimulation } from "../particles/simulation.js";
import { Vec3 } from "../math/vec.js";

export interface ParticleDebugSample {
  slot: number;
  position: [number, number, number];
  velocity: [number, number, number];
  remainingLife: number;
  maxLife: number;
}

export interface ParticleEmitterDebugInfo {
  position: [number, number, number];
  direction: [number, number, number];
  rate: number;
  lifeMin: number;
  lifeMax: number;
  size: number;
  speedMin: number;
  speedMax: number;
  jitter: [number, number, number];
  coneAngle: number;
}

export interface ParticleWorldDebugInfo {
  name: string;
  backend: "cpu" | "gpu";
  entityId: EntityId | null;
  enabled: boolean;
  ready: boolean;
  capacity: number;
  alive: number | null;
  emitted: number;
  steps: number;
  storageBytes: number;
  emitter: ParticleEmitterDebugInfo | null;
  sampledParticles: ParticleDebugSample[];
  scannedSlots: number;
  truncatedParticles: boolean;
}

export interface ParticleDebugSnapshot {
  cpuWorlds: number;
  gpuWorlds: number;
  worldCount: number;
  worlds: ParticleWorldDebugInfo[];
  truncatedWorlds: boolean;
}

export interface ParticleDebugOptions {
  /** Case-insensitive substring filter by scene-object name or ECS entity ID. */
  filter?: string;
  /** Maximum worlds emitted. Defaults to 32. */
  maxWorlds?: number;
  /** Maximum sampled live particles per CPU world. Defaults to 128. */
  maxParticleSamples?: number;
  /** Maximum CPU slots scanned per CPU world. Defaults to 8192. */
  scanBudget?: number;
  /** Half-width of position/emitter markers. Defaults to 0.04 world units. */
  markerSize?: number;
  /** Scale applied to particle velocity vectors. Defaults to 0.2 seconds. */
  velocityScale?: number;
  /** Include sampled particle velocity segments. Defaults to true. */
  showVelocity?: boolean;
  /** Include emitter origin and direction markers. Defaults to true. */
  showEmitters?: boolean;
}

export type ParticleDebugLineKind = "particle" | "velocity" | "emitter" | "emissionDirection";

export interface ParticleDebugLine {
  worldName: string;
  kind: ParticleDebugLineKind;
  start: [number, number, number];
  end: [number, number, number];
  color: number;
}

const CPU_PARTICLE_COLOR = 0xffffa040;
const PARTICLE_VELOCITY_COLOR = 0xff40e0ff;
const EMITTER_COLOR = 0xff40ff80;
const EMISSION_DIRECTION_COLOR = 0xffffff40;

type CpuParticleSource = { name: string; entityId: EntityId | null; enabled: boolean; simulation: ParticleSimulation };
type ParticleSource =
  | { backend: "cpu"; source: CpuParticleSource }
  | { backend: "gpu"; source: GpuParticleWorld };

/** Inspect scene-object worlds and ECS ParticleComponents without stepping simulation or reading GPU buffers back. */
export function inspectParticles(scene: Scene, options: ParticleDebugOptions = {}): ParticleDebugSnapshot {
  const worldLimit = bounded(options.maxWorlds, 32, 128);
  const sampleLimit = bounded(options.maxParticleSamples, 128, 512);
  const scanBudget = bounded(options.scanBudget, 8192, 65536);
  const filter = options.filter?.trim().toLowerCase() ?? "";
  const found: ParticleSource[] = [];
  let cpuWorlds = 0;
  let gpuWorlds = 0;

  for (const object of scene.objects) {
    if (object instanceof ParticleWorld) {
      if (!filter || object.name.toLowerCase().includes(filter)) {
        found.push({ backend: "cpu", source: { name: object.name, entityId: null, enabled: object.enabled, simulation: object.simulation } });
        cpuWorlds++;
      }
    } else if (object instanceof GpuParticleWorld) {
      if (!filter || object.name.toLowerCase().includes(filter)) {
        found.push({ backend: "gpu", source: object });
        gpuWorlds++;
      }
    }
  }

  for (const component of scene.world.store(ParticleComponent).liveValues()) {
    const entityId = component.entity;
    const label = `ParticleComponent@${entityId}`;
    if (filter && !label.toLowerCase().includes(filter)) continue;
    found.push({ backend: "cpu", source: { name: label, entityId, enabled: component.enabled, simulation: component.simulation } });
    cpuWorlds++;
  }

  const worlds = found.slice(0, worldLimit).map((item) =>
    item.backend === "cpu"
      ? inspectCpuSimulation(item.source, sampleLimit, scanBudget)
      : inspectGpuWorld(item.source),
  );
  return { cpuWorlds, gpuWorlds, worldCount: found.length, worlds, truncatedWorlds: found.length > worlds.length };
}

/** Produce CPU particle position markers, velocity vectors, and emitter direction lines. */
export function particleDebugLines(scene: Scene, options: ParticleDebugOptions = {}): ParticleDebugLine[] {
  const snapshot = inspectParticles(scene, options);
  const marker = Number.isFinite(options.markerSize) ? Math.max(0, options.markerSize!) : 0.04;
  const velocityScale = Number.isFinite(options.velocityScale) ? options.velocityScale! : 0.2;
  const showVelocity = options.showVelocity ?? true;
  const showEmitters = options.showEmitters ?? true;
  const lines: ParticleDebugLine[] = [];

  for (const world of snapshot.worlds) {
    for (const particle of world.sampledParticles) {
      const [x, y, z] = particle.position;
      lines.push(
        line(world.name, "particle", [x - marker, y, z], [x + marker, y, z], CPU_PARTICLE_COLOR),
        line(world.name, "particle", [x, y - marker, z], [x, y + marker, z], CPU_PARTICLE_COLOR),
        line(world.name, "particle", [x, y, z - marker], [x, y, z + marker], CPU_PARTICLE_COLOR),
      );
      if (showVelocity) {
        const [vx, vy, vz] = particle.velocity;
        lines.push(line(world.name, "velocity", [x, y, z], [x + vx * velocityScale, y + vy * velocityScale, z + vz * velocityScale], PARTICLE_VELOCITY_COLOR));
      }
    }
    if (showEmitters && world.emitter) {
      const [x, y, z] = world.emitter.position;
      const [dx, dy, dz] = world.emitter.direction;
      lines.push(
        line(world.name, "emitter", [x - marker * 2, y, z], [x + marker * 2, y, z], EMITTER_COLOR),
        line(world.name, "emitter", [x, y - marker * 2, z], [x, y + marker * 2, z], EMITTER_COLOR),
        line(world.name, "emitter", [x, y, z - marker * 2], [x, y, z + marker * 2], EMITTER_COLOR),
        line(world.name, "emissionDirection", [x, y, z], [x + dx, y + dy, z + dz], EMISSION_DIRECTION_COLOR),
      );
    }
  }
  return lines;
}

/** Forward generated segments to a Renderer-compatible line callback. */
export function drawParticleDebug(
  scene: Scene,
  drawLine: (start: Vec3, end: Vec3, color: number) => void,
  options: ParticleDebugOptions = {},
): number {
  const lines = particleDebugLines(scene, options);
  for (const item of lines) drawLine(new Vec3(...item.start), new Vec3(...item.end), item.color);
  return lines.length;
}

function inspectCpuSimulation(source: CpuParticleSource, sampleLimit: number, scanBudget: number): ParticleWorldDebugInfo {
  const sim = source.simulation;
  const emitter = sim.emitter;
  const maxSlots = Math.min(sim.capacity, scanBudget);
  const sampledParticles: ParticleDebugSample[] = [];
  let scannedSlots = 0;
  for (let slot = 0; slot < maxSlots && sampledParticles.length < sampleLimit; slot++) {
    scannedSlots++;
    if (!isAlive(sim.state, slot)) continue;
    const o = slot * PARTICLE_FLOATS;
    sampledParticles.push({
      slot,
      position: [sim.state[o + P_X]!, sim.state[o + P_Y]!, sim.state[o + P_Z]!],
      velocity: [sim.state[o + P_VX]!, sim.state[o + P_VY]!, sim.state[o + P_VZ]!],
      remainingLife: sim.state[o + P_LIFE]!,
      maxLife: sim.state[o + P_MAX_LIFE]!,
    });
  }
  const particleScanTruncated = maxSlots < sim.capacity;
  return {
    name: source.name,
    backend: "cpu",
    entityId: source.entityId,
    enabled: source.enabled,
    ready: true,
    capacity: sim.capacity,
    alive: sim.alive,
    emitted: sim.emitted,
    steps: sim.stepCount,
    storageBytes: sim.state.byteLength,
    emitter: {
      position: [emitter.position.x, emitter.position.y, emitter.position.z],
      direction: [emitter.cone.direction.x, emitter.cone.direction.y, emitter.cone.direction.z],
      rate: emitter.rate,
      lifeMin: emitter.lifeMin,
      lifeMax: emitter.lifeMax,
      size: emitter.size,
      speedMin: emitter.cone.speedMin,
      speedMax: emitter.cone.speedMax,
      jitter: [emitter.jitter.x, emitter.jitter.y, emitter.jitter.z],
      coneAngle: emitter.cone.angle,
    },
    sampledParticles,
    scannedSlots,
    truncatedParticles: particleScanTruncated || sampledParticles.length < sim.alive,
  };
}

function inspectGpuWorld(world: GpuParticleWorld): ParticleWorldDebugInfo {
  const system = world.system;
  if (!system) return {
    name: world.name,
    backend: "gpu",
    entityId: null,
    enabled: world.enabled,
    ready: false,
    capacity: 0,
    alive: null,
    emitted: 0,
    steps: 0,
    storageBytes: 0,
    emitter: null,
    sampledParticles: [],
    scannedSlots: 0,
    truncatedParticles: false,
  };
  const emitter = system.emitter;
  return {
    name: world.name,
    backend: "gpu",
    entityId: null,
    enabled: world.enabled,
    ready: system.ready,
    capacity: system.capacity,
    alive: null,
    emitted: system.emitted,
    steps: system.stepCount,
    storageBytes: system.storageBytes(),
    emitter: {
      position: [emitter.position.x, emitter.position.y, emitter.position.z],
      direction: [emitter.coneDir.x, emitter.coneDir.y, emitter.coneDir.z],
      rate: emitter.rate,
      lifeMin: emitter.lifeMin,
      lifeMax: emitter.lifeMax,
      size: emitter.size,
      speedMin: emitter.speedMin,
      speedMax: emitter.speedMax,
      jitter: [emitter.jitter.x, emitter.jitter.y, emitter.jitter.z],
      coneAngle: emitter.coneAngle,
    },
    sampledParticles: [],
    scannedSlots: 0,
    truncatedParticles: false,
  };
}

function bounded(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.floor(value!))) : fallback;
}

function line(worldName: string, kind: ParticleDebugLineKind, start: [number, number, number], end: [number, number, number], color: number): ParticleDebugLine {
  return { worldName, kind, start, end, color: color >>> 0 };
}
