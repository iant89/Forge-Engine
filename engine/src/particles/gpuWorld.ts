/**
 * Scene-object owner for the Phase 12 GPU particle system.
 *
 * Unlike {@link ParticleWorld}, this never creates or poses sprite entities — the GPU buffer is the
 * authority and the renderer draws billboards from it. Attach at most one GPU particle world per
 * scene (the renderer picks the first ready instance).
 */

import { SceneObject } from "../scene/scene.js";
import type { SystemContext } from "../scene/systems.js";
import type { GraphicsDevice } from "../gpu/device.js";
import type { RenderGraph, RenderGraphHandle } from "../rendering/renderGraph.js";
import { Mat4 } from "../math/mat.js";
import { GpuParticleSystem, type GpuParticleSystemOptions } from "./gpuSystem.js";

export interface GpuParticleWorldOptions extends GpuParticleSystemOptions {
  name?: string;
}

export class GpuParticleWorld extends SceneObject {
  readonly name: string;
  private readonly options: GpuParticleWorldOptions;
  private _system: GpuParticleSystem | null = null;
  private gpu: GraphicsDevice | null = null;
  private lastDt = 1 / 60;
  /** Latched when init throws; stops per-frame attachDevice from dispose/recreate forever. */
  private initFailed = false;
  /** True while an async init is in flight. */
  private initPending = false;
  private initPromise: Promise<void> | null = null;
  /** Bumped on every attach that starts a new init; stale finally/catch must not clear newer state. */
  private attachGeneration = 0;

  constructor(options: GpuParticleWorldOptions) {
    super();
    this.name = options.name ?? "gpu-particles";
    this.options = options;
  }

  /** The live GPU system once {@link attachDevice} has completed init; null beforehand. */
  get system(): GpuParticleSystem | null {
    return this._system;
  }

  /** True after a failed init until {@link clearAttachFailure} or a different device is attached. */
  get attachFailed(): boolean {
    return this.initFailed;
  }

  /**
   * Bind the engine GPU device and kick off pipeline creation.
   * On failure, latches an error state and does not retry on subsequent calls for the same device
   * (the renderer invokes this every frame). Call {@link clearAttachFailure} to allow a retry.
   * Returns a promise that settles when init finishes (callers may ignore it).
   */
  attachDevice(gpu: GraphicsDevice): Promise<void> {
    if (this.gpu === gpu && this._system?.ready) return Promise.resolve();
    if (this.gpu === gpu && this.initFailed) return Promise.resolve();
    if (this.gpu === gpu && this.initPending && this.initPromise) return this.initPromise;
    if (this.gpu !== gpu) {
      this.initFailed = false;
    }
    this.gpu = gpu;
    if (this._system) this._system.dispose();
    const system = new GpuParticleSystem(gpu, this.options);
    this._system = system;
    const generation = ++this.attachGeneration;
    this.initPending = true;
    this.initFailed = false;
    this.initPromise = system
      .init()
      .catch((err) => {
        // Ignore stale attaches that were superseded by a later attachDevice call.
        if (generation !== this.attachGeneration) return;
        this.initFailed = true;
        // Free any buffers allocated before the rejection; keep _system for latch identity.
        system.dispose();
        console.error("GpuParticleWorld init failed", err);
      })
      .finally(() => {
        // Only the matching attach clears pending — a superseded init must not unlock a newer one.
        if (generation === this.attachGeneration) {
          this.initPending = false;
        }
      });
    return this.initPromise;
  }

  /** Allow the next {@link attachDevice} call to retry after a latched failure. */
  clearAttachFailure(): void {
    this.initFailed = false;
  }

  override update(context: SystemContext, dt: number): void {
    this.lastDt = dt > 0 ? dt : this.lastDt;
    // GPU emit/sim/cull/render only run inside renderer.renderScene. Under Engine renderMode
    // "dirty", finishFrame clears invalidated after the first draw; a static camera then skips
    // render forever and particle.sim stalls. Keep continuous GPU particle scenes ticking.
    if (this._system?.ready) context.render?.invalidate();
  }

  /**
   * Write uniforms for this frame. Called by the renderer immediately before the graph builds the
   * particle passes. `viewProj` is column-major (engine {@link Mat4}).
   */
  prepareFrame(input: {
    dt?: number;
    viewProj: Float32Array | number[] | Mat4;
    cameraPos: { x: number; y: number; z: number };
    /** Camera world-space right axis (from camera world/view, not viewProj columns). */
    cameraRight: { x: number; y: number; z: number };
    /** Camera world-space up axis (from camera world/view, not viewProj columns). */
    cameraUp: { x: number; y: number; z: number };
  }): void {
    const system = this._system;
    if (!system?.ready) return;
    const vp = input.viewProj instanceof Mat4 ? input.viewProj.elements() : (input.viewProj as Float32Array);
    // Require explicit basis: viewProj columns are not camera axes under perspective.
    system.prepare({
      dt: input.dt ?? this.lastDt,
      viewProj: vp,
      cameraPos: input.cameraPos,
      cameraRight: input.cameraRight,
      cameraUp: input.cameraUp,
    });
  }

  /** Enqueue particle.sim / sort / render / resolve. No-op until init finishes. */
  enqueue(
    graph: RenderGraph,
    opts: {
      color: RenderGraphHandle;
      depth: RenderGraphHandle;
      colorFormat: GPUTextureFormat;
      depthFormat: GPUTextureFormat;
    },
  ): void {
    this._system?.enqueue(graph, opts);
  }

  override stats(): Record<string, number | string | boolean> {
    return this._system ? { ...this._system.stats(), name: this.name } : { name: this.name, ready: false };
  }

  override dispose(): void {
    // Invalidate any in-flight attach so a later attachDevice(same device) cannot early-return
    // the stale initPromise while _system is already null.
    this.attachGeneration++;
    this.initPending = false;
    this.initPromise = null;
    this.initFailed = false;
    this.gpu = null;
    this._system?.dispose();
    this._system = null;
  }
}

/** Find the first GPU particle world on a scene, if any. */
export function findGpuParticleWorld(scene: { objects: readonly SceneObject[] }): GpuParticleWorld | undefined {
  for (const o of scene.objects) {
    if (o instanceof GpuParticleWorld) return o;
  }
  return undefined;
}
