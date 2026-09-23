/**
 * Terrain generation as a background task — the worker half of Phase 10.2, usable today.
 *
 * The engine's own generators are pure functions of `(seed, cx, cz, pipeline spec)`, so a chunk cell
 * can be produced on any thread and is bit-for-bit identical to the inline result. That property is
 * what makes streaming deterministic, and it is asserted directly in `tests/tasks.test.ts` (a
 * worker-generated cell compared field by field against the main-thread cell).
 *
 * This module lives in `terrain/` rather than in `core/tasks/taskHandlers.ts` on purpose: core task
 * handlers depend on `core/` + `math/` only (an architecture test enforces it), while reconstructing
 * a pipeline needs the generators. A host installs this package in its worker module:
 *
 * ```ts
 * import { installTerrainTaskHandlers, installWorkerScope } from "@forge/engine";
 * installWorkerScope(self as never, { installHandlers: () => installTerrainTaskHandlers() });
 * ```
 *
 * Payload/result shapes are the contract the worker protocol speaks; `bytes` is reported so the
 * streaming budgets of Phase 10.7 have something to spend.
 */

import { UsageError } from "../core/errors.js";
import { hasTaskHandler, registerTaskHandler, registerTaskResultTransfer, type TaskContext } from "../core/tasks/registry.js";
import { createWorldCell, GeneratorPipeline, type ScatterInstance, type TerrainStage, type WorldCell } from "./generators.js";
import { createPipelineFromSpec, describePipeline, hashPipelineSpec, type TerrainPipelineSpec } from "./pipelineSpec.js";

export interface TerrainCellTaskPayload {
  seed: number;
  cx: number;
  cz: number;
  /** Chunk edge length in metres. */
  size: number;
  /** Grid points per edge, including the shared edge with the neighbour. */
  resolution: number;
  /** The pipeline to run, as data (see `pipelineSpec.ts`). */
  pipeline: TerrainPipelineSpec;
}

export interface TerrainCellTaskResult {
  cx: number;
  cz: number;
  seed: number;
  size: number;
  resolution: number;
  heights: Float32Array;
  slopes: Float32Array;
  /** 4 splat weights per vertex. */
  biomes: Float32Array;
  scatters: ScatterInstance[];
  minHeight: number;
  maxHeight: number;
  /** Bytes of the three grids, for budgets and progress reporting. */
  bytes: number;
  /** `hashPipelineSpec` of the pipeline that produced this cell (cache key component). */
  pipelineHash: number;
}

/** Allocate a cell and run every stage of the spec over it. Pure in `(payload)`. */
export function generateTerrainCell(payload: TerrainCellTaskPayload, ctx?: TaskContext): TerrainCellTaskResult {
  const resolution = Math.max(2, Math.floor(payload.resolution));
  const cell = createWorldCell(payload.cx, payload.cz, payload.size, resolution, payload.seed);
  const pipeline = createPipelineFromSpec(payload.pipeline);
  const stages = pipeline.stages.length;
  for (let i = 0; i < stages; i++) {
    pipeline.stages[i]!.process(cell);
    ctx?.progress((i + 1) / Math.max(1, stages));
  }
  let minHeight = Infinity;
  let maxHeight = -Infinity;
  for (let i = 0; i < cell.heights.length; i++) {
    const h = cell.heights[i]!;
    if (h < minHeight) minHeight = h;
    if (h > maxHeight) maxHeight = h;
  }
  return {
    cx: cell.cx,
    cz: cell.cz,
    seed: cell.seed,
    size: cell.size,
    resolution: cell.resolution,
    heights: cell.heights,
    slopes: cell.slopes,
    biomes: cell.biomes,
    scatters: cell.scatters,
    minHeight: Number.isFinite(minHeight) ? minHeight : 0,
    maxHeight: Number.isFinite(maxHeight) ? maxHeight : 0,
    bytes: cell.heights.byteLength + cell.slopes.byteLength + cell.biomes.byteLength,
    pipelineHash: hashPipelineSpec(payload.pipeline),
  };
}

/** Wrap a task result back into the `WorldCell` the generators and the mesh builder consume. */
export function cellFromResult(result: TerrainCellTaskResult): WorldCell {
  const expected = result.resolution * result.resolution;
  if (result.heights.length !== expected || result.slopes.length !== expected || result.biomes.length !== expected * 4) {
    throw new UsageError(
      `terrain cell result for (${result.cx},${result.cz}) has inconsistent grids: ` +
        `expected ${expected} heights / slopes and ${expected * 4} biome weights`,
    );
  }
  return {
    cx: result.cx,
    cz: result.cz,
    size: result.size,
    resolution: result.resolution,
    seed: result.seed,
    heights: result.heights,
    slopes: result.slopes,
    biomes: result.biomes,
    scatters: result.scatters,
  };
}

/** Build the payload for a chunk from a live pipeline (the main-thread entry point). */
export function terrainCellPayload(
  pipeline: GeneratorPipeline,
  seed: number,
  cx: number,
  cz: number,
  size: number,
  resolution: number,
): TerrainCellTaskPayload {
  return { seed, cx, cz, size, resolution, pipeline: describePipeline(pipeline) };
}

/**
 * Scheduler key for a chunk generation submit.
 * Includes resolution + epoch so cancel→resubmit cannot reuse the same string identity
 * (reused keys let a cancelled catch clear the replacement in-flight bookkeeping).
 * Prefix `terrain.cell:` remains valid for cancelGroup.
 */
export function terrainCellKey(cx: number, cz: number, resolution = 0, epoch = 0): string {
  return `terrain.cell:${cx},${cz}:${resolution}:${epoch}`;
}

/**
 * Buffers a `terrain.cell` result owns. The worker posts them as transferables (zero copy), so the
 * main thread receives the grids without a structured-clone copy of every vertex.
 */
export function transferablesForTerrainCell(result: unknown): Transferable[] {
  const r = result as Partial<TerrainCellTaskResult> | null;
  if (!r) return [];
  const out: Transferable[] = [];
  if (r.heights?.buffer) out.push(r.heights.buffer as Transferable);
  if (r.slopes?.buffer) out.push(r.slopes.buffer as Transferable);
  if (r.biomes?.buffer) out.push(r.biomes.buffer as Transferable);
  return out;
}

/** The task names this package registers. */
export const TERRAIN_TASK_NAMES = ["terrain.cell"] as const;

/**
 * Register this package's handlers, plus the transfer provider that makes their results zero-copy.
 * Idempotent: installing twice (a host that installs it and an engine version that also does) is a
 * no-op rather than a "handler already registered" throw.
 */
export function installTerrainTaskHandlers(
  register: <P, R>(name: string, fn: (payload: P, ctx: TaskContext) => R | Promise<R>) => void = registerTaskHandler,
  registerTransfer: (name: string, fn: (result: unknown) => Transferable[]) => void = registerTaskResultTransfer,
  has: (name: string) => boolean = hasTaskHandler,
): void {
  // Installing twice is a no-op rather than "handler already registered": a host may install this
  // package in its worker module and the engine may also install it on the main thread.
  if (!has("terrain.cell")) register<TerrainCellTaskPayload, TerrainCellTaskResult>("terrain.cell", (payload, ctx) => generateTerrainCell(payload, ctx));
  registerTransfer("terrain.cell", transferablesForTerrainCell);
}

/** Convenience for tests/tools: run a payload inline, exactly as a worker would. */
export function executeTerrainCell(payload: TerrainCellTaskPayload): TerrainCellTaskResult {
  return generateTerrainCell(payload);
}

/** A stage list, for error messages in hosts that build pipelines dynamically. */
export function describeStageKinds(stages: readonly TerrainStage[]): string[] {
  return stages.map((s) => s.name);
}
