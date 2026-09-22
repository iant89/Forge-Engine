/**
 * Forge Engine — public API surface.
 *
 * Everything a game or tool needs is re-exported here; nothing else is stable API. If a symbol is
 * only reachable through a deep path (`forge-engine/gpu/layout`), treat it as internal.
 *
 * Importing this module has one side effect you should know about: it registers the engine's
 * built-in component types with the component registry (see `scene/components/index.ts`). That is
 * why `registerComponent` ids are stable — the barrel always imports them in this order.
 */

// Math
export * from "./math/index.js";

// Core
export { Engine, type EngineOptions, type EngineStats, type RenderMode, installEngineErrorBridge } from "./core/engine.js";
export {
  QUALITY_PROFILES,
  resolveConfig,
  describeConfig,
  type EngineConfig,
  type EngineConfigExtras,
  type QualityProfile,
  type ResolvedConfig,
  type FullConfig,
  type BackendPreference,
} from "./core/config.js";
export { Clock, ManualClock, RateLimiter, type TickResult, type ClockOptions } from "./core/time.js";
export {
  ForgeError,
  UsageError,
  CapabilityError,
  UnsupportedPlatformError,
  AssetError,
  ResourceLifecycleError,
  InternalError,
  ObjectDisposedError,
  assert,
  assertDefined,
  assertPositive,
  assertInRange,
  assertInt,
  assertNever,
  assertionsEnabledValue,
  setAssertionsEnabled,
} from "./core/errors.js";
export { Logger, LogLevel, parseLogLevel, ConsoleSink, LogBuffer, type LogLevel as Level, type LogRecord, type LogSink } from "./core/log.js";
export { EventTarget2, EventBus, Signal, DisposableGroup, type Disposable, type Listener } from "./core/events.js";
export { ObjectPool, FreeList, IntStack, FloatArena, FloatBuffer, Uint16Buffer, Uint32Buffer, growTyped, makeHandle, handleSlot, handleGeneration, type Poolable, type PoolOptions } from "./core/pool.js";
export { detectPlatform, probeWebGPU, getNavigatorGpu, createLogger, type PlatformInfo } from "./core/platform.js";
export { TaskScheduler, TaskPriority, TaskCancelledError, type TaskDescriptor, type TaskSchedulerOptions, type TaskStats } from "./core/tasks/scheduler.js";
export { registerTaskHandler, registerBuiltinTaskHandlers, listTaskHandlers, hasTaskHandler, type TaskContext, type TaskHandler } from "./core/tasks/registry.js";
export {
  generateHeightfield,
  bakeSlopeField,
  scatterPoints,
  generateNoiseTile,
  BUILTIN_TASK_NAMES,
  type HeightfieldTaskPayload,
  type HeightfieldTaskResult,
  type ScatterTaskPayload,
  type ScatterTaskResult,
  type SlopeFieldTaskPayload,
  type SlopeFieldTaskResult,
  type NoiseTileTaskPayload,
  type NoiseTileTaskResult,
  type BuiltinHandlerTable,
} from "./core/tasks/taskHandlers.js";

// GPU
export { GraphicsDevice, type DeviceCaps, type EngineLimits, type GraphicsDeviceOptions } from "./gpu/device.js";
export { ShaderCache, preprocessWgsl, validateWgsl, type WgslIssue, type ShaderStats } from "./gpu/shaderCache.js";
export { BufferBuilder, StructAccessor, WriteBuffer, FloatAccessor } from "./gpu/bufferWriter.js";
export { StructDef, diffWgslStruct, alignOf, sizeOf, strideOf, f32, i32, u32, bool_, vec2, vec3, vec4, mat2x2, mat3x3, mat4x4, arrayOf, ofStruct, type AddressSpace, type FieldType } from "./gpu/layout.js";
export {
  BufferUsage,
  TextureUsage,
  ShaderStage,
  ColorWriteMask,
  COPY_BYTES_PER_ROW_ALIGNMENT,
  COPY_BUFFER_ALIGNMENT,
  MIN_OFFSET_ALIGNMENT,
  OPTIONAL_FEATURES,
  combineUsages,
  combineTextureUsages,
  combineStages,
  describeFeature,
  type FeatureKey,
} from "./gpu/constants.js";
export {
  formatInfo,
  isKnownFormat,
  vertexFormatSize,
  textureSizeBytes,
  subresourceBytes,
  bytesPerRow,
  alignedBytesPerRow,
  maxMipLevels,
  pickHdrFormat,
  preferredSwapchainFormats,
  READABLE_DEPTH_FORMATS,
  type FormatInfo,
} from "./gpu/formats.js";

// Resources
export { ResourceRegistry, ResourceHandle, type ResourceDescriptor, type ResourceState, type ResourceLoadContext } from "./resources/registry.js";
export { Texture, TextureDefaults, type TextureDesc } from "./resources/texture.js";

// Scene / ECS
export { Scene, SceneObject, defaultSceneSettings, type SceneSettings, type SceneShadowSettings, type SceneFogSettings, type SerializedScene, type RaycastResult, type FogMode, type ToneMapping } from "./scene/scene.js";
export { EntityWorld, Entity, TransformHandle, setComponentErrorHandler } from "./scene/world.js";
export { Component, registerComponent, componentInfo, componentTypeById, allComponentTypes, resetComponentRegistry, type ComponentTypeInfo, type RegisterComponentOptions, type DeserializationContext } from "./scene/components.js";
export { Transform, Renderable, Camera, Light, AudioSource, BUILTIN_COMPONENT_NAMES, sphereBounds } from "./scene/components/index.js";
export { System, FixedSystem, TransformSystem, SystemScratch, type ISystem, type SystemContext, type SystemServices } from "./scene/systems.js";
export { Query, ObjectStore, StructStore, type ComponentStorage, type QueryWorld } from "./scene/stores.js";
export { NULL_ENTITY, entitySlot, entityGeneration, makeEntityId, describeEntity, type EntityId } from "./scene/entityId.js";
export { CoordinateSpace, type CoordinateSpaceOptions } from "./scene/coordinateSpace.js";
export type { RenderFrameContext, PickResult, SkyParams } from "./scene/renderContext.js";

// Terrain
export * from "./terrain/index.js";

// Physics
export * from "./physics/index.js";

// Vehicles (phase 6) and particles (phase 7). Imported here so their components register once.
export * from "./vehicles/index.js";
export * from "./particles/index.js";

// Rendering
export { Renderer, type RendererOptions, type RenderStats } from "./rendering/renderer.js";
export {
  RenderGraph,
  type RenderGraphHandle,
  type RenderGraphTextureDesc,
  type RenderGraphViewDesc,
  type RenderGraphColorAttachment,
  type RenderGraphDepthAttachment,
  type RenderGraphPassContext,
  type RenderGraphPassDesc,
  type RenderGraphStats,
  type RenderGraphOptions,
} from "./rendering/renderGraph.js";
export { computeCascadeSplits, frustumSliceCorners, computeCascades, type Cascade, type CascadeCameraParams, type CascadeOptions } from "./rendering/shadows.js";
export { PipelineFactory, type PipelineKeyOptions } from "./rendering/pipeline.js";
export { Geometry, VERTEX_LAYOUT, VERTEX_STRIDE, computeNormalsAndTangents, type GeometrySource } from "./rendering/geometry.js";
export { Mesh, type Submesh, type SkinBinding } from "./rendering/mesh.js";
export { Material, MaterialLibrary, type MaterialOptions, type MaterialTechnique } from "./rendering/material.js";
export {
  boxGeometrySource,
  planeGeometrySource,
  sphereGeometrySource,
  cylinderGeometrySource,
  coneGeometrySource,
  torusGeometrySource,
  createBox,
  createPlane,
  createSphere,
  createCylinder,
  createTorus,
  type BoxOptions,
  type PlaneOptions,
  type SphereOptions,
  type CylinderOptions,
} from "./rendering/primitives.js";
export { PerFrameUniforms, LightUniforms, LightBlock, ShadowUniforms, ShadowPassUniforms, MaterialUniforms, ObjectUniforms, InstanceStruct, PostUniforms, RENDERING_STRUCTS, MAX_LIGHTS_PER_FRAME, MAX_CASCADES, structSize } from "./rendering/uniforms.js";
export { STANDARD_VERTEX, STANDARD_INSTANCED_VERTEX, STANDARD_FRAGMENT_BODY, DEPTH_VERTEX, DEBUG_SHADER, BLIT_SHADER, BINDINGS } from "./rendering/shaders/standard.js";
export { POST_SHADER, POST_BINDINGS, POST_FLAG_BLOOM, POST_FLAG_KARIS, POST_FLAG_NO_TONEMAP } from "./rendering/shaders/post.js";
export { WGSL_COLOR, WGSL_FULLSCREEN_VERTEX } from "./rendering/shaders/common.js";

// Debug + testing
export { Profiler, ProfileScope, profile, type ProfilerOptions, type ScopeStats, type FrameRecord } from "./debug/profiler.js";
export { createMockGpu, MockGPUDevice, MockGPUAdapter, type MockGpuOptions } from "./testing/mockGpu.js";

/** The engine's version, kept in one place (the package manifest is the source of truth). */
export const VERSION = "0.1.0";
