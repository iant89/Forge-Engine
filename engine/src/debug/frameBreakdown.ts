/**
 * Frame breakdown (Phase 21.1): where a frame's time went, by engine subsystem.
 *
 * `EntityWorld.runSystems` and `Scene.update` time every system and scene object as a profiler
 * scope labelled `<category>:<name>` ({@link profileLabel}), and the engine adds `streaming:assets`
 * around the asset streamer and `Render` around submission. {@link frameBreakdown} folds the
 * profiler's scopes into the roadmap's categories — simulation, physics, terrain, streaming,
 * rendering, particles, scripting, audio — plus the CPU frame (scene update + render submission)
 * and the GPU frame (timestamp queries, when the adapter has them).
 *
 * A system or scene object names its category with a `profileCategory` **getter** (a prototype
 * accessor, never an own field: `captureState` would put an own field into snapshots and state
 * hashes). Without one, {@link classifyProfileName} guesses from the name and falls back to
 * `simulation`.
 */

import type { ScopeStats } from "./profiler.js";

export const PROFILE_CATEGORIES = ["simulation", "physics", "terrain", "streaming", "rendering", "particles", "scripting", "audio"] as const;
export type ProfileCategory = (typeof PROFILE_CATEGORIES)[number];

const RULES: readonly [RegExp, ProfileCategory][] = [
  [/physic/i, "physics"],
  [/particle|precipitation|snowfall|rain(field)?$/i, "particles"],
  [/terrain|population|tiretrack|track|chunk/i, "terrain"],
  [/script/i, "scripting"],
  [/audio|sound/i, "audio"],
  [/stream/i, "streaming"],
  [/render/i, "rendering"],
];

/** A category from a system or object name (the fallback when it declares none). */
export function classifyProfileName(name: string): ProfileCategory {
  for (const [re, category] of RULES) if (re.test(name)) return category;
  return "simulation";
}

function isCategory(value: unknown): value is ProfileCategory {
  return typeof value === "string" && (PROFILE_CATEGORIES as readonly string[]).includes(value);
}

const LABELS = new WeakMap<object, string>();

/** The scope label for a system or scene object: `<category>:<name>`, cached per object. */
export function profileLabel(target: { readonly name: string }): string {
  let label = LABELS.get(target);
  if (label === undefined) {
    const declared = (target as { profileCategory?: unknown }).profileCategory;
    label = `${isCategory(declared) ? declared : classifyProfileName(target.name)}:${target.name}`;
    LABELS.set(target, label);
  }
  return label;
}

export interface FrameBreakdown {
  /** CPU time of the frame: scene update (`Frame`) + render submission (`Render`), ms (EWMA). */
  cpuFrameMs: number;
  /** GPU time of the frame from timestamp queries, ms; 0 when the adapter reports none. */
  gpuFrameMs: number;
  /** Per category, ms (EWMA). `rendering` includes render submission. */
  categories: Record<ProfileCategory, number>;
  /** Scopes per category, slowest first (name without the category prefix, ms). */
  top: Record<ProfileCategory, { name: string; ms: number }[]>;
  /** Scene-update time not inside any categorised scope (fixed hooks, journal flushes), ms. */
  unattributedMs: number;
}

/**
 * Fold profiler scopes into the categories. `gpuFrameMs` is the last frame's GPU total
 * (`profiler.lastFrame()?.gpuMs`), passed in so this stays a pure function of its inputs.
 */
export function frameBreakdown(stats: readonly ScopeStats[], gpuFrameMs = 0, topPerCategory = 3): FrameBreakdown {
  const categories = Object.fromEntries(PROFILE_CATEGORIES.map((c) => [c, 0])) as Record<ProfileCategory, number>;
  const top = Object.fromEntries(PROFILE_CATEGORIES.map((c) => [c, [] as { name: string; ms: number }[]])) as FrameBreakdown["top"];
  let frame = 0, render = 0, inScene = 0;
  for (const s of stats) {
    if (s.name === "Frame") frame = s.ewmaMs;
    else if (s.name === "Render") render = s.ewmaMs;
    const sep = s.name.indexOf(":");
    if (sep <= 0) continue;
    const category = s.name.slice(0, sep);
    if (!isCategory(category)) continue;
    categories[category] += s.ewmaMs;
    if (category !== "streaming") inScene += s.ewmaMs;
    top[category].push({ name: s.name.slice(sep + 1), ms: s.ewmaMs });
  }
  categories.rendering += render;
  for (const c of PROFILE_CATEGORIES) {
    top[c].sort((a, b) => b.ms - a.ms);
    top[c].length = Math.min(top[c].length, topPerCategory);
  }
  return { cpuFrameMs: frame + render, gpuFrameMs: Math.max(0, gpuFrameMs), categories, top, unattributedMs: Math.max(0, frame - inScene) };
}

/** A compact text table for overlays and logs. */
export function formatFrameBreakdown(b: FrameBreakdown): string {
  const rows = PROFILE_CATEGORIES.filter((c) => b.categories[c] > 0.0005).sort((a, c) => b.categories[c] - b.categories[a]);
  const lines = [`frame cpu ${b.cpuFrameMs.toFixed(2)} ms  gpu ${b.gpuFrameMs > 0 ? `${b.gpuFrameMs.toFixed(2)} ms` : "n/a"}`];
  for (const c of rows) lines.push(`  ${c.padEnd(10)} ${b.categories[c].toFixed(2)} ms  ${b.top[c].map((t) => t.name).join(", ")}`);
  return lines.join("\n");
}
