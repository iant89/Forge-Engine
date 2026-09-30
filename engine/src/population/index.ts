/**
 * World population (Phase 14): dense instanced scatter without per-object ECS entities.
 *
 *  - `scatter.ts` — the pure deterministic placement function (Phase 14.1).
 *  - `world.ts` — `PopulationWorld`, the terrain-following population streamer (Phase 14.6).
 *  - `../scene/population.ts` — the seam the renderer consumes: compact SoA instance blocks
 *    (Phase 14.3) and the submission/collector/source interfaces. It lives in `scene` beside
 *    `SceneObject` so `rendering` reaches it through its existing scene dependency.
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
  POPULATION_INSTANCE_FLOATS,
  PopulationInstanceBlock,
  isPopulationSource,
  type PopulationCollector,
  type PopulationSource,
  type PopulationSubmission,
} from "../scene/population.js";
