/**
 * Worker-backed population generation (Phase 14.6).
 *
 * The task owns both halves of the acceptance decision: it reconstructs the canonical terrain
 * surface from the serialized terrain pipeline, then runs the same deterministic scatter function
 * used by the inline fallback. The result is plain typed arrays, so a population chunk can cross the
 * worker boundary without scene, terrain-tile, GPU or ECS state.
 */

import { type TaskContext, hasTaskHandler, registerTaskHandler, registerTaskResultTransfer } from "../core/tasks/registry.js";
import { generateTerrainCell, type TerrainCellTaskResult } from "../terrain/tasks.js";
import type { TerrainPipelineSpec } from "../terrain/pipelineSpec.js";
import {
  GridPopulationSurfaceSampler,
  resolvePopulationTypeSpec,
  scatterPopulationChunk,
  type PopulationSurfaceGrid,
  type PopulationTypeSpec,
} from "./scatter.js";
import { settlePopulationBlockWithPhysics, type PopulationPhysicsSettlingOptions } from "./settle.js";
import { PopulationInstanceBlock } from "../scene/population.js";

export const POPULATION_CHUNK_TASK = "population.chunk" as const;

export interface PopulationChunkTaskPayload {
  seed: number;
  cx: number;
  cz: number;
  size: number;
  /** Fixed resolution used for load-order-independent acceptance. */
  surfaceResolution: number;
  pipeline: TerrainPipelineSpec;
  types: PopulationTypeSpec[];
  settlePhysics: false | PopulationPhysicsSettlingOptions;
}

export interface PopulationChunkTaskEntry {
  typeId: number;
  positions: Float32Array;
  scales: Float32Array;
  rotations: Float32Array;
  tints: Uint32Array;
  count: number;
}

export interface PopulationChunkTaskResult {
  cx: number;
  cz: number;
  size: number;
  surfaceResolution: number;
  /** The canonical surface is returned so the main thread can retain the exact task input. */
  surfaceHeights: Float32Array;
  entries: PopulationChunkTaskEntry[];
}

function taskContext(ctx: TaskContext | undefined, scale: number, offset: number): TaskContext | undefined {
  if (!ctx) return undefined;
  return {
    get cancelled() {
      return ctx.cancelled;
    },
    progress(value, detail) {
      ctx.progress(offset + value * scale, detail);
    },
    logger: ctx.logger,
  };
}

/** Pure worker/inline implementation of one complete chunk population. */
export function generatePopulationChunk(
  payload: PopulationChunkTaskPayload,
  ctx?: TaskContext,
): PopulationChunkTaskResult {
  const terrain: TerrainCellTaskResult = generateTerrainCell(
    {
      seed: payload.seed,
      cx: payload.cx,
      cz: payload.cz,
      size: payload.size,
      resolution: payload.surfaceResolution,
      pipeline: payload.pipeline,
    },
    taskContext(ctx, 0.65, 0),
  );
  const grid: PopulationSurfaceGrid = {
    originX: payload.cx * payload.size,
    originZ: payload.cz * payload.size,
    size: payload.size,
    resolution: terrain.resolution,
    heights: terrain.heights,
  };
  const sampler = new GridPopulationSurfaceSampler(grid);
  const entries: PopulationChunkTaskEntry[] = [];
  const settleOptions = payload.settlePhysics || undefined;

  payload.types.forEach((type, index) => {
    if (ctx?.cancelled) return;
    const resolved = resolvePopulationTypeSpec(type);
    const block = new PopulationInstanceBlock(resolved.maxPerChunk);
    scatterPopulationChunk(resolved, payload.seed, payload.cx, payload.cz, payload.size, sampler, block);
    if (settleOptions) settlePopulationBlockWithPhysics(block, resolved, sampler, settleOptions);
    entries.push({
      typeId: resolved.id,
      positions: block.positions,
      scales: block.scales,
      rotations: block.rotations,
      tints: block.tints,
      count: block.count,
    });
    ctx?.progress(0.65 + ((index + 1) / Math.max(1, payload.types.length)) * 0.35);
  });

  return {
    cx: payload.cx,
    cz: payload.cz,
    size: payload.size,
    surfaceResolution: terrain.resolution,
    surfaceHeights: terrain.heights,
    entries,
  };
}

/** Transfer every fresh grid/instance buffer exactly once. */
export function transferablesForPopulationChunk(result: unknown): Transferable[] {
  const value = result as Partial<PopulationChunkTaskResult> | null;
  if (!value) return [];
  const buffers = new Set<ArrayBuffer>();
  const add = (data: ArrayBufferView | undefined): void => {
    if (data?.buffer instanceof ArrayBuffer) buffers.add(data.buffer);
  };
  add(value.surfaceHeights);
  for (const entry of value.entries ?? []) {
    add(entry.positions);
    add(entry.scales);
    add(entry.rotations);
    add(entry.tints);
  }
  return [...buffers] as Transferable[];
}

export const POPULATION_TASK_NAMES = [POPULATION_CHUNK_TASK] as const;

/** Install the task on the main thread or a custom worker bootstrap. Idempotent by task name. */
export function installPopulationTaskHandlers(
  register: <P, R>(name: string, fn: (payload: P, ctx: TaskContext) => R | Promise<R>) => void = registerTaskHandler,
  registerTransfer: (name: string, fn: (result: unknown) => Transferable[]) => void = registerTaskResultTransfer,
  has: (name: string) => boolean = hasTaskHandler,
): void {
  if (!has(POPULATION_CHUNK_TASK)) {
    register<PopulationChunkTaskPayload, PopulationChunkTaskResult>(POPULATION_CHUNK_TASK, (payload, ctx) =>
      generatePopulationChunk(payload, ctx),
    );
  }
  registerTransfer(POPULATION_CHUNK_TASK, transferablesForPopulationChunk);
}

/** Convenience for tests and hosts that want the worker body without a scheduler. */
export function executePopulationChunk(payload: PopulationChunkTaskPayload): PopulationChunkTaskResult {
  return generatePopulationChunk(payload);
}
