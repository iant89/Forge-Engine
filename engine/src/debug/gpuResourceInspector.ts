/**
 * GPU resource inspector (Phase 21.4): every live buffer and texture the `GraphicsDevice` created,
 * grouped by label prefix (`forge.shadow.*`, `terrain.chunk.*` …), with the render graph's
 * transient pool and the resource registry's budget beside them, so "where did 900 MB go" has an
 * answer without a GPU capture.
 *
 * Unlabelled resources group under `(unlabelled)`: labelling is the fix, and the inspector makes
 * the missing labels visible. Allocates; call it on demand.
 */

import type { GpuResourceRecord, GraphicsDevice } from "../gpu/device.js";

export interface GpuResourceGroup {
  /** Label up to the grouping depth (`a.b.c.d` → `a.b` at depth 2). */
  group: string;
  count: number;
  bytes: number;
  textures: number;
  buffers: number;
  largest: GpuResourceRecord;
}

export interface GpuResourceView {
  totalBytes: number;
  textureBytes: number;
  bufferBytes: number;
  count: number;
  groups: GpuResourceGroup[];
  /** The `top` largest resources. */
  largest: GpuResourceRecord[];
  /** Resources created during the last `frames` frames (churn: a steady frame should create none). */
  recent: GpuResourceRecord[];
  /** Counters from `GraphicsDevice.gpuMemory` (pipelines, bind groups, shader modules). */
  objects: { pipelines: number; bindGroups: number; bindGroupLayouts: number; pipelineLayouts: number; shaderModules: number };
}

export interface GpuResourceInspectOptions {
  /** Label segments that form a group. Default 2. */
  depth?: number;
  top?: number;
  /** Window for `recent`, in device frames. Default 1 (this frame). */
  frames?: number;
  /** The current device frame, to evaluate `recent`; defaults to the newest createdFrame seen. */
  currentFrame?: number;
}

export function groupOfLabel(label: string, depth = 2): string {
  if (!label) return "(unlabelled)";
  const parts = label.split(/[.:/]/).filter((p) => p.length > 0);
  return parts.slice(0, Math.max(1, depth)).join(".") || "(unlabelled)";
}

export function inspectGpuResources(device: Pick<GraphicsDevice, "resourceList" | "gpuMemory">, options: GpuResourceInspectOptions = {}): GpuResourceView {
  const list = device.resourceList();
  const depth = options.depth ?? 2;
  const groups = new Map<string, GpuResourceGroup>();
  let textureBytes = 0, bufferBytes = 0, newest = 0;
  for (const r of list) {
    if (r.kind === "texture") textureBytes += r.bytes;
    else bufferBytes += r.bytes;
    newest = Math.max(newest, r.createdFrame);
    const key = groupOfLabel(r.label, depth);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { group: key, count: 0, bytes: 0, textures: 0, buffers: 0, largest: r }));
    g.count++;
    g.bytes += r.bytes;
    if (r.kind === "texture") g.textures++;
    else g.buffers++;
    if (r.bytes > g.largest.bytes) g.largest = r;
  }
  const now = options.currentFrame ?? newest;
  const window = Math.max(1, options.frames ?? 1);
  const m = device.gpuMemory;
  return {
    totalBytes: textureBytes + bufferBytes,
    textureBytes,
    bufferBytes,
    count: list.length,
    groups: [...groups.values()].sort((a, b) => b.bytes - a.bytes || a.group.localeCompare(b.group)),
    largest: list.slice(0, options.top ?? 10),
    recent: list.filter((r) => r.createdFrame > now - window),
    objects: { pipelines: m.pipelineCount, bindGroups: m.bindGroupCount, bindGroupLayouts: m.bindGroupLayoutCount, pipelineLayouts: m.pipelineLayoutCount, shaderModules: m.shaderModuleCount },
  };
}

const mb = (b: number) => `${(b / 1048576).toFixed(2)} MB`;

export function formatGpuResources(view: GpuResourceView): string {
  const lines = [`gpu ${mb(view.totalBytes)} in ${view.count} resources (textures ${mb(view.textureBytes)}, buffers ${mb(view.bufferBytes)}); ${view.objects.pipelines} pipelines, ${view.objects.bindGroups} bind groups`];
  for (const g of view.groups) lines.push(`  ${g.group.padEnd(28)} ${mb(g.bytes).padStart(10)}  ${g.count} (${g.textures}t/${g.buffers}b)  largest ${g.largest.label || "(unlabelled)"}`);
  return lines.join("\n");
}
