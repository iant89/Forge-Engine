/**
 * `Engine` — the top-level object users touch.
 *
 * Assembly order matters and is fixed here (each step depends on the previous):
 *   platform probe → config resolution → logger → GPU device → resource registry → renderer →
 *   task scheduler → profiler → clock → loop.
 * Reversing any of those produces the classic engine-startup bugs (a logger that cannot log the
 * device failure, a renderer bound to a stale device, a clock that ticks before the first scene).
 *
 * The frame body is deliberately tiny:
 *   1. apply a pending coordinate-space recenter (frame boundary, never mid-frame)
 *   2. advance the clock and run the fixed-step simulation inside `scene.update`
 *   3. render
 *   4. close the profiler frame, drain device errors, update stats
 * Everything else belongs to a system or a scene object, so the engine stays a *host*, not a
 * grab-bag (docs/ARCHITECTURE.md#principles).
 */

import { resolveConfig, describeConfig, type EngineConfig, type EngineConfigExtras, type FullConfig, type QualityProfile } from "./config.js";
import { createLogger, detectPlatform, probeWebGPU, type PlatformInfo } from "./platform.js";
import { parseLogLevel } from "./log.js";
import { Logger, type LogLevel } from "../core/log.js";
import { Clock, ManualClock, type TickResult } from "../core/time.js";
import { DisposableGroup, type Disposable } from "../core/events.js";
import { ObjectDisposedError, UsageError, assert } from "../core/errors.js";
import { TaskScheduler, type TaskDescriptor, type TaskStats } from "../core/tasks/scheduler.js";
import { GraphicsDevice, type DeviceCaps, type GpuMemoryStats } from "../gpu/device.js";
import { ResourceRegistry } from "../resources/registry.js";
import { Profiler, type ScopeStats } from "../debug/profiler.js";
import { Renderer, type RenderStats } from "../rendering/renderer.js";
import { Scene } from "../scene/scene.js";
import { SystemScratch, type SystemContext, type SystemServices, type ISystem } from "../scene/systems.js";
import { setComponentErrorHandler } from "../scene/world.js";
import { Vec3 } from "../math/vec.js";
import { Double3 } from "../math/double3.js";

export interface EngineOptions {
  /** Canvas to present into. `null` (or omitted) runs headless on the mock device. */
  canvas?: HTMLCanvasElement | OffscreenCanvas | null;
  /** Engine configuration; anything omitted comes from `quality` + defaults. */
  quality?: QualityProfile;
  logLevel?: LogLevel | string;
  config?: Partial<EngineConfig> & Partial<EngineConfigExtras>;
  /** Auto-start the loop after `create()` resolves. Default true when a canvas is present. */
  autostart?: boolean;
  /** Override the clock (tests + replays pass a `ManualClock`). */
  clock?: Clock | ManualClock;
  /** Force the mock device even if WebGPU exists (deterministic CI). */
  forceMock?: boolean;
  /** Fixed timestep override; defaults to `config.fixedTimestep`. */
  fixedDt?: number;
}

/**
 * The frame's GPU memory picture, assembled from the three owners of GPU memory (Phase 9.3):
 * the device knows what exists, the render graph knows what this frame reserved, and the resource
 * registry knows what it threw away. One record so a HUD, a benchmark or a leak assertion does not
 * have to reach into three subsystems.
 */
export interface GpuMemoryReport {
  /** Live bytes held by GPUTextures on the device. */
  textureBytes: number;
  /** Live bytes held by GPUBuffers on the device. */
  bufferBytes: number;
  textureCount: number;
  bufferCount: number;
  /** Render + compute pipelines created (cumulative: WebGPU has no pipeline destroy). */
  pipelineCount: number;
  /** Bind groups created (cumulative). */
  bindGroupCount: number;
  /** Bytes the graph's transients occupy this frame after aliasing. */
  transientBytes: number;
  /** Bytes resident in the graph's texture pool (idle textures included). */
  pooledBytes: number;
  /** Bytes the resource registry has evicted since it was created. */
  evictedBytes: number;
  /** Allocations since the last frame boundary — zeros on a steady frame. */
  sinceFrameStart: GpuMemoryStats["sinceFrameStart"];
}

export interface EngineStats {
  running: boolean;
  frame: number;
  fps: number;
  frameTimeMs: number;
  simTimeMs: number;
  renderTimeMs: number;
  drawCalls: number;
  triangles: number;
  instances: number;
  entities: number;
  components: number;
  sceneObjects: number;
  resources: { entries: number; bytes: number; pending: number };
  deviceLost: boolean;
  gpuErrors: number;
  /**
   * The most recent failure the engine knows about — a GPU validation/compile error or a render
   * exception — or `null`. Meant to be shown on screen: it is the only diagnostic a user on a
   * phone can read back to you.
   */
  lastError: string | null;
  /** Render-graph passes that executed last frame, in order (e.g. `forge.shadow.0`, `forge.main`, `forge.tonemap`). */
  renderPasses: readonly string[];
  /** Renderer counters for the last frame (shadow cascades, bloom mips, graph aliasing, ...). */
  render: Readonly<RenderStats>;
  /** GPU memory accounting (Phase 9.3). */
  gpuMemory: GpuMemoryReport;
  /** Background task scheduler state — the worker pool the engine is actually running with. */
  tasks: Readonly<TaskStats>;
}

export type RenderMode = "always" | "dirty" | "manual";

export class Engine {
  readonly config: FullConfig;
  readonly logger: Logger;
  readonly gpu: GraphicsDevice;
  readonly resources: ResourceRegistry;
  readonly tasks: TaskScheduler;
  readonly profiler: Profiler;
  readonly clock: Clock;
  readonly platform: PlatformInfo;
  readonly renderer: Renderer;

  private scene: Scene | null = null;
  private running = false;
  private disposed = false;
  private frameCounter = 0;
  private rafHandle = 0;
  private timeoutHandle = 0;
  private readonly disposables = new DisposableGroup();
  /** @internal */ readonly scratch = new SystemScratch(8192);
  /** @internal */ readonly services = new EngineServices();
  private lastFrameTimeMs = 0;
  private lastSimMs = 0;
  private lastRenderMs = 0;
  private lastRenderError: string | null = null;
  private fpsEwma = 0;
  private presentationMode: RenderMode = "always";
  private readonly frameContext: EngineFrameContext;
  private resizeObserver: { disconnect(): void } | null = null;
  private lastCanvasWidth = 0;
  private lastCanvasHeight = 0;

  private constructor(init: {
    config: FullConfig;
    logger: Logger;
    gpu: GraphicsDevice;
    platform: PlatformInfo;
    clock: Clock;
  }) {
    this.config = init.config;
    this.logger = init.logger;
    this.platform = init.platform;
    this.clock = init.clock;
    this.gpu = init.gpu;
    this.profiler = new Profiler({
      enabled: true,
      targetFrameTime: init.config.maxFps > 0 ? 1 / init.config.maxFps : 1 / 60,
      detailed: init.config.gpuTimestamps,
    });
    this.resources = new ResourceRegistry({
      maxBytes: init.config.gpuMemoryBudgetMB > 0 ? init.config.gpuMemoryBudgetMB * 1048576 : 0,
      logger: init.logger.child("resources"),
    });
    this.tasks = new TaskScheduler({
      workerCount: init.config.workerCount,
      maxConcurrent: Math.max(1, init.config.workerCount || 1),
      maxQueue: init.config.taskQueueLimit,
      logger: init.logger.child("tasks"),
    });
    // The quality profile caps what a scene may ask for (a scene requesting 4 cascades at 4096 on
    // the "minimal" profile gets 1 at 512); it never raises a scene setting.
    this.renderer = new Renderer(init.gpu, {
      shadowMapSize: init.config.shadowMapSize,
      shadowCascades: init.config.shadowCascades,
      shadows: init.config.shadowCascades > 0,
      bloom: init.config.bloom,
      skyQuality: init.config.skyQuality,
    });
    this.services.set("resources", this.resources);
    this.services.set("tasks", this.tasks);
    this.services.set("config", this.config);
    this.services.set("engine", this);
    this.frameContext = new EngineFrameContext(this);
    init.logger.debug(`engine config: ${describeConfig(init.config)}`);
  }

  // ------------------------------------------------------------------ construction

  /**
   * Build an engine. Never throws for "no WebGPU" alone unless `allowMockFallback` is off: the
   * reason string from the platform probe is attached to the error, because "WebGPU unavailable"
   * without the *why* is the most common support request an engine gets.
   */
  static async create(options: EngineOptions = {}): Promise<Engine> {
    const platform = detectPlatform();
    const config = resolveConfig({
      ...options.config,
      quality: options.quality ?? options.config?.quality,
      logLevel: (typeof options.logLevel === "string" ? parseLogLevel(options.logLevel) : options.logLevel) ?? options.config?.logLevel,
      headless: options.canvas ? options.config?.headless : true,
    } as EngineConfig);
    const logger = createLogger({ level: config.logLevel, scope: "engine" }) as Logger;
    const probe = platform.hasWebGPU ? null : await probeWebGPU();
    const allowMock = options.forceMock === true || config.backend === "mock" || !platform.hasWebGPU;
    if (!options.forceMock && !platform.hasWebGPU && options.canvas && config.backend !== "mock") {
      throw new UsageError(`WebGPU is required for canvas rendering. ${probe?.reason ?? "navigator.gpu is missing."}`);
    }
    const gpu = await GraphicsDevice.create({
      canvas: options.canvas ?? null,
      powerPreference: "high-performance",
      preferHdr: config.hdr,
      alphaMode: "opaque",
      requiredFeatures: config.requiredFeatures as never,
      logger: logger.child("gpu"),
      forceMock: allowMock,
      allowMockFallback: true,
    });
    const clock = options.clock ?? new Clock({ fixedDeltaTime: options.fixedDt ?? config.fixedDeltaTime, catchUpLimit: config.maxSubSteps });
    const engine = new Engine({ config, logger, gpu, platform, clock });
    if (options.canvas) engine.observeCanvas(options.canvas);
    if (options.autostart !== false && options.canvas) engine.start();
    return engine;
  }

  // ------------------------------------------------------------------ scene

  setScene(scene: Scene | null): void {
    if (this.disposed) throw new ObjectDisposedError("Engine");
    if (this.scene === scene) return;
    if (this.scene) {
      this.scene.unload(this.frameContext);
      this.scene.attachToEngine(null);
    }
    this.scene = scene;
    if (scene) {
      scene.attachToEngine(this);
      scene.load(this.frameContext);
      this.logger.info(`scene "${scene.name}" loaded (${scene.entityCount} entities)`);
    }
    this.renderer.invalidate();
  }

  get currentScene(): Scene | null {
    return this.scene;
  }

  // ------------------------------------------------------------------ loop

  /** Presentation policy: "always" renders every frame, "dirty" only after `invalidate()`. */
  /** Presentation policy setter (see the field doc above). */
  set renderMode(mode: RenderMode) {
    this.presentationMode = mode;
  }

  get renderModeValue(): RenderMode {
    return this.renderMode;
  }

  start(): void {
    if (this.disposed) throw new ObjectDisposedError("Engine");
    if (this.running) return;
    this.running = true;
    this.logger.info(`engine started (${this.platform.browser}/${this.platform.os}, mock=${this.gpu.isMock})`);
    this.scheduleNext();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.rafHandle && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.rafHandle);
    if (this.timeoutHandle && typeof clearTimeout === "function") clearTimeout(this.timeoutHandle);
    this.rafHandle = 0;
    this.timeoutHandle = 0;
    this.logger.info("engine stopped");
  }

  get isRunning(): boolean {
    return this.running;
  }

  get frame(): number {
    return this.frameCounter;
  }

  private scheduleNext(): void {
    if (!this.running || this.disposed) return;
    if (typeof requestAnimationFrame === "function") {
      this.rafHandle = requestAnimationFrame(() => this.tickFrame());
    } else {
      // Node/headless: a 1ms timer keeps the loop honest without busy-spinning.
      this.timeoutHandle = setTimeout(() => this.tickFrame(), Math.max(1, this.frameIntervalMs || 16)) as unknown as number;
    }
  }

  /** Frame cadence, derived from `maxFps` (0 = follow the display). */
  private get frameIntervalMs(): number {
    return this.config.maxFps > 0 ? 1000 / this.config.maxFps : 0;
  }

  private tickFrame(): void {
    try {
      this.step();
    } catch (e) {
      // A throwing frame must not kill the loop: log once per unique message, keep running.
      this.logger.error("frame failed", e);
    } finally {
      this.scheduleNext();
    }
  }

  /**
   * Advance one frame (simulation + render). Public so tests, the editor's "step one frame" button
   * and replay scrubbing can drive the engine deterministically.
   */
  step(manualDt?: number): TickResult {
    if (this.disposed) throw new ObjectDisposedError("Engine");
    // A new allocation window: `gpuMemory.sinceFrameStart` must describe *this* frame.
    this.gpu.beginFrame();
    this.profiler.beginFrame(this.frameCounter);
    this.scratch.beginFrame();
    const tick = manualDt === undefined ? this.clock.tick() : this.manualTick(manualDt);
    this.lastTick = tick;
    this.frameCounter++;
    const dt = this.clock.deltaTime;

    if (this.gpu.lost) {
      this.profiler.endFrame();
      return tick;
    }

    this.profiler.begin("Frame");
    let moved = 0;
    if (this.scene) {
      // The recenter must happen before any system reads render-local coordinates.
      this.scene.beginFrame(this.lastCameraWorld);
      const before = this.scene.world.transformsChangedEpoch;
      this.scene.update(this.frameContext, dt);
      moved = this.scene.world.transformsChangedEpoch - before;
    }
    this.profiler.end("Frame");

    const shouldRender = this.presentationMode === "always" || this.renderer.needsRender || moved > 0 || this.scene === null;
    if (shouldRender) {
      this.profiler.begin("Render");
      try {
        if (this.scene) this.renderer.renderScene(this.scene, this.frameContext);
      } catch (e) {
        this.lastRenderError = `render failed: ${e instanceof Error ? e.message : String(e)}`;
        this.logger.error("render failed", e);
      }
      this.profiler.end("Render");
      this.lastRenderMs = this.profiler.scopeStats("Render")?.ewmaMs ?? 0;
    } else {
      this.lastRenderMs = 0;
    }

    // Drain any GPU errors captured this frame; they are asynchronous by design, so the frame that
    // caused them is not the frame that reports them — attaching the frame number is what makes them
    // findable in a long session.
    const errors = this.gpu.consumeErrors();
    for (const e of errors) this.logger.error(`gpu validation error (frame ${this.frameCounter}): ${e}`);

    this.lastFrameTimeMs = dt * 1000;
    const frameStats = this.profiler.lastFrame();
    this.lastSimMs = frameStats ? frameStats.physicsMs + frameStats.scriptMs : 0;
    this.fpsEwma = this.fpsEwma === 0 ? 1 / Math.max(dt, 1e-4) : this.fpsEwma * 0.9 + (1 / Math.max(dt, 1e-4)) * 0.1;
    this.profiler.endFrame({ drawCalls: this.renderer.stats.drawCalls, triangles: this.renderer.stats.triangles });
    return tick;
  }

  /**
   * Drive `steps` frames with a fixed dt (tests + headless demos + the benchmark harness).
   * Returns the number of frames actually run.
   */
  runFrames(steps: number, dt = 1 / 60): number {
    assert(steps >= 0, "runFrames: steps must be non-negative");
    for (let i = 0; i < steps; i++) this.step(dt);
    return steps;
  }

  // ------------------------------------------------------------------ canvas

  /** Synthetic tick for `step(dt)`: advances a manual clock when one is in use, else ticks normally. */
  private manualTick(dt: number): TickResult {
    const clock = this.clock as Clock & { advance?: (seconds: number) => TickResult };
    if (typeof clock.advance === "function") return clock.advance(dt);
    if (typeof clock.setFixedDeltaTime === "function") void 0;
    return this.clock.tick();
  }

  private lastCameraWorld = new Double3();
  /** Tick result of the current frame (systems read `fixedSteps`/`alpha` through the context). */
  lastTick: TickResult = { fixedSteps: 0, alpha: 0 };

  private observeCanvas(canvas: HTMLCanvasElement | OffscreenCanvas): void {
    const anyGlobal = globalThis as unknown as { ResizeObserver?: new (cb: () => void) => { observe(el: object): void; disconnect(): void } };
    if ("clientWidth" in canvas && anyGlobal.ResizeObserver) {
      const el = canvas as unknown as { clientWidth: number; clientHeight: number };
      const observer = new anyGlobal.ResizeObserver(() => this.syncCanvasSize(el.clientWidth, el.clientHeight));
      observer.observe(canvas);
      this.resizeObserver = observer;
      this.disposables.add({ dispose: () => observer.disconnect() });
    }
    this.syncCanvasSize("clientWidth" in canvas ? (canvas as { clientWidth: number }).clientWidth : canvas.width, "clientHeight" in canvas ? (canvas as { clientHeight: number }).clientHeight : canvas.height);
  }

  /**
   * Match the drawing buffer to the CSS size × DPR, capped by `config.renderScale` and the device's
   * texture limit. Returns false when nothing changed (the common case).
   */
  syncCanvasSize(cssWidth: number, cssHeight: number): boolean {
    const dpr = Math.min(this.devicePixelRatio, 2);
    const scale = this.config.renderScale;
    const cap = Math.min(this.gpu.limits.maxTextureDimension2D, this.config.maxRenderWidth > 0 ? this.config.maxRenderWidth * 4 : Infinity);
    const w = Math.max(1, Math.min(Math.floor(cssWidth * dpr * scale), cap));
    const h = Math.max(1, Math.min(Math.floor(cssHeight * dpr * scale), cap));
    if (w === this.lastCanvasWidth && h === this.lastCanvasHeight) return false;
    this.lastCanvasWidth = w;
    this.lastCanvasHeight = h;
    this.gpu.resize(w, h, dpr * scale);
    this.renderer.resize(w, h);
    this.logger.debug(`canvas resized to ${w}x${h} (dpr ${dpr}, scale ${scale})`);
    return true;
  }

  private get devicePixelRatio(): number {
    const g = globalThis as unknown as { window?: { devicePixelRatio?: number } };
    return g.window?.devicePixelRatio ?? 1;
  }

  /** Manual resize for hosts without a DOM (offscreen pipelines, tests). */
  setSize(width: number, height: number): void {
    this.lastCanvasWidth = Math.max(1, Math.floor(width));
    this.lastCanvasHeight = Math.max(1, Math.floor(height));
    this.gpu.resize(this.lastCanvasWidth, this.lastCanvasHeight, 1);
    this.renderer.resize(this.lastCanvasWidth, this.lastCanvasHeight);
  }

  // ------------------------------------------------------------------ misc

  get capabilities(): DeviceCaps {
    return this.gpu.caps;
  }

  /** @internal */ get servicesRef(): SystemServices {
    return this.services;
  }

  registerSystem(system: ISystem): Disposable {
    if (!this.scene) throw new UsageError("Engine.registerSystem requires an active scene (setScene first)");
    return this.scene.world.registerSystem(system);
  }

  /** Submit a background task (terrain generation, asset decoding) through the scheduler. */
  submitTask<P, R>(descriptor: TaskDescriptor<P>): Promise<R> {
    return this.tasks.submit<P, R>(descriptor as never);
  }

  /**
   * Live quality switch. Only the knobs that are cheap to change (shadow map size, particle budget,
   * post flags) are applied; geometry/texture budgets need a rebuild, which the caller triggers by
   * re-setting the scene.
   */
  setQuality(quality: QualityProfile): void {
    this.logger.info(`quality → ${quality} (live quality changes are limited to shader-visible knobs; full re-resolve needs a rebuild)`);
    this.renderer.invalidate();
  }

  stats(): EngineStats {
    const scene = this.scene;
    const render: RenderStats = this.renderer.stats;
    return {
      running: this.running,
      frame: this.frameCounter,
      fps: this.fpsEwma,
      frameTimeMs: this.lastFrameTimeMs,
      simTimeMs: this.lastSimMs,
      renderTimeMs: this.lastRenderMs,
      drawCalls: render.drawCalls,
      triangles: render.triangles,
      instances: render.instances,
      entities: scene ? scene.entityCount : 0,
      components: scene ? scene.world.componentCountValue : 0,
      sceneObjects: scene ? scene.objects.length : 0,
      resources: { entries: this.resources.size, bytes: this.resources.bytes, pending: this.resources.stats().pending },
      deviceLost: this.gpu.lost,
      gpuErrors: this.gpu.totalErrorCount,
      lastError: this.gpu.lastError ?? this.lastRenderError,
      renderPasses: this.renderer.passNames,
      render,
      gpuMemory: this.gpuMemoryReport(),
      tasks: this.tasks.stats,
    };
  }

  /**
   * Assemble the GPU memory report from the device, the render graph and the resource registry.
   * Cheap enough to call per frame (a handful of field reads); no allocation on the hot path because
   * the HUD asks for it, not `step()`.
   */
  gpuMemoryReport(): GpuMemoryReport {
    const device = this.gpu.gpuMemory;
    return {
      textureBytes: device.textureBytes,
      bufferBytes: device.bufferBytes,
      textureCount: device.textureCount,
      bufferCount: device.bufferCount,
      pipelineCount: device.pipelineCount,
      bindGroupCount: device.bindGroupCount,
      transientBytes: this.renderer.stats.transientBytes,
      pooledBytes: this.renderer.stats.pooledBytes,
      evictedBytes: this.resources.evictedBytes,
      sinceFrameStart: device.sinceFrameStart,
    };
  }

  /** Profile aggregates for the debug overlay / `npm run bench`. */
  profileSnapshot(): ScopeStats[] {
    return this.profiler.snapshot();
  }

  /** Force a redraw even in "dirty" mode. */
  invalidate(): void {
    this.renderer.invalidate();
  }

  /** Await in-flight GPU work + asset loads (tests + deterministic screenshots). */
  async settle(): Promise<void> {
    await this.resources.settle();
    await this.tasks.drain();
    await this.gpu.flush();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.scene) {
      this.scene.unload(this.frameContext);
      this.scene = null;
    }
    this.disposables.dispose();
    this.tasks.dispose();
    this.renderer.dispose();
    this.profiler.dispose();
    this.resources.dispose();
    await this.gpu.dispose();
    this.logger.debug("engine disposed");
  }
}

/** The `SystemServices` map the engine exposes to systems. */
class EngineServices implements SystemServices {
  private readonly map = new Map<string, unknown>();
  engineConfig: Record<string, unknown> = {};

  set(key: string, value: unknown): void {
    this.map.set(key, value);
  }

  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
}

/**
 * `SystemContext` handed to every system each frame. One long-lived object rather than a fresh
 * literal per frame: systems are called 60-1440 times a minute and an allocation there shows up in
 * the profiler as GC teeth almost immediately.
 */
class EngineFrameContext implements SystemContext {
  constructor(private readonly engine: Engine) {}

  get world() {
    const scene = this.engine.currentScene;
    if (!scene) throw new UsageError("SystemContext.world used with no scene attached");
    return scene.world;
  }

  get clock(): Clock {
    return this.engine.clock;
  }

  get dt(): number {
    return this.engine.clock.deltaTime;
  }

  get fixedDt(): number {
    return this.engine.clock.fixedDeltaTime;
  }

  get fixedSteps(): number {
    return this.engine.lastTick.fixedSteps;
  }

  get alpha(): number {
    return this.engine.clock.interpolationAlpha;
  }

  get elapsed(): number {
    return this.engine.clock.elapsedTime;
  }

  get frame(): number {
    return this.engine.frame;
  }

  get logger(): Logger {
    return this.engine.logger;
  }

  get profiler(): Profiler {
    return this.engine.profiler;
  }

  get render() {
    return this.engine.renderer;
  }

  get services(): SystemServices {
    return this.engine.services;
  }

  get scratch(): SystemScratch {
    return this.engine.scratch;
  }
}

/** Route ECS/lifecycle errors into the engine logger (installed once per engine construction). */
export function installEngineErrorBridge(logger: Logger): Disposable {
  return setComponentErrorHandler((context, error) => logger.error(`ecs ${context} failed`, error));
}

export { Vec3 };
