/**
 * Phase 22.2 rendering benchmark matrix.
 *
 * This is deliberately a host-safe matrix: the mock device records the same render-graph, draw,
 * shadow and allocation work that the browser path submits, while the CPU twins cover the arithmetic
 * that a mock GPU cannot execute. The benchmark never treats one stopwatch sample as a compatibility
 * claim; guards assert work shape, aliasing, culling/lighting coverage, finite shadow fits, and clean
 * GPU accounting. Phase 22.7 consumes the rows and host metadata for comparable-history decisions.
 */

import {
  BufferUsage,
  Camera,
  GraphicsDevice,
  Material,
  Mat4,
  RenderGraph,
  type RenderGraphHandle,
  Renderable,
  Renderer,
  Scene,
  TextureUsage,
  Vec3,
  computeCascades,
  computePointShadow,
  computeSpotShadow,
  createBox,
  createPointShadowFaces,
  fitShadowMapSize,
  shadowAtlasBytes,
  type Cascade,
  type CascadeCameraParams,
  type CascadeOptions,
  type PointShadowFit,
  type SpotShadowFit,
} from "@forge/engine";
import type { BenchmarkResult } from "./ecs.bench.ts";

export interface RenderingBenchmarkOptions {
  /** Separate material batches used by the draw-submission sweep. */
  drawCounts?: readonly number[];
  /** Transient render-graph passes used by the aliasing sweep. */
  graphPasses?: readonly number[];
  /** Repeated shadow-fit iterations. */
  shadowIterations?: number;
  /** Repeated allocation frames. */
  memoryIterations?: number;
  /** Median samples for the mock draw and render-graph rows. */
  twinRuns?: number;
}

export interface DrawSubmissionTiming {
  requestedBatches: number;
  submittedBatches: number;
  drawCalls: number;
  durationMs: number;
}

export interface DrawSubmissionBenchmarkReport {
  results: BenchmarkResult[];
  timings: DrawSubmissionTiming[];
}

export interface RenderGraphTiming {
  declaredPasses: number;
  executedPasses: number;
  culledPasses: number;
  transientTextures: number;
  physicalTextures: number;
  aliasedBytes: number;
  pooledBytes: number;
  durationMs: number;
}

export interface RenderGraphBenchmarkReport {
  results: BenchmarkResult[];
  timings: RenderGraphTiming[];
}

export interface ShadowBenchmarkReport {
  results: BenchmarkResult[];
  iterations: number;
  cascadeMs: number;
  spotMs: number;
  pointMs: number;
  fittedMapSize: number;
  fittedAtlasBytes: number;
  fittedBudgetBytes: number;
}

export interface GpuMemoryBenchmarkReport {
  results: BenchmarkResult[];
  iterations: number;
  allocationsPerFrame: number;
  peakBytes: number;
  peakResources: number;
  remainingBytes: number;
  remainingResources: number;
  textureAllocations: number;
  bufferAllocations: number;
}

export interface RenderingBenchmarkReport {
  results: BenchmarkResult[];
  draw: DrawSubmissionBenchmarkReport;
  graph: RenderGraphBenchmarkReport;
  shadows: ShadowBenchmarkReport;
  memory: GpuMemoryBenchmarkReport;
  notes: string[];
}

interface DrawFixture {
  device: GraphicsDevice;
  renderer: Renderer;
  scene: Scene;
  geometry: ReturnType<typeof createBox>;
  materials: Material[];
  renderables: Renderable[];
  dispose(): Promise<void>;
}

const RENDER_WIDTH = 320;
const RENDER_HEIGHT = 180;
const GRAPH_WIDTH = 640;
const GRAPH_HEIGHT = 360;
const GRAPH_FORMAT: GPUTextureFormat = "rgba8unorm";
const GRAPH_USAGE = TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING;
const SHADOW_BUDGET = 16 * 1024 * 1024;
const DEFAULT_DRAW_COUNTS = [16, 64, 256];
const DEFAULT_GRAPH_PASSES = [8, 32, 64];
const DEFAULT_SHADOW_ITERATIONS = 256;
const DEFAULT_MEMORY_ITERATIONS = 32;
const DEFAULT_ALLOCATIONS_PER_FRAME = 32;

function result(name: string, count: number, durationMs: number): BenchmarkResult {
  return {
    name,
    count,
    durationMs,
    opsPerSec: count / Math.max(durationMs / 1000, 1e-9),
  };
}

function median(samples: readonly number[]): number {
  const ordered = [...samples].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)] ?? 0;
}

function timed(runs: number, fn: () => void): number {
  const samples: number[] = [];
  // Warm the code path and make each sample large enough to survive the clock resolution without
  // multiplying the graph/device workload by an unbounded adaptive factor.
  fn();
  for (let i = 0; i < Math.max(1, runs); i++) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return median(samples);
}

function configureBenchmarkScene(scene: Scene): void {
  scene.settings.skyEnabled = false;
  scene.settings.hdr = false;
  scene.settings.postProcessing = false;
  scene.settings.shadow.enabled = false;
  scene.settings.depthPrepass = false;
  scene.settings.ssao.enabled = false;
  scene.settings.clusteredLighting = false;
  scene.settings.bloom.enabled = false;
}

async function createDrawFixture(maxBatches: number): Promise<DrawFixture> {
  const device = await GraphicsDevice.create({ forceMock: true });
  device.resize(RENDER_WIDTH, RENDER_HEIGHT);
  const renderer = new Renderer(device, {
    shadows: false,
    sky: false,
    bloom: false,
    depthPrepass: false,
    ssao: false,
    clusteredLighting: false,
    objectCulling: "cpu",
    lightCulling: "cpu",
    indirectDraws: false,
    asyncPipelines: false,
  });
  const scene = new Scene({ name: "phase22-rendering-benchmark" });
  configureBenchmarkScene(scene);

  const cameraEntity = scene.createTransformedEntity("camera", new Vec3(0, 4, -18));
  const camera = new Camera();
  camera.near = 0.1;
  camera.far = 500;
  scene.world.addComponent(cameraEntity.id, camera);
  cameraEntity.transform.lookAt(new Vec3(0, 1, 4));

  const geometry = createBox(device, { width: 0.18, height: 0.18, depth: 0.18 });
  const materials: Material[] = [];
  const renderables: Renderable[] = [];
  const side = Math.max(1, Math.ceil(Math.sqrt(maxBatches)));
  for (let i = 0; i < maxBatches; i++) {
    // Keep the entire sweep in the camera's central cone so the measured batch count is the requested
    // count rather than an accidental frustum-cull count. Distinct material identities deliberately
    // prevent the renderer from merging these into one draw while sharing one pipeline key.
    const x = ((i % side) - (side - 1) / 2) * 0.24;
    const z = 2 + Math.floor(i / side) * 0.24;
    const entity = scene.createTransformedEntity(`draw-${i}`, new Vec3(x, 1 + (i % 3) * 0.12, z));
    const material = new Material({ label: `phase22.material.${i}`, color: 0x305070 + ((i * 0x030701) & 0x7f7f7f) });
    const renderable = new Renderable();
    renderable.geometry = geometry;
    renderable.material = material;
    renderable.castShadow = false;
    scene.world.addComponent(entity.id, renderable);
    materials.push(material);
    renderables.push(renderable);
  }

  return {
    device,
    renderer,
    scene,
    geometry,
    materials,
    renderables,
    async dispose() {
      scene.dispose();
      renderer.dispose();
      geometry.dispose();
      for (const material of materials) material.dispose();
      await device.dispose();
    },
  };
}

async function runDrawSubmissionBenchmark(counts: readonly number[], runs: number): Promise<DrawSubmissionBenchmarkReport> {
  const max = Math.max(...counts, 1);
  const fixture = await createDrawFixture(max);
  const timings: DrawSubmissionTiming[] = [];
  try {
    // The first frame compiles pipelines and creates graph resources. It is intentionally outside the
    // timed samples: 22.2 measures steady draw submission, while allocation churn belongs to the graph
    // and GPU-memory rows below.
    for (const renderable of fixture.renderables) renderable.visible = true;
    fixture.renderer.renderScene(fixture.scene);
    for (const requestedBatches of counts) {
      for (let i = 0; i < fixture.renderables.length; i++) fixture.renderables[i]!.visible = i < requestedBatches;
      const durationMs = timed(runs, () => fixture.renderer.renderScene(fixture.scene));
      const submittedBatches = fixture.renderer.stats.batches;
      const drawCalls = fixture.renderer.stats.drawCalls;
      timings.push({ requestedBatches, submittedBatches, drawCalls, durationMs });
    }
  } finally {
    await fixture.dispose();
  }
  return {
    timings,
    results: timings.map((timing) => result(`draw submission ${timing.requestedBatches} batches (mock frame)`, timing.requestedBatches, timing.durationMs)),
  };
}

function graphFrame(graph: RenderGraph, swap: GPUTexture, passCount: number): RenderGraphTiming {
  graph.begin();
  const swapHandle = graph.importTexture("benchmark.swapchain", swap);
  let previous: RenderGraphHandle | null = null;
  for (let i = 0; i < passCount; i++) {
    const current = graph.createTexture(`benchmark.transient.${i}`, {
      width: GRAPH_WIDTH,
      height: GRAPH_HEIGHT,
      format: GRAPH_FORMAT,
      usage: GRAPH_USAGE,
    });
    graph.addPass({
      name: `benchmark.render.${i}`,
      reads: previous === null ? [] : [previous],
      color: [{ texture: current }],
      execute: (ctx) => {
        const pass = ctx.beginRenderPass();
        pass.end();
      },
    });
    previous = current;
  }
  const dead = graph.createTexture("benchmark.dead", { width: GRAPH_WIDTH, height: GRAPH_HEIGHT, format: GRAPH_FORMAT, usage: GRAPH_USAGE });
  graph.addPass({
    name: "benchmark.dead-pass",
    color: [{ texture: dead }],
    execute: (ctx) => {
      const pass = ctx.beginRenderPass();
      pass.end();
    },
  });
  graph.addPass({
    name: "benchmark.present",
    reads: previous === null ? [] : [previous],
    color: [{ texture: swapHandle }],
    execute: (ctx) => {
      const pass = ctx.beginRenderPass();
      pass.end();
    },
  });
  const stats = graph.execute();
  return {
    declaredPasses: stats.passes,
    executedPasses: stats.executed.length,
    culledPasses: stats.culledPasses,
    transientTextures: stats.transientTextures,
    physicalTextures: stats.physicalTextures,
    aliasedBytes: stats.aliasedBytes,
    pooledBytes: stats.pooledBytes,
    durationMs: 0,
  };
}

async function runRenderGraphBenchmark(passCounts: readonly number[], runs: number): Promise<RenderGraphBenchmarkReport> {
  const device = await GraphicsDevice.create({ forceMock: true });
  const graph = new RenderGraph(device, { retireAfterFrames: 2 });
  const swap = device.createTexture({ label: "benchmark.swapchain", size: { width: GRAPH_WIDTH, height: GRAPH_HEIGHT }, format: GRAPH_FORMAT, usage: GRAPH_USAGE });
  const timings: RenderGraphTiming[] = [];
  try {
    for (const passCount of passCounts) {
      // Build once to warm the graph's pool, then time complete describe/compile/record/submit frames.
      graphFrame(graph, swap, passCount);
      const samples: number[] = [];
      let latest: RenderGraphTiming | null = null;
      for (let i = 0; i < Math.max(1, runs); i++) {
        const start = performance.now();
        latest = graphFrame(graph, swap, passCount);
        samples.push(performance.now() - start);
      }
      const timing = latest!;
      timing.durationMs = median(samples);
      timings.push(timing);
    }
  } finally {
    graph.dispose();
    swap.destroy();
    await device.dispose();
  }
  return {
    timings,
    results: timings.map((timing) => result(`render graph compile + submit ${timing.declaredPasses} declared passes`, timing.declaredPasses, timing.durationMs)),
  };
}

function shadowCamera(): CascadeCameraParams {
  const world = new Mat4().setLookAt(new Vec3(0, 5, -18), new Vec3(0, 1, 5), new Vec3(0, 1, 0));
  world.invert();
  return {
    world,
    fovY: Math.PI / 3,
    aspect: 16 / 9,
    near: 0.1,
    orthographic: false,
    orthoHeight: 20,
  };
}

function shadowOptions(): CascadeOptions {
  return {
    count: 4,
    shadowDistance: 160,
    lambda: 0.6,
    mapSize: 2048,
    lightDirection: new Vec3(-0.4, -0.8, 0.2).normalize(),
  };
}

function assertFiniteMatrix(matrix: Mat4, label: string): void {
  for (const value of matrix.m) if (!Number.isFinite(value)) throw new Error(`${label} produced a non-finite matrix`);
}

function runShadowBenchmark(iterations: number): ShadowBenchmarkReport {
  const count = Math.max(1, Math.floor(iterations));
  const camera = shadowCamera();
  const options = shadowOptions();
  const cascades: Cascade[] = [];
  const spot: SpotShadowFit = { viewProj: new Mat4(), fovY: 0, near: 0, far: 0, texelSize: 0, worldTexelScale: 0 };
  const point: PointShadowFit = { faces: createPointShadowFaces(), near: 0, far: 0, texelSize: 0, worldTexelScale: 0 };
  const position = new Vec3(4, 8, -3);
  const direction = new Vec3(-0.3, -0.9, 0.15);
  const cascadeMs = timed(3, () => {
    for (let i = 0; i < count; i++) computeCascades(camera, options, cascades);
  });
  const spotMs = timed(3, () => {
    for (let i = 0; i < count; i++) if (!computeSpotShadow(position, direction, 0.55, 80, 1024, spot)) throw new Error("spot shadow fit rejected valid input");
  });
  const pointMs = timed(3, () => {
    for (let i = 0; i < count; i++) if (!computePointShadow(position, 50, 1024, point)) throw new Error("point shadow fit rejected valid input");
  });
  assertFiniteMatrix(cascades[0]!.viewProj, "cascade");
  assertFiniteMatrix(spot.viewProj, "spot shadow");
  for (const [i, face] of point.faces.entries()) assertFiniteMatrix(face.viewProj, `point face ${i}`);

  const fittedMapSize = fitShadowMapSize(2048, 10, SHADOW_BUDGET);
  const fittedAtlasBytes = shadowAtlasBytes(fittedMapSize, 10);
  const results = [
    result("shadow cascade fit ×4", count * 4, cascadeMs),
    result("spot shadow fit", count, spotMs),
    result("point shadow fit ×6 faces", count * 6, pointMs),
  ];
  return { results, iterations: count, cascadeMs, spotMs, pointMs, fittedMapSize, fittedAtlasBytes, fittedBudgetBytes: SHADOW_BUDGET };
}

async function runGpuMemoryBenchmark(iterations: number, allocationsPerFrame = DEFAULT_ALLOCATIONS_PER_FRAME): Promise<GpuMemoryBenchmarkReport> {
  const device = await GraphicsDevice.create({ forceMock: true });
  const frames = Math.max(1, Math.floor(iterations));
  const allocations = Math.max(1, Math.floor(allocationsPerFrame));
  let peakBytes = 0;
  let peakResources = 0;
  let textureAllocations = 0;
  let bufferAllocations = 0;
  const samples: number[] = [];
  for (let frame = 0; frame < frames; frame++) {
    const start = performance.now();
    device.beginFrame();
    const textures: GPUTexture[] = [];
    const buffers: GPUBuffer[] = [];
    for (let i = 0; i < allocations; i++) {
      textures.push(device.createTexture({ label: `benchmark.texture.${i}`, size: { width: 64, height: 64 }, format: "rgba8unorm", usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING }));
      buffers.push(device.createBuffer({ label: `benchmark.buffer.${i}`, size: 4096, usage: BufferUsage.STORAGE | BufferUsage.COPY_DST }));
      textureAllocations++;
      bufferAllocations++;
    }
    const memory = device.gpuMemory;
    peakBytes = Math.max(peakBytes, memory.textureBytes + memory.bufferBytes);
    peakResources = Math.max(peakResources, memory.textureCount + memory.bufferCount);
    for (const texture of textures) texture.destroy();
    for (const buffer of buffers) buffer.destroy();
    samples.push(performance.now() - start);
  }
  const durationMs = median(samples);
  const remaining = device.gpuMemory;
  const report: GpuMemoryBenchmarkReport = {
    results: [result(`GPU allocation accounting (${allocations} textures + buffers/frame)`, frames * allocations * 2, durationMs)],
    iterations: frames,
    allocationsPerFrame: allocations,
    peakBytes,
    peakResources,
    remainingBytes: remaining.textureBytes + remaining.bufferBytes,
    remainingResources: remaining.textureCount + remaining.bufferCount,
    textureAllocations,
    bufferAllocations,
  };
  await device.dispose();
  return report;
}

/** Run the Phase 22.2 renderer-owned matrix. The runner composes the existing culling and lighting twins alongside it. */
export async function runRenderingBenchmark(options: RenderingBenchmarkOptions = {}): Promise<RenderingBenchmarkReport> {
  const draw = await runDrawSubmissionBenchmark(options.drawCounts ?? DEFAULT_DRAW_COUNTS, options.twinRuns ?? 5);
  const graph = await runRenderGraphBenchmark(options.graphPasses ?? DEFAULT_GRAPH_PASSES, options.twinRuns ?? 5);
  const shadows = runShadowBenchmark(options.shadowIterations ?? DEFAULT_SHADOW_ITERATIONS);
  const memory = await runGpuMemoryBenchmark(options.memoryIterations ?? DEFAULT_MEMORY_ITERATIONS);
  return {
    results: [...draw.results, ...graph.results, ...shadows.results, ...memory.results],
    draw,
    graph,
    shadows,
    memory,
    notes: [],
  };
}

/** Shape and catastrophe guards for Phase 22.2. */
export function assertRenderingBenchmark(report: RenderingBenchmarkReport): string[] {
  const notes: string[] = [];
  if (report.draw.timings.length < 2) throw new Error("rendering benchmark needs at least two draw-submission sizes");
  for (const timing of report.draw.timings) {
    if (timing.submittedBatches !== timing.requestedBatches) throw new Error(`draw submission requested ${timing.requestedBatches}, submitted ${timing.submittedBatches}`);
    if (timing.drawCalls !== timing.requestedBatches) throw new Error(`draw submission issued ${timing.drawCalls} calls for ${timing.requestedBatches} batches`);
    if (!(timing.durationMs > 0) || !Number.isFinite(timing.durationMs)) throw new Error(`draw submission did not produce a timing for ${timing.requestedBatches} batches`);
  }
  const drawLast = report.draw.timings[report.draw.timings.length - 1]!;
  notes.push(`draw submission: ${drawLast.submittedBatches} batches → ${drawLast.drawCalls} draw calls in ${drawLast.durationMs.toFixed(2)} ms`);

  const graphLast = report.graph.timings[report.graph.timings.length - 1];
  if (!graphLast) throw new Error("rendering benchmark produced no render-graph timing");
  if (graphLast.culledPasses !== 1) throw new Error(`render graph culled ${graphLast.culledPasses} dead passes, expected 1`);
  if (!(graphLast.physicalTextures < graphLast.transientTextures)) throw new Error(`render graph did not alias transients (${graphLast.physicalTextures}/${graphLast.transientTextures})`);
  if (!(graphLast.aliasedBytes > 0) || !(graphLast.pooledBytes > 0)) throw new Error("render graph did not report aliased and pooled bytes");
  notes.push(`render graph: ${graphLast.declaredPasses} declared / ${graphLast.executedPasses} executed, ${graphLast.physicalTextures} physical textures for ${graphLast.transientTextures} transients, ${graphLast.aliasedBytes} bytes aliased`);

  const shadows = report.shadows;
  if (!(shadows.fittedAtlasBytes <= shadows.fittedBudgetBytes)) throw new Error(`shadow atlas exceeds its budget (${shadows.fittedAtlasBytes}/${shadows.fittedBudgetBytes} bytes)`);
  if (!(shadows.fittedMapSize < 2048)) throw new Error("shadow budget benchmark did not reduce the over-budget atlas");
  notes.push(`shadow fits: ${shadows.iterations} cascade/spot/point iterations, atlas ${shadows.fittedMapSize}px / ${shadows.fittedAtlasBytes} bytes within ${shadows.fittedBudgetBytes} bytes`);

  const memory = report.memory;
  if (memory.textureAllocations !== memory.iterations * memory.allocationsPerFrame || memory.bufferAllocations !== memory.textureAllocations) throw new Error("GPU memory benchmark lost an allocation accounting event");
  if (!(memory.peakBytes > 0) || memory.peakResources !== memory.allocationsPerFrame * 2) throw new Error(`GPU memory benchmark peak was ${memory.peakResources} resources / ${memory.peakBytes} bytes`);
  if (memory.remainingBytes !== 0 || memory.remainingResources !== 0) throw new Error(`GPU memory benchmark leaked ${memory.remainingResources} resources / ${memory.remainingBytes} bytes`);
  notes.push(`GPU memory: ${memory.textureAllocations + memory.bufferAllocations} allocations, peak ${memory.peakBytes} bytes, zero remaining`);
  return notes;
}
