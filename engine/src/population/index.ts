/**
 * World population (Phase 14): dense instanced scatter without per-object ECS entities.
 *
 *  - `scatter.ts` — the pure deterministic placement function (Phase 14.1).
 *  - `presets.ts` — the six population types as engine data (Phase 14.2): rocks, boulders, debris,
 *    vegetation, decals and props, each a placement spec with a stable id and no geometry of its own.
 *  - `world.ts` — `PopulationWorld`, the terrain-following population streamer (Phase 14.6), and the
 *    residency keys/versions that let the renderer keep a chunk's instance records on the device
 *    instead of recomposing them every frame (Phase 14.3).
 *  - `../scene/population.ts` — the seam the renderer consumes: compact SoA instance blocks
 *    (Phase 14.3) and the submission/collector/source interfaces. It lives in `scene` beside
 *    `SceneObject` so `rendering` reaches it through its existing scene dependency.
 *
 * GPU-selected object LOD (Phase 14.4) lives in `rendering/`: a chain on `Geometry`, and the
 * selection inside `rendering/objectCulling.ts`'s pass. Populations get it by handing the renderer a
 * chained geometry — nothing here changes.
 */

export {
  POPULATION_CHUNK_LEVEL,
  scatterPopulationChunk,
  resolvePopulationTypeSpec,
  type PopulationSurfaceSampler,
  type PopulationTypeSpec,
  type ResolvedPopulationTypeSpec,
} from "./scatter.js";
export { PopulationWorld, type PopulationType, type PopulationWorldOptions } from "./world.js";
export {
  POPULATION_PRESETS,
  POPULATION_PRESET_NAMES,
  POPULATION_TYPE_IDS,
  populationPreset,
  type PopulationPresetName,
} from "./presets.js";
export {
  POPULATION_INSTANCE_FLOATS,
  PopulationInstanceBlock,
  isPopulationSource,
  type PopulationCollector,
  type PopulationSource,
  type PopulationSubmission,
} from "../scene/population.js";
