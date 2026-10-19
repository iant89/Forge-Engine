/**
 * Read-only render-graph diagnostics (Phase 21.3). Snapshot the most recently executed frame's
 * passes, dependencies, liveness, resource live ranges, alias slots and texture pool on demand.
 */

import type { RenderGraph, RenderGraphFrameRecord } from "../rendering/renderGraph.js";

export interface RenderGraphPassView {
  name: string;
  live: boolean;
  reason: "side effect" | "writes an imported target" | "feeds a live pass" | "nothing consumes its output";
  reads: string[];
  writes: string[];
  dependsOn: string[];
  /** GPU timestamp-query duration for this pass, or null if unavailable/not yet sampled. */
  gpuMs: number | null;
}

export interface RenderGraphView {
  passes: RenderGraphPassView[];
  culled: string[];
  resources: RenderGraphFrameRecord["resources"];
  pool: RenderGraphFrameRecord["pool"];
  transientBytes: number;
  aliasedBytes: number;
  pooledBytes: number;
  physicalTextures: number;
  texturesCreated: number;
  gpuFrameMs: number | null;
}

/** Build a plain-data view; call from a panel refresh or console command, not in the frame loop. */
export function inspectRenderGraph(graph: RenderGraph): RenderGraphView {
  const record = graph.inspect();
  const stats = graph.stats;
  const gpuTimes = new Map<string, number>();
  for (const timing of stats.gpuPassTimes) gpuTimes.set(timing.name, (gpuTimes.get(timing.name) ?? 0) + timing.ms);
  const imported = new Set(record.resources.filter((resource) => resource.imported).map((resource) => resource.name));
  const consumed = new Set<number>();
  for (const pass of record.passes) if (pass.live) for (const dependency of pass.dependsOn) consumed.add(dependency);

  const passes = record.passes.map((pass): RenderGraphPassView => {
    const writesImported = pass.writes.some((write) => imported.has(write.resource));
    const reason: RenderGraphPassView["reason"] = pass.sideEffect
      ? "side effect"
      : writesImported
        ? "writes an imported target"
        : pass.live && consumed.has(pass.index)
          ? "feeds a live pass"
          : "nothing consumes its output";
    return {
      name: pass.name,
      live: pass.live,
      reason,
      reads: [...pass.reads],
      writes: pass.writes.map((write) => `${write.resource}${write.subresource ? `[${write.subresource}]` : ""}${write.load ? "+load" : ""}`),
      dependsOn: pass.dependsOn.map((index) => record.passes[index]?.name ?? `#${index}`),
      gpuMs: stats.gpuTimingAvailable ? (gpuTimes.get(pass.name) ?? null) : null,
    };
  });

  return {
    passes,
    culled: passes.filter((pass) => !pass.live).map((pass) => pass.name),
    resources: record.resources.map((resource) => ({ ...resource })),
    pool: record.pool.map((entry) => ({ ...entry })),
    transientBytes: stats.transientBytes,
    aliasedBytes: stats.aliasedBytes,
    pooledBytes: stats.pooledBytes,
    physicalTextures: stats.physicalTextures,
    texturesCreated: stats.texturesCreated,
    gpuFrameMs: stats.gpuTimingAvailable && stats.gpuFrameTimeMs > 0 ? stats.gpuFrameTimeMs : null,
  };
}

const mb = (bytes: number): string => `${(bytes / 1048576).toFixed(1)} MB`;

/** Compact text representation useful for logs and command consoles. */
export function formatRenderGraph(view: RenderGraphView): string {
  const lines = [
    `${view.passes.length} passes (${view.culled.length} culled)  transient ${mb(view.transientBytes)}  aliased ${mb(view.aliasedBytes)}  pooled ${mb(view.pooledBytes)}  gpu ${view.gpuFrameMs === null ? "n/a" : `${view.gpuFrameMs.toFixed(2)} ms`}`,
  ];
  for (const pass of view.passes) {
    const time = pass.gpuMs === null ? "" : `  ${pass.gpuMs.toFixed(2)} ms`;
    lines.push(`  ${pass.live ? "●" : "○"} ${pass.name}${time}  ${pass.reads.length ? `reads ${pass.reads.join(", ")}  ` : ""}writes ${pass.writes.join(", ") || "-"}${pass.live ? "" : `  (${pass.reason})`}`);
  }
  return lines.join("\n");
}
