/**
 * Population type presets (Phase 14.2): the six world-population types as engine data.
 *
 * A preset is a {@link PopulationTypeSpec} and nothing else — pure placement rules and appearance
 * parameters, with no geometry, no material and no device. That split is deliberate: the scatter is
 * a pure function a worker or a test can run, while the *look* of a type belongs to whoever builds
 * the scene (the demo pairs `rocks` with a displaced sphere and a rough PBR material; another game
 * would pair it with a scanned mesh). `PopulationWorld` takes the pair, so a preset is dropped into
 * `types: [{ ...populationPreset("rocks"), geometry, material }]`.
 *
 * Ids are part of the seed stream (`POPULATION_CHUNK_LEVEL + id`), so they are stable and distinct
 * here: two types that shared an id would scatter identically and a preset that changed its id would
 * silently re-place every instance in every saved world. The six presets own 1..6; a scene adding a
 * seventh type starts at 7.
 *
 * What each type is for, and why its numbers are what they are:
 *
 *  - **rocks** — the ground-cover default: dense, small, biased toward the small end
 *    (`scaleExponent` 1.7 gives many pebbles and the occasional slab), tolerant of slope (scree).
 *  - **boulders** — the same shape an order of magnitude up: sparse (a 2×2 candidate grid), only on
 *    flattish ground, sunk a quarter of their height so they read as settled rather than balanced.
 *  - **debris** — chips and fragments: the densest type, the steepest slope tolerance (talus collects
 *    at the foot of slopes), the tightest draw distance (a 30 cm shard is pixels past 200 m) and no
 *    shadows, because a shadow map full of slivers costs more than it reads.
 *  - **vegetation** — tufts and shrubs: flatter ground only (plants do not root on a 35° scree face),
 *    a shallow embed so the base sits *at* the surface, and no shadows — the geometry is thin
 *    double-sided blades, whose shadow-map silhouette is a solid blob rather than a plant.
 *  - **decals** — flat ground marks (scorch, damp, dust traps): a small lift off the surface instead
 *    of an embed, so the quad never shares the terrain's depth values, the tightest slope limit (a
 *    flat quad on a slope is visibly a floating sheet), no shadows, and a short draw distance.
 *  - **props** — the sparse set-dressing type: at most one per chunk, near-full scale, long draw
 *    distance and shadows on, because a prop is a landmark rather than texture.
 */

import type { PopulationTypeSpec } from "./scatter.js";

/** Stable type ids: folded into the chunk seed, so they are part of a world's identity. */
export const POPULATION_TYPE_IDS = {
  rock: 1,
  boulder: 2,
  debris: 3,
  vegetation: 4,
  decal: 5,
  prop: 6,
} as const;

export type PopulationPresetName = keyof typeof POPULATION_TYPE_IDS;

/** The six types, in id order. Frozen data — copy through {@link populationPreset} to override. */
export const POPULATION_PRESETS: Readonly<Record<PopulationPresetName, PopulationTypeSpec>> = {
  rock: {
    id: POPULATION_TYPE_IDS.rock,
    label: "rocks",
    densityGrid: 6,
    scaleMin: 0.3,
    scaleMax: 1.7,
    scaleExponent: 1.7,
    slopeLimit: 0.55,
    tintJitter: 0.3,
    embed: 0.15,
    maxDistance: 550,
  },
  boulder: {
    id: POPULATION_TYPE_IDS.boulder,
    label: "boulders",
    densityGrid: 2,
    scaleMin: 0.6,
    scaleMax: 1.4,
    slopeLimit: 0.4,
    tintJitter: 0.25,
    embed: 0.25,
    maxDistance: 800,
  },
  debris: {
    id: POPULATION_TYPE_IDS.debris,
    label: "debris",
    densityGrid: 8,
    maxPerChunk: 40,
    scaleMin: 0.15,
    scaleMax: 0.7,
    scaleExponent: 2.2,
    slopeLimit: 0.75,
    tintJitter: 0.35,
    embed: 0.3,
    castShadow: false,
    maxDistance: 220,
  },
  vegetation: {
    id: POPULATION_TYPE_IDS.vegetation,
    label: "vegetation",
    densityGrid: 5,
    scaleMin: 0.6,
    scaleMax: 1.5,
    scaleExponent: 1.4,
    slopeLimit: 0.35,
    tintJitter: 0.3,
    embed: 0.05,
    castShadow: false,
    maxDistance: 400,
  },
  decal: {
    id: POPULATION_TYPE_IDS.decal,
    label: "decals",
    densityGrid: 3,
    scaleMin: 1.2,
    scaleMax: 4,
    scaleExponent: 1.2,
    slopeLimit: 0.2,
    tintJitter: 0.35,
    embed: 0,
    lift: 0.06,
    castShadow: false,
    maxDistance: 300,
  },
  prop: {
    id: POPULATION_TYPE_IDS.prop,
    label: "props",
    densityGrid: 1,
    maxPerChunk: 1,
    scaleMin: 0.9,
    scaleMax: 1.2,
    slopeLimit: 0.25,
    tintJitter: 0.1,
    embed: 0.12,
    maxDistance: 1200,
  },
};

/** Every preset name, in id order (the table's own key order). */
export const POPULATION_PRESET_NAMES = Object.keys(POPULATION_PRESETS) as PopulationPresetName[];

/**
 * A copy of one preset, with overrides applied — the way a scene takes a type's placement rules and
 * keeps its own geometry/material. Copying matters: `POPULATION_PRESETS` is shared, so mutating a
 * preset in one scene would move every other scene's instances (and its ids must never drift). An
 * override whose value is `undefined` is ignored rather than erasing the preset's own, so
 * `populationPreset("rocks", { maxDistance: quality?.rocks })` keeps the default when the caller has
 * no opinion.
 */
export function populationPreset(name: PopulationPresetName, overrides: Partial<PopulationTypeSpec> = {}): PopulationTypeSpec {
  const preset = POPULATION_PRESETS[name];
  if (!preset) throw new Error(`population: unknown preset "${name}" (known: ${POPULATION_PRESET_NAMES.join(", ")})`);
  const spec: PopulationTypeSpec = { ...preset };
  const target = spec as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    target[key] = value;
  }
  if (spec.id !== preset.id) throw new Error(`population: preset "${name}" must keep id ${preset.id} (got ${spec.id}) — the id is part of the chunk seed`);
  return spec;
}
