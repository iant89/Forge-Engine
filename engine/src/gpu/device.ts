/**
 * `GraphicsDevice` — the only place in the engine that talks to `navigator.gpu`.
 *
 * Responsibilities, in the order they matter:
 *  1. **Capability truth.** Adapter features/limits are read once, intersected with what the engine
 *     can actually use, and exposed as booleans (`caps.depthClipControl`, `caps.timestampQuery`, …).
 *     Every subsystem asks the device instead of probing the adapter, so a feature gate is decided
 *     in exactly one place (see ADR-002 "capability-driven degradation").
 *  2. **A single typed seam for the mock.** `createMockGpu()` satisfies this class's needs; the
 *     boundary is one `as unknown as GPUDevice` cast with a comment, so no other file in the engine
 *     ever needs a cast to survive the test double (and mock-only fields cannot leak into real code).
 *  3. **Error scopes.** Validation errors are collected per frame and surfaced through the logger +
 *     `device.consumeErrors()`, because WebGPU reports them asynchronously and a silent error scope
 *     leak is the classic "why is nothing rendering" trap. Errors that no scope captures
 *     (`uncapturederror`: a pipeline built from a module the browser's compiler rejected, an
 *     invalid submit) and shader compile diagnostics are recorded through the same channel, so
 *     `lastError` always names the first thing that went wrong — on a phone with no devtools that
 *     string is the whole bug report.
 *  4. **Device loss.** `lost` flips, listeners run, and everything that renders checks the flag —
 *     a lost device must degrade to a paused canvas, not a stream of exceptions.
 */

import { UnsupportedPlatformError, CapabilityError, ResourceLifecycleError, UsageError } from "../core/errors.js";
import { getNavigatorGpu } from "../core/platform.js";
import type { Logger } from "../core/log.js";
import { OPTIONAL_FEATURES, describeFeature, type FeatureKey, TextureUsage } from "./constants.js";
import { preferredSwapchainFormats, pickHdrFormat, isKnownFormat, formatInfo } from "./formats.js";
import { createMockGpu, type MockGPUDevice, type MockGPUAdapter } from "../testing/mockGpu.js";

function this0Format(): GPUTextureFormat | undefined {
  const gpu = (globalThis as unknown as { navigator?: { gpu?: { getPreferredCanvasFormat?(): GPUTextureFormat } } }).navigator?.gpu;
  return gpu?.getPreferredCanvasFormat?.();
}

export interface DeviceCaps {
  depthClipControl: boolean;
  textureCompressionBc: boolean;
  textureCompressionEtc2: boolean;
  textureCompressionAstc: boolean;
  float32Filterable: boolean;
  timestampQuery: boolean;
  indirectFirstInstance: boolean;
  pipelineStatisticsQuery: boolean;
  rg11b10Renderable: boolean;
  /** Max colour attachments the engine will actually use (≤4 in practice). */
  maxColorAttachments: number;
}

export interface EngineLimits {
  maxTextureDimension2D: number;
  maxUniformBufferBindingSize: number;
  maxStorageBufferBindingSize: number;
  maxVertexAttributes: number;
  maxBufferSize: number;
  maxBindGroups: number;
  maxSampledTexturesPerShaderStage: number;
  maxColorAttachments: number;
}

export interface GraphicsDeviceOptions {
  canvas?: HTMLCanvasElement | OffscreenCanvas | null;
  powerPreference?: "low-power" | "high-performance";
  /** Required features; anything else is requested from `OPTIONAL_FEATURES` and tolerated absent. */
  requiredFeatures?: readonly FeatureKey[];
  /** Limits the engine needs (clamped down by the adapter's actual values). */
  requiredLimits?: Partial<Record<keyof EngineLimits, number>>;
  /** Request an HDR-capable float render target for the main colour pass. */
  preferHdr?: boolean;
  alphaMode?: "opaque" | "premultiplied";
  /**
   * When true (default in tests/headless), fall back to the strict mock device instead of throwing
   * if `navigator.gpu` is unavailable.
   */
  allowMockFallback?: boolean;
  logger?: Logger | null;
  /** Device-lost handler (the engine re-creates the renderer on top of this). */
  onLost?: (reason: string) => void;
  /** Force the mock even when a real adapter exists (used by `npm test`). */
  forceMock?: boolean;
}

export interface SwapchainInfo {
  width: number;
  height: number;
  devicePixelRatio: number;
  format: GPUTextureFormat;
}

export class GraphicsDevice {
  private constructor(
    readonly adapter: GPUAdapter | null,
    readonly device: GPUDevice,
    readonly context: GPUCanvasContext | MockCanvasContextLike | null,
    readonly isMock: boolean,
    readonly logger: Logger | null,
    readonly options: GraphicsDeviceOptions,
  ) {
    this.caps = probeCaps(this.adapter, this.device);
    this.limits = probeLimits(this.adapter, this.device);
    this.format = pickSwapchainFormat(this.adapter);
    this.hdrFormat = options.preferHdr ? pickHdrFormat((f) => isKnownFormat(f) && formatInfo(f).renderable).format : null;
    this.depthFormat = "depth24plus";
    this.configureCanvas(this.pixelWidth, this.pixelHeight);
    // Tolerate devices that do not expose `lost` as a promise (older shells, and the mock, which
    // keeps a boolean `lost` flag): construction must not depend on that member's shape.
    const rawLost: unknown = (this.device as { lost?: unknown }).lost;
    const dev = this.device as unknown as { lostPromise?: unknown };
    const lostPromise: Promise<GPUDeviceLostInfo> | undefined = rawLost instanceof Promise
      ? (rawLost as Promise<GPUDeviceLostInfo>)
      : dev.lostPromise instanceof Promise
        ? (dev.lostPromise as Promise<GPUDeviceLostInfo>)
        : undefined;
    this.lostPromise = lostPromise
      ? lostPromise.then((info) => {
          this._lost = true;
          this._lostReason = info?.reason ?? "unknown";
          for (const fn of this.lostHandlers) {
            try {
              fn(this._lostReason);
            } catch {
              /* a lost-device listener must not break the others */
            }
          }
        })
      : new Promise<void>(() => {});
    // Errors outside any scope would otherwise only reach the browser console. Recording them keeps
    // `stats().gpuErrors`/`lastError` truthful on every browser, including ones with no console.
    const target = this.device as unknown as { addEventListener?: (type: string, listener: (event: unknown) => void) => void };
    if (typeof target.addEventListener === "function") {
      try {
        target.addEventListener("uncapturederror", (event) => {
          const error = (event as { error?: { message?: string; constructor?: { name?: string } } }).error;
          const kind = error?.constructor?.name ?? "GPUError";
          this.recordError("uncaptured error", `${kind}: ${error?.message ?? String(error)}`);
        });
      } catch {
        /* a device that cannot register listeners still works; it just reports less */
      }
    }
    if (this.isMock) {
      this.logger?.info("gpu: using mock device (headless; validation is strict, rasterization is not)");
    }
  }

  readonly caps: DeviceCaps;
  readonly limits: EngineLimits;
  readonly format: GPUTextureFormat;
  readonly hdrFormat: GPUTextureFormat | null;
  readonly depthFormat: GPUTextureFormat;
  readonly features = new Set<string>();
  readonly lostHandlers = new Set<(reason: string) => void>();

  private _lost = false;
  private _lostReason = "";
  private readonly lostPromise: Promise<void>;
  private swapchain: SwapchainInfo = { width: 1, height: 1, devicePixelRatio: 1, format: "bgra8unorm" };
  private samplerCache = new Map<string, GPUSampler>();
  private bindGroupLayoutCache = new Map<string, GPUBindGroupLayout>();
  private pipelineLayoutCache = new Map<string, GPUPipelineLayout>();
  private openScopes = 0;
  private errorCount = 0;
  private readonly collectedErrors: string[] = [];
  private _lastError: string | null = null;
  private buffersCreated = 0;
  private texturesCreated = 0;

  get lost(): boolean {
    return this._lost;
  }

  get lostReason(): string {
    return this._lostReason;
  }

  /** Resolves when the device is lost (never, for a healthy device). */
  get onLostPromise(): Promise<void> {
    return this.lostPromise;
  }

  onLost(fn: (reason: string) => void): { dispose(): void } {
    this.lostHandlers.add(fn);
    return {
      dispose: () => {
        this.lostHandlers.delete(fn);
      },
    };
  }

  get pixelWidth(): number {
    return this.swapchain.width;
  }

  get pixelHeight(): number {
    return this.swapchain.height;
  }

  get aspect(): number {
    return this.swapchain.height > 0 ? this.swapchain.width / this.swapchain.height : 1;
  }

  /** The mock device, typed. Throws if this is a real adapter (guards test-only assertions). */
  get mock(): MockGPUDevice {
    if (!this.isMock) throw new CapabilityError("GraphicsDevice.mock is only available when running on the mock device");
    return this.device as unknown as MockGPUDevice;
  }

  get mockAdapter(): MockGPUAdapter | null {
    return this.isMock ? (this.adapter as unknown as MockGPUAdapter | null) : null;
  }

  /** @internal */
  get currentTexture(): GPUTexture | null {
    const ctx = this.context as { getCurrentTexture?(): GPUTexture | null } | null;
    return ctx?.getCurrentTexture?.() ?? null;
  }

  static async create(options: GraphicsDeviceOptions = {}): Promise<GraphicsDevice> {
    const gpu = getNavigatorGpu();
    if (!gpu || options.forceMock) {
      if (!options.allowMockFallback && !options.forceMock) {
        throw new UnsupportedPlatformError(
          "WebGPU is not available in this environment (navigator.gpu is missing). Use { allowMockFallback: true } for headless tests.",
        );
      }
      const mock = createMockGpu({ strict: true, preferredCanvasFormat: this0Format() });
      const canvas = options.canvas as { width?: number; height?: number } | undefined;
      mock.canvas.width = Math.max(1, Math.floor(canvas?.width ?? 1280));
      mock.canvas.height = Math.max(1, Math.floor(canvas?.height ?? 720));
      const device = mock.device as unknown as GPUDevice;
      const gd = new GraphicsDevice(
        mock.adapter as unknown as GPUAdapter,
        device,
        mock.context as unknown as GPUCanvasContext,
        true,
        options.logger ?? null,
        options,
      );
      gd.recordFeatures(mock.adapter as unknown as GPUAdapter);
      return gd;
    }
    let adapter: GPUAdapter | null = null;
    try {
      adapter = await gpu.requestAdapter({ powerPreference: options.powerPreference ?? "high-performance" });
    } catch (e) {
      throw new UnsupportedPlatformError(`navigator.gpu.requestAdapter() threw: ${describeError(e)}`, { cause: e });
    }
    if (!adapter) {
      throw new UnsupportedPlatformError("No WebGPU adapter is available (requestAdapter returned null). The GPU may be blocked, or the browser has WebGPU disabled.");
    }
    const required = new Set<string>(options.requiredFeatures ?? []);
    const optional: string[] = [];
    for (const key of Object.keys(OPTIONAL_FEATURES) as FeatureKey[]) {
      if (required.has(key)) continue;
      if (adapter.features.has(key)) optional.push(key);
    }
    for (const f of optional) required.add(f);
    const unsupported = [...(options.requiredFeatures ?? [])].filter((f) => !adapter!.features.has(f));
    if (unsupported.length > 0) {
      throw new CapabilityError(`Required WebGPU features are unavailable: ${unsupported.map((f) => describeFeature(f)).join(", ")}`, { missing: unsupported });
    }
    const limits = clampLimits(adapter.limits, options.requiredLimits ?? {});
    let device: GPUDevice;
    try {
      device = await adapter.requestDevice({ requiredFeatures: [...required] as never, requiredLimits: limits as never });
    } catch (e) {
      throw new UnsupportedPlatformError(`adapter.requestDevice() failed: ${describeError(e)}`, { cause: e });
    }
    const gd = new GraphicsDevice(adapter, device, null, false, options.logger ?? null, options);
    gd.recordFeatures(adapter);
    if (options.canvas) gd.attachCanvas(options.canvas);
    return gd;
  }

  private recordFeatures(adapter: GPUAdapter | null): void {
    if (!adapter) return;
    for (const f of adapter.features as unknown as Iterable<string>) this.features.add(f);
  }

  /** Attach (or re-attach) the canvas used for presentation. No-op for the mock device. */
  attachCanvas(canvas: HTMLCanvasElement | OffscreenCanvas): void {
    if (this.isMock) return;
    const anyCanvas = canvas as unknown as { getContext?(id: string, options?: unknown): unknown };
    const ctx = anyCanvas.getContext?.("webgpu") as GPUCanvasContext | null;
    if (!ctx) throw new UnsupportedPlatformError("canvas.getContext('webgpu') returned null — is this a WebGPU-capable browser?");
    (this as { context: GPUCanvasContext | MockCanvasContextLike | null }).context = ctx;
    const w = "width" in canvas ? (canvas.width as number) : 1280;
    const h = "height" in canvas ? (canvas.height as number) : 720;
    this.configureCanvas(w, h);
  }

  /** Resize the drawing buffer (CSS size × DPR is the caller's job; pass device pixels). */
  resize(width: number, height: number, devicePixelRatio = 1): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    const changed = w !== this.swapchain.width || h !== this.swapchain.height || devicePixelRatio !== this.swapchain.devicePixelRatio;
    this.swapchain.devicePixelRatio = devicePixelRatio;
    const canvas = (this.context as { canvas?: { width: number; height: number } } | null)?.canvas;
    if (canvas) {
      canvas.width = w;
      canvas.height = h;
    }
    if (!changed) return;
    this.configureCanvas(w, h);
    this.logger?.debug(`gpu: swapchain ${w}x${h} @${devicePixelRatio}`);
  }

  private configureCanvas(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    this.swapchain.width = w;
    this.swapchain.height = h;
    this.swapchain.format = this.format;
    if (!this.context) return;
    try {
      this.context.configure({
        device: this.device,
        format: this.format,
        usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.COPY_SRC,
        alphaMode: this.options.alphaMode ?? "opaque",
      } as never);
    } catch (e) {
      throw new ResourceLifecycleError(`failed to configure the WebGPU canvas context: ${describeError(e)}`, { width: w, height: h });
    }
  }

  get swapchainInfo(): Readonly<SwapchainInfo> {
    return this.swapchain;
  }

  // ------------------------------------------------------------------ allocation

  createBuffer(descriptor: GPUBufferDescriptor): GPUBuffer {
    if (descriptor.size <= 0) throw new UsageError(`createBuffer: size must be > 0 (got ${descriptor.size})`);
    if (descriptor.size % 4 !== 0) throw new UsageError(`createBuffer: size ${descriptor.size} is not a multiple of 4`);
    const buffer = this.device.createBuffer(descriptor);
    this.buffersCreated++;
    return buffer;
  }

  createTexture(descriptor: GPUTextureDescriptor): GPUTexture {
    // `GPUExtent3D` is a union: `{width,height,depthOrArrayLayers}` or `[w, h?, d?]` or a bare
    // number. Callers legitimately use either, so normalise here instead of forcing one shape on
    // everyone (and instead of the confusing "size.width must be a positive integer" for a perfectly
    // valid array form).
    const raw = descriptor.size as unknown;
    const dims = Array.isArray(raw)
      ? { width: Number(raw[0]), height: raw[1] === undefined ? undefined : Number(raw[1]), depthOrArrayLayers: raw[2] === undefined ? undefined : Number(raw[2]) }
      : typeof raw === "number"
        ? { width: raw, height: undefined, depthOrArrayLayers: undefined }
        : (raw as { width: number; height?: number; depthOrArrayLayers?: number });
    if (typeof dims.width !== "number" || dims.width <= 0) throw new UsageError("createTexture: size.width must be a positive integer");
    if (!isKnownFormat(descriptor.format)) throw new CapabilityError(`createTexture: unsupported format "${descriptor.format}"`);
    if (descriptor.mipLevelCount !== undefined && descriptor.mipLevelCount < 1) throw new UsageError("createTexture: mipLevelCount must be at least 1");
    const texture = this.device.createTexture(descriptor);
    this.texturesCreated++;
    return texture;
  }

  /** Renderability check used by format picking (the mock validates this too). */
  isRenderable(format: GPUTextureFormat): boolean {
    return formatInfo(format).renderable;
  }

  /**
   * Cached samplers by semantic name. The engine uses a small fixed set; creating a sampler per
   * material would blow the per-frame bind-group cost budget.
   */
  sampler(kind: "point-clamp" | "linear-clamp" | "linear-repeat" | "anisotropic" | "shadow" | "comparison"): GPUSampler {
    const cached = this.samplerCache.get(kind);
    if (cached) return cached;
    const desc: GPUSamplerDescriptor =
      kind === "shadow" || kind === "comparison"
        ? { addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", magFilter: "nearest", minFilter: "nearest", compare: kind === "shadow" ? "less" : "less-equal" }
        : kind === "point-clamp"
          ? { addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", magFilter: "nearest", minFilter: "nearest" }
          : kind === "linear-repeat"
            ? { addressModeU: "repeat", addressModeV: "repeat", magFilter: "linear", minFilter: "linear" }
            : kind === "anisotropic"
              ? { addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", magFilter: "linear", minFilter: "linear", maxAnisotropy: Math.min(8, this.limits.maxTextureDimension2D > 0 ? 16 : 1) }
              : { addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", magFilter: "linear", minFilter: "linear" };
    const sampler = this.device.createSampler(desc);
    this.samplerCache.set(kind, sampler);
    return sampler;
  }

  /** Layout dedupe: two identical layouts must share a handle or bind groups cannot be reused. */
  bindGroupLayout(key: string, entries: () => GPUBindGroupLayoutEntry[]): GPUBindGroupLayout {
    let l = this.bindGroupLayoutCache.get(key);
    if (!l) {
      l = this.device.createBindGroupLayout({ entries: entries() } as never);
      this.bindGroupLayoutCache.set(key, l);
    }
    return l;
  }

  pipelineLayout(key: string, layouts: readonly GPUBindGroupLayout[]): GPUPipelineLayout {
    let l = this.pipelineLayoutCache.get(key);
    if (!l) {
      l = this.device.createPipelineLayout({ bindGroupLayouts: [...layouts] } as never);
      this.pipelineLayoutCache.set(key, l);
    }
    return l;
  }

  // ------------------------------------------------------------------ error scopes

  /** Push a validation/error scope. Every `beginErrorScope` must be matched by an `end`. */
  beginErrorScope(filter: GPUErrorFilter = "validation"): void {
    if (this.openScopes > 16) throw new ResourceLifecycleError("beginErrorScope without a matching endErrorScope (16 deep)");
    this.device.pushErrorScope(filter);
    this.openScopes++;
  }

  /** Pop one scope and return the error it captured, if any. */
  async endErrorScope(): Promise<string | null> {
    if (this.openScopes === 0) throw new ResourceLifecycleError("endErrorScope() without beginErrorScope()");
    this.openScopes--;
    const error = await this.device.popErrorScope();
    if (!error) return null;
    const message = `${(error as GPUError).constructor?.name ?? "GPUError"}: ${error.message}`;
    this.recordError("error scope", message);
    return message;
  }

  /**
   * Record a GPU-side failure that did not come through an error scope: uncaptured validation
   * errors, shader compiler diagnostics, anything asynchronous the engine learns about later. It
   * counts towards `totalErrorCount`, is drained by `consumeErrors()` and is kept as `lastError`.
   */
  recordError(context: string, message: string): void {
    this.errorCount++;
    this._lastError = message;
    this.collectedErrors.push(message);
    if (this.collectedErrors.length > 64) this.collectedErrors.shift();
    this.reportError(context, message);
  }

  /** The most recent GPU error message, or `null` if the device has never reported one. */
  get lastError(): string | null {
    return this._lastError;
  }

  /** Wrap an action in an error scope and throw if it produced one (used in tests + init paths). */
  async assertClean<T>(label: string, fn: () => T | Promise<T>, filter: GPUErrorFilter = "validation"): Promise<T> {
    this.beginErrorScope(filter);
    let result: T;
    try {
      result = await fn();
    } catch (e) {
      await this.endErrorScope().catch(() => null);
      throw e;
    }
    const err = await this.endErrorScope();
    if (err) throw new UsageError(`${label} produced a WebGPU ${filter} error: ${err}`);
    return result;
  }

  /** Drain and return any collected error strings (the engine logs them once per frame). */
  consumeErrors(): string[] {
    if (this.collectedErrors.length === 0) return [];
    return this.collectedErrors.splice(0, this.collectedErrors.length);
  }

  get totalErrorCount(): number {
    return this.errorCount;
  }

  /** Mock-only leak accounting; on a real device these are the engine's own counters. */
  memoryStats(): { buffers: number; textures: number; buffersCreated: number; texturesCreated: number; bytes: number } {
    if (this.isMock) {
      const m = this.mock.memoryStats as { buffers?: number; textures?: number; bytes?: number } | undefined;
      return {
        buffers: m?.buffers ?? 0,
        textures: m?.textures ?? 0,
        buffersCreated: this.buffersCreated,
        texturesCreated: this.texturesCreated,
        bytes: m?.bytes ?? 0,
      };
    }
    return { buffers: 0, textures: 0, buffersCreated: this.buffersCreated, texturesCreated: this.texturesCreated, bytes: 0 };
  }

  /**
   * Await queued work. On the mock this resolves after the queue drains (which is what makes the
   * validation assertions meaningful in tests); on a real device it uses `onSubmittedWorkDone`.
   */
  async flush(): Promise<void> {
    await this.device.queue.onSubmittedWorkDone();
  }

  /** Best-effort teardown. Safe to call twice. */
  async dispose(): Promise<void> {
    if (this._lost) return;
    try {
      await this.device.queue.onSubmittedWorkDone();
    } catch {
      /* device already gone */
    }
    this.samplerCache.clear();
    this.bindGroupLayoutCache.clear();
    this.pipelineLayoutCache.clear();
    this.lostHandlers.clear();
    try {
      this.device.destroy();
    } catch {
      /* destroy on a lost device is a no-op in practice */
    }
    this._lost = true;
    this._lostReason = "disposed";
  }

  private reportError(context: string, error: unknown): void {
    const message = typeof error === "string" ? error : describeError(error);
    if (this.logger) this.logger.error(`gpu: ${context}: ${message}`);
    else if (typeof console !== "undefined") console.error(`[forge:gpu] ${context}: ${message}`);
  }
}

interface MockCanvasContextLike {
  configure(config: GPUCanvasConfiguration): void;
  getCurrentTexture(): GPUTexture;
  canvas?: { width: number; height: number };
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function probeCaps(adapter: GPUAdapter | null, device: GPUDevice): DeviceCaps {
  const has = (f: string): boolean => adapter?.features.has(f as never) === true || (device.features as ReadonlySet<string>).has(f);
  return {
    depthClipControl: has("depth-clip-control"),
    textureCompressionBc: has("texture-compression-bc") || has("texture-compression-bc-sliced-format"),
    textureCompressionEtc2: has("texture-compression-etc2"),
    textureCompressionAstc: has("texture-compression-astc"),
    float32Filterable: has("float32-filterable"),
    timestampQuery: has("timestamp-query"),
    indirectFirstInstance: has("indirect-first-instance"),
    pipelineStatisticsQuery: has("pipeline-statistics-query"),
    // rg11b10ufloat is renderable everywhere the engine runs today, but the *filterable* part needs
    // the feature, so HDR picking consults both.
    rg11b10Renderable: true,
    maxColorAttachments: Math.min(4, (device.limits as unknown as Record<string, number>)["maxColorAttachments"] ?? 4),
  };
}

function probeLimits(_adapter: GPUAdapter | null, device: GPUDevice): EngineLimits {
  const l = device.limits as unknown as Record<string, number | undefined>;
  const num = (key: string, fallback: number) => {
    const v = l[key];
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
  };
  return {
    maxTextureDimension2D: num("maxTextureDimension2D", 2048),
    maxUniformBufferBindingSize: num("maxUniformBufferBindingSize", 65536),
    maxStorageBufferBindingSize: num("maxStorageBufferBindingSize", 134217728),
    maxVertexAttributes: num("maxVertexAttributes", 16),
    maxBufferSize: num("maxBufferSize", 268435456),
    maxBindGroups: num("maxBindGroups", 4),
    maxSampledTexturesPerShaderStage: num("maxSampledTexturesPerShaderStage", 16),
    maxColorAttachments: num("maxColorAttachments", 4),
  };
}

function clampLimits(adapterLimits: GPUSupportedLimits, required: Partial<Record<keyof EngineLimits, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  const record = adapterLimits as unknown as Record<string, number | undefined>;
  for (const [key, wanted] of Object.entries(required) as [string, number | undefined][]) {
    if (wanted === undefined) continue;
    const actual = record[key];
    if (typeof actual !== "number") throw new CapabilityError(`WebGPU limit "${key}" is not queryable on this adapter`);
    if (wanted > actual) throw new CapabilityError(`WebGPU limit "${key}" requested ${wanted} but the adapter provides ${actual}`);
    out[key] = wanted;
  }
  return out;
}

function pickSwapchainFormat(adapter: GPUAdapter | null): GPUTextureFormat {
  const formats = preferredSwapchainFormats();
  if (!adapter) return formats[0]!;
  // `GPUAdapter` has no format query in the spec; supported formats are a browser-fixed short list,
  // so the engine's ordered preference is authoritative and the first entry always works.
  return formats[0]!;
}

export { formatInfo };
