/**
 * Render graph inspector (Phase 21.3): the last frame's passes in declaration order — live or
 * culled, what each reads and attaches, which passes it waited on, its GPU time when timestamp
 * queries ran — plus every transient's live range and alias slot and the texture pool.
 *
 * Built from `RenderGraph.inspect()` and `RenderGraph.stats`; it allocates, so call it on demand
 * (a panel refresh, a console command), not every frame.
 */

import type { RenderGraph, RenderGraphFrameRecord, RenderGraphResourceRecord } from "../rendering/renderGraph.js";

export interface RenderGraphPassView {
  name: string;
  live: boolean;
  /** Why a culled pass was dropped, or why a live one was kept. */
  reason: "side effect" | "writes an imported target" | "feeds a live pass" | "nothing consumes its output";
  reads: string[];
  writes: string[];
  dependsOn: string[];
  /** GPU ms from timestamp queries for this pass name; null when unavailable. */
  gpuMs: number | null;
}

export interface RenderGraphView {
  passes: RenderGraphPassView[];
  culled: string[];
  resources: RenderGraphResourceRecord[];
  pool: RenderGraphFrameRecord["pool"];
  transientBytes: number;
  aliasedBytes: number;
  pooledBytes: number;
  physicalTextures: number;
  texturesCreated: number;
  gpuFrameMs: number | null;
}

export function inspectRenderGraph(graph: RenderGraph): RenderGraphView {
  const record = graph.inspect();
  const stats = graph.stats;
  const gpu = new Map<string, number>();
  for (const t of stats.gpuPassTimes) gpu.set(t.name, (gpu.get(t.name) ?? 0) + t.ms);
  const imported = new Set(record.resources.filter((r) => r.imported).map((r) => r.name));
  const feeds = new Set<number>();
  for (const p of record.passes) if (p.live) for (const d of p.dependsOn) feeds.add(d);
  const passes = record.passes.map((p): RenderGraphPassView => {
    const writesImported = p.writes.some((w) => imported.has(w.replace(/\[.*$|\+load$/g, "")));
    const reason = p.sideEffect ? "side effect" : writesImported ? "writes an imported target" : p.live && feeds.has(p.index) ? "feeds a live pass" : "nothing consumes its output";
    return {
      name: p.name,
      live: p.live,
      reason,
      reads: p.reads,
      writes: p.writes,
      dependsOn: p.dependsOn.map((i) => record.passes[i]?.name ?? `#${i}`),
      gpuMs: stats.gpuTimingAvailable ? (gpu.get(p.name) ?? null) : null,
    };
  });
  return {
    passes,
    culled: passes.filter((p) => !p.live).map((p) => p.name),
    resources: record.resources,
    pool: record.pool,
    transientBytes: stats.transientBytes,
    aliasedBytes: stats.aliasedBytes,
    pooledBytes: stats.pooledBytes,
    physicalTextures: stats.physicalTextures,
    texturesCreated: stats.texturesCreated,
    gpuFrameMs: stats.gpuTimingAvailable && stats.gpuFrameTimeMs > 0 ? stats.gpuFrameTimeMs : null,
  };
}

const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;

/** A text listing for logs and the console. */
export function formatRenderGraph(view: RenderGraphView): string {
  const lines = [`${view.passes.length} passes (${view.culled.length} culled)  transient ${mb(view.transientBytes)}  aliased ${mb(view.aliasedBytes)}  pooled ${mb(view.pooledBytes)}  gpu ${view.gpuFrameMs === null ? "n/a" : `${view.gpuFrameMs.toFixed(2)} ms`}`];
  for (const p of view.passes) {
    const time = p.gpuMs === null ? "" : `  ${p.gpuMs.toFixed(2)} ms`;
    lines.push(`  ${p.live ? "●" : "○"} ${p.name}${time}  ${p.reads.length ? `reads ${p.reads.join(", ")}  ` : ""}writes ${p.writes.join(", ") || "-"}${p.live ? "" : `  (${p.reason})`}`);
  }
  return lines.join("\n");
}
