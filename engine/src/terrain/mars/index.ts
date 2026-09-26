/**
 * Mars terrain port — the dev-time generator `mars-terrain-gen` as a Forge terrain source.
 *
 * `MarsTerrainStage` rebuilds the generator's analytic surface per vertex (craters, volcanoes,
 * dichotomy, canyon, cinder cones, detail band) and applies the generator's Stage A erosion
 * correction sampled from its ~30 MB `cache/global/` field cache, so the same Mars appears at any
 * `chunkSize`/`chunkResolution` with Forge's own LOD, skirts and collision. See
 * `docs/MARS-TERRAIN.md` for the integration recipe and `adviseMarsTile` for sizing.
 *
 * Internal transcription details (`noise3.ts`, `geology.ts`) are deliberately not exported: they
 * mirror the generator file-for-file, and re-exporting them into the engine barrel would collide
 * with the engine's own `perlin3`/`fbm3` and invite use as general-purpose noise.
 */

export {
  MARS_FACE_COUNT,
  MARS_FACE_NX,
  MARS_FACE_NY,
  MARS_FACE_NZ,
  MARS_FACE_PX,
  MARS_FACE_PY,
  MARS_FACE_PZ,
  marsAngularDistanceMeters,
  marsDepthForChunkEdge,
  marsDepthForChunkEdgeAtMost,
  marsDirectionToFaceUV,
  marsFaceCentreChunkEdgeMeters,
  marsFaceUVToDirection,
  marsLatLonOfDirection,
  marsLatLonToDirection,
  marsNormalize,
  type MarsFaceUV,
} from "./cubeSphere.js";

export {
  MARS_GEN_PARAMS,
  MARS_GRAVITY,
  MARS_RADIUS_M,
  MARS_STAGE_A_DEFAULTS,
  createMarsGenParams,
  marsStageACellMeters,
  type MarsGenParams,
  type MarsGenParamsOverrides,
} from "./config.js";

export {
  MARS_CRATER_SCALES,
  MARS_MATERIAL_COUNT,
  MARS_MATERIAL_HARDNESS,
  MarsCraterScanner,
  MarsMaterial,
  marsFineDetail,
  marsSampleAnalytic,
  marsSampleCinderCones,
  marsSampleCraterDelta,
  marsSampleRegionalBase,
  marsSampleVolcanoDelta,
  type MarsAnalyticSample,
  type MarsCanyonSegment,
  type MarsCraterScale,
  type MarsDichotomyConfig,
  type MarsGenParamsLike,
  type MarsVolcanoDef,
} from "./geology.js";

export {
  MarsGlobalFieldSet,
  fetchMarsFaceFields,
  marsFaceFieldsFromBuffers,
  sampleMarsGlobalFields,
  type MarsFaceFieldBuffers,
  type MarsFaceFields,
  type MarsGlobalSample,
} from "./globalFields.js";

export {
  MARS_SITE_PRESETS,
  MarsSite,
  MarsTerrainStage,
  adviseMarsTile,
  createMarsPipeline,
  marsSurfaceLayers,
  type MarsSiteOptions,
  type MarsSitePreset,
  type MarsTerrainStageOptions,
  type MarsTileAdvice,
  type MarsTileDetailLevel,
} from "./stage.js";
