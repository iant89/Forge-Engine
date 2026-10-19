/**
 * Read-only live GPU allocation diagnostics (Phase 21.4), grouped by resource-label prefixes.
 * Unlabelled resources are kept visible as `(unlabelled)` so missing labels are easy to find.
 */

import type { GpuResourceRecord, GraphicsDevice } from "../gpu/device.js";

export interface GpuResourceGroup {
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
  largest: GpuResourceRecord[];
  /** Resources allocated within the requested recent-frame window. */
  recent: GpuResourceRecord[];
  objects: {
    pipelines: number;
    bindGroups: number;
    bindGroupLayouts: number;
    pipelineLayouts: number;
    shaderModules: number;
  };
}

export interface GpuResourceInspectOptions {
  /** Number of label segments to group by (default 2). */
  depth?: number;
  /** Largest resources to include (default 10). */
  top?: number;
  /** Recent allocation window in device frames (default 1). */
  frames?: number;
  /** Current GraphicsDevice frame index; defaults to the device's current index. */
  currentFrame?: number;
}

export function groupOfLabel(label: string, depth = 2): string {
  if (!label) return "(unlabelled)";
  const segments = label.split(/[.:/]/).filter(Boolean);
  const count = Number.isFinite(depth) ? Math.max(1, Math.floor(depth)) : 2;
  return segments.slice(0, count).join(".") || "(unlabelled)";
}

export function inspectGpuResources(
  device: Pick<GraphicsDevice, "resourceList" | "gpuMemory" | "frameIndex">,
  options: GpuResourceInspectOptions = {},
): GpuResourceView {
  const resources = device.resourceList();
  const depth = options.depth ?? 2;
  const groups = new Map<string, GpuResourceGroup>();
  let textureBytes = 0;
  let bufferBytes = 0;

  for (const resource of resources) {
    if (resource.kind === "texture") textureBytes += resource.bytes;
    else bufferBytes += resource.bytes;

    const key = groupOfLabel(resource.label, depth);
    let group = groups.get(key);
    if (!group) {
      group = { group: key, count: 0, bytes: 0, textures: 0, buffers: 0, largest: resource };
      groups.set(key, group);
    }
    group.count++;
    group.bytes += resource.bytes;
    if (resource.kind === "texture") group.textures++;
    else group.buffers++;
    if (resource.bytes > group.largest.bytes) group.largest = resource;
  }

  const currentFrame = options.currentFrame ?? device.frameIndex;
  const frameWindow = Number.isFinite(options.frames) ? Math.max(1, Math.floor(options.frames!)) : 1;
  const topCount = Number.isFinite(options.top) ? Math.max(0, Math.floor(options.top!)) : 10;
  const memory = device.gpuMemory;
  return {
    totalBytes: textureBytes + bufferBytes,
    textureBytes,
    bufferBytes,
    count: resources.length,
    groups: [...groups.values()].sort((a, b) => b.bytes - a.bytes || a.group.localeCompare(b.group)),
    largest: resources.slice(0, topCount).map((resource) => ({ ...resource })),
    recent: resources.filter((resource) => resource.createdFrame > currentFrame - frameWindow).map((resource) => ({ ...resource })),
    objects: {
      pipelines: memory.pipelineCount,
      bindGroups: memory.bindGroupCount,
      bindGroupLayouts: memory.bindGroupLayoutCount,
      pipelineLayouts: memory.pipelineLayoutCount,
      shaderModules: memory.shaderModuleCount,
    },
  };
}

const mb = (bytes: number): string => `${(bytes / 1048576).toFixed(2)} MB`;

export function formatGpuResources(view: GpuResourceView): string {
  const lines = [
    `gpu ${mb(view.totalBytes)} in ${view.count} resources (textures ${mb(view.textureBytes)}, buffers ${mb(view.bufferBytes)}); ${view.objects.pipelines} pipelines, ${view.objects.bindGroups} bind groups`,
  ];
  for (const group of view.groups) {
    lines.push(`  ${group.group.padEnd(28)} ${mb(group.bytes).padStart(10)}  ${group.count} (${group.textures}t/${group.buffers}b)  largest ${group.largest.label || "(unlabelled)"}`);
  }
  return lines.join("\n");
}
