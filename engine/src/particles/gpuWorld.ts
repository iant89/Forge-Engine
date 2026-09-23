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
import { Vec3 } from "../math/vec.js";
import { GpuParticleSystem, type GpuParticleSystemOptions } from "./gpuSystem.js";

export interface GpuParticleWorldOptions extends GpuParticleSystemOptions {
  name?: string;
}

export class GpuParticleWorld extends SceneObject {
  readonly name: string;
  private readonly options: GpuParticleWorldOptions;
  private _system: GpuParticleSystem | null = null;
  private gpu: GraphicsDevice | null = null;
  private readonly scratchRight = new Vec3();
  private readonly scratchUp = new Vec3();
  private lastDt = 1 / 60;

  constructor(options: GpuParticleWorldOptions) {
    super();
    this.name = options.name ?? "gpu-particles";
    this.options = options;
  }

  /** The live GPU system once {@link attachDevice} has completed init; null beforehand. */
  get system(): GpuParticleSystem | null {
    return this._system;
  }

  /** Bind the engine GPU device and kick off async pipeline creation. */
  attachDevice(gpu: GraphicsDevice): void {
    if (this.gpu === gpu && this._system?.ready) return;
    this.gpu = gpu;
    if (this._system) this._system.dispose();
    const system = new GpuParticleSystem(gpu, this.options);
    this._system = system;
    try {
      system.init();
    } catch (err) {
      console.error("GpuParticleWorld init failed", err);
    }
  }

  override update(_context: SystemContext, dt: number): void {
    this.lastDt = dt > 0 ? dt : this.lastDt;
  }

  /**
   * Write uniforms for this frame. Called by the renderer immediately before the graph builds the
   * particle passes. `viewProj` is column-major (engine {@link Mat4}).
   */
  prepareFrame(input: {
    dt?: number;
    viewProj: Float32Array | number[] | Mat4;
    cameraPos: { x: number; y: number; z: number };
    cameraRight?: { x: number; y: number; z: number };
    cameraUp?: { x: number; y: number; z: number };
  }): void {
    const system = this._system;
    if (!system?.ready) return;
    const vp = input.viewProj instanceof Mat4 ? input.viewProj.elements() : (input.viewProj as Float32Array);
    const right =
      input.cameraRight ??
      this.scratchRight.set(vp[0]!, vp[4]!, vp[8]!).normalize();
    const up = input.cameraUp ?? this.scratchUp.set(vp[1]!, vp[5]!, vp[9]!).normalize();
    system.prepare({
      dt: input.dt ?? this.lastDt,
      viewProj: vp,
      cameraPos: input.cameraPos,
      cameraRight: right,
      cameraUp: up,
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
