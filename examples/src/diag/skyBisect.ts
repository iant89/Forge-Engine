/**
 * `?diag=1` sky bisect: candidate *fixes* for a sky that shades black on a device we cannot attach
 * a debugger to, applied as runtime replacements of the live `sky.wgsl` through the engine's own
 * hot-reload hook (`PipelineFactory.replaceShaderSource`, which statically validates before it
 * invalidates anything).
 *
 * The bug class this exists for (2026-10-12, iPhone Safari 26.6): every backend we can run in the
 * sandbox renders the analytic sky, while WebKit presents pure black above the horizon with the
 * pass listed, `gpuErrors 0` and the terrain lit — i.e. the sky fragment stage runs and returns
 * zero radiance. The suspects are the constructs only that stage uses: the per-pixel `select()`
 * that raises the sample counts in the horizon band, the dynamic loop bounds it feeds, the
 * Phase 17.1 multiple-scattering storage-buffer read, and the Phase 17.3 cloud deck mix. Each
 * variant below removes exactly one of them (or short-circuits the whole stage to a constant), so
 * a capture matrix over the variants names the culprit — and the variant that restores the sky on
 * the device *is* the production fix, already device-proven.
 *
 * Pure string surgery on the shipped source: no anchors, no variant (`null`), so a panel can say
 * "anchor missing" instead of quietly measuring the unmodified shader.
 */

import { SKY_SHADER } from "@forge/engine";

/** The label `PipelineFactory` registers the sky module under (see `pipeline.ts` `moduleFor`). */
export const SKY_SHADER_LABEL = "sky.wgsl";

export interface SkyBisectVariant {
  /** Stable id used in capture labels and logs. */
  id: string;
  /** What the variant removes, for the panel line. */
  label: string;
  /**
   * Return the mutated module source, or null when an anchor is not present in `source` (the
   * shader moved on; measuring a silently-unmutated module would be worse than not measuring).
   */
  apply(source: string): string | null;
}

/** Replace the single line containing `anchor` with `line`, or null when it is not there. */
function replaceLine(source: string, anchor: string, line: string): string | null {
  const at = source.indexOf(anchor);
  if (at < 0) return null;
  const start = source.lastIndexOf("\n", at) + 1;
  let end = source.indexOf("\n", at);
  if (end < 0) end = source.length;
  const indent = /^[ \t]*/.exec(source.slice(start, at))?.[0] ?? "";
  return `${source.slice(0, start)}${indent}${line}${source.slice(end)}`;
}

/** Insert `line` as the first statement of `fn fragmentMain`, or null when the entry is absent. */
function firstStatement(source: string, line: string): string | null {
  const anchor = "fn fragmentMain(in: SkyOut) -> @location(0) vec4<f32> {";
  const at = source.indexOf(anchor);
  if (at < 0) return null;
  const open = at + anchor.length;
  return `${source.slice(0, open)}\n  ${line}${source.slice(open)}`;
}

export const SKY_BISECT_VARIANTS: readonly SkyBisectVariant[] = [
  {
    id: "uniform-bounds",
    label: "loop bounds straight from the uniform (no per-pixel select)",
    apply: (source) => {
      const a = replaceLine(source, "let lightSamples = select(sky.lightSamples, max(sky.lightSamples, 32i), horizonBand);", "let lightSamples = sky.lightSamples;");
      if (a === null) return null;
      return replaceLine(a, "let viewSamples = select(sky.viewSamples, max(sky.viewSamples, 64i), horizonBand);", "let viewSamples = sky.viewSamples;");
    },
  },
  {
    id: "const-bounds",
    label: "compile-time loop bounds (no dynamic bound at all)",
    apply: (source) => {
      const a = replaceLine(source, "let lightSamples = select(sky.lightSamples, max(sky.lightSamples, 32i), horizonBand);", "let lightSamples = 8;");
      if (a === null) return null;
      return replaceLine(a, "let viewSamples = select(sky.viewSamples, max(sky.viewSamples, 64i), horizonBand);", "let viewSamples = 16;");
    },
  },
  {
    id: "no-select",
    label: "no scalar select() anywhere in the hot path (bounds constant, ray/sphere as ifs)",
    apply: (source) => {
      const bounds = SKY_BISECT_VARIANTS.find((v) => v.id === "const-bounds")?.apply(source) ?? null;
      if (bounds === null) return null;
      const exit = replaceLine(bounds, "return select(t, -1.0, t < 0.0);", "if (t < 0.0) { return -1.0; }\n  return t;");
      if (exit === null) return null;
      const entry = replaceLine(exit, "return select(t1, -1.0, t1 <= 0.0);", "if (t1 <= 0.0) { return -1.0; }\n  return t1;");
      if (entry === null) return null;
      // The horizon-band gate itself is a select-free comparison already; what remains is the
      // multi-scattering gate, which reads a uniform, not a per-pixel bool.
      return entry;
    },
  },
  {
    id: "no-ms",
    label: "no Phase 17.1 multiple-scattering storage-buffer read",
    apply: (source) => replaceLine(source, "if (sky.multiScattering != 0) {", "if (false) {"),
  },
  {
    id: "no-deck",
    label: "no Phase 17.3 cloud deck mix",
    apply: (source) => replaceLine(source, "let deck = cloudDeck(dir, sunDir, deckFootprint);", "let deck = vec4<f32>(0.0);"),
  },
  {
    id: "const-color",
    label: "fragment stage short-circuited to a constant (pass/attachment/uniform control)",
    apply: (source) => firstStatement(source, "return vec4<f32>(0.25, 0.5, 0.9, 1.0);"),
  },
];

/** The mutated module source for `id`, or null for an unknown id or a missing anchor. */
export function buildSkyBisectSource(source: string, id: string): string | null {
  const variant = SKY_BISECT_VARIANTS.find((v) => v.id === id);
  return variant ? variant.apply(source) : null;
}

/** The shipped sky module the variants are cut from (re-exported so the panel and tests share it). */
export const SKY_BISECT_BASE_SOURCE = SKY_SHADER;
