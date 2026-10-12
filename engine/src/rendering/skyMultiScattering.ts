/**
 * The multiple-scattering passes on the device (Phase 17.1): owns the transmittance table buffer,
 * the LUT buffer the sky pass samples, the two compute pipelines and their bind group, and records
 * `forge.sky.ms.table` + `forge.sky.ms.lut` into a frame.
 *
 * The renderer records these only on the frames the table can have changed — a sun that has moved
 * past `MS_SUN_EPSILON`, an atmosphere that was edited, a fresh device. A still frame therefore
 * carries the sky exactly as before, and a moving sun costs two dispatches that together walk the
 * same integral the CPU reference (`environment/multiScattering.ts`) walks in JavaScript.
 *
 * Both buffers are `STORAGE | COPY_DST`; nothing is uploaded from the CPU, so the CPU build is only
 * the reference/ambient path, never a source of pixels. `docs/ENVIRONMENT.md` §8.
 */

import { BufferUsage, ShaderStage } from "../gpu/constants.js";
import type { GraphicsDevice } from "../gpu/device.js";
import type { ShaderCache } from "../gpu/shaderCache.js";
import type { RenderGraph, RenderGraphPassContext } from "./renderGraph.js";
import { MULTI_SCATTERING_SHADER, MS_BINDINGS, MS_ENTRY, MS_LUT_TEXEL_BYTES, MS_LUT_TEXELS, MS_TABLE_TEXELS, MS_WORKGROUP } from "./shaders/multiScattering.js";

/** Sun movement (dot-product cosine of the angle) that invalidates the table. */
export const MS_SUN_EPSILON = 0.9999619; // cos(0.5°): half a degree of sun travel

/**
 * Everything the table depends on, packed into `out` so the renderer can tell whether a rebuild is
 * needed without allocating or hashing strings. The atmosphere params may be mutated in place
 * (a day/night cycle edits them), so identity alone is not enough.
 */
export function writeSkyMultiScatteringSignature(
  params: {
    planetRadius: number;
    atmosphereHeight: number;
    rayleighScattering: readonly number[];
    rayleighScaleHeight: number;
    mieScattering: readonly number[];
    mieExtinction: readonly number[];
    mieScaleHeight: number;
    mieAnisotropy: number;
    ozoneAbsorption: readonly number[];
    ozoneCenter: number;
    ozoneWidth: number;
  },
  turbidity: number,
  rayleigh: number,
  mie: number,
  out: Float64Array,
): void {
  out[0] = params.planetRadius;
  out[1] = params.atmosphereHeight;
  out[2] = params.rayleighScaleHeight;
  out[3] = params.mieScaleHeight;
  out[4] = params.mieAnisotropy;
  out[5] = params.ozoneCenter;
  out[6] = params.ozoneWidth;
  for (let c = 0; c < 3; c++) {
    out[7 + c] = params.rayleighScattering[c]!;
    out[10 + c] = params.mieScattering[c]!;
    out[13 + c] = params.mieExtinction[c]!;
    out[16 + c] = params.ozoneAbsorption[c]!;
  }
  out[19] = turbidity;
  out[20] = rayleigh;
  out[21] = mie;
}

/** True when two signatures differ anywhere (a NaN field counts as different from itself). */
export function skyMultiScatteringSignatureChanged(a: Float64Array, b: Float64Array): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return true;
  }
  return false;
}

export class GpuMultiScattering {
  private tableBuffer: GPUBuffer | null = null;
  private lutBuffer: GPUBuffer | null = null;
  private tablePipeline: GPUComputePipeline | null = null;
  private fieldPipeline: GPUComputePipeline | null = null;
  private group: GPUBindGroup | null = null;
  /** The sky uniform buffer the current bind group was built from (it is stable per renderer). */
  private groupSky: GPUBuffer | null = null;
  private disposed = false;

  constructor(
    private readonly device: GraphicsDevice,
    private readonly shaders: ShaderCache,
  ) {}

  /** The LUT buffer the sky pass binds at `SKY_BINDINGS.multiScattering`; null before `prepare`. */
  get lut(): GPUBuffer | null {
    return this.lutBuffer;
  }

  /**
   * Create the buffers and pipelines (idempotent) and return the LUT buffer the sky pass binds. The
   * sky bind group is built from this even on frames that record no pass, so the frame's binding is
   * stable while the contents are rebuilt.
   */
  prepare(skyBuffer: GPUBuffer): GPUBuffer {
    this.ensureResources(skyBuffer);
    return this.lutBuffer!;
  }

  /**
   * Add both compute passes to the frame. `skyBuffer` is the frame's `SkyUniforms` (already written
   * for this frame); it is the only input either dispatch reads.
   */
  record(graph: RenderGraph, skyBuffer: GPUBuffer): void {
    if (this.disposed) return;
    this.ensureResources(skyBuffer);
    graph.addPass({ name: "forge.sky.ms.table", sideEffect: true, execute: (ctx) => this.encode(ctx, MS_ENTRY.transmittance, this.tableBuffer!) });
    graph.addPass({ name: "forge.sky.ms.lut", sideEffect: true, execute: (ctx) => this.encode(ctx, MS_ENTRY.field, this.lutBuffer!) });
  }

  /**
   * Copy the contents of the LUT back and resolve to them as f32 in the stored order
   * (`heightSamples × sunSamples` texels of `(rgb = J_ms / sunIntensity, a = mean ρ)`). This is a
   * diagnostics/verification path, not part of a frame: `tests/environment/environment17.test.ts`
   * and `npm run check:browser` compare the table a real device built with the CPU twin's.
   * Resolves to null before the first build (or after {@link dispose}).
   */
  async readLut(): Promise<Float32Array | null> {
    const lut = this.lutBuffer;
    if (!lut || this.disposed) return null;
    const bytes = MS_LUT_TEXELS * MS_LUT_TEXEL_BYTES;
    const d = this.device.device;
    const staging = d.createBuffer({ label: "sky.ms.readback", size: bytes, usage: BufferUsage.COPY_DST | BufferUsage.MAP_READ });
    try {
      const encoder = d.createCommandEncoder({ label: "sky.ms.readback" });
      encoder.copyBufferToBuffer(lut, 0, staging, 0, bytes);
      d.queue.submit([encoder.finish()]);
      await staging.mapAsync(BufferUsage.MAP_READ);
      return new Float32Array(staging.getMappedRange(0, bytes).slice(0));
    } finally {
      if (!this.disposed) {
        try {
          staging.unmap();
        } catch {
          // Already unmapped (or the device went away) — nothing to release either way.
        }
      }
      staging.destroy();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.tableBuffer?.destroy();
    this.tableBuffer = null;
    this.lutBuffer?.destroy();
    this.lutBuffer = null;
    this.tablePipeline = null;
    this.fieldPipeline = null;
    this.group = null;
    this.groupSky = null;
  }

  /**
   * One pipeline per entry point (they differ only in the compute stage), sharing the module and the
   * layout: a uniform for the sky block and two storage buffers.
   */
  private ensureResources(skyBuffer: GPUBuffer): void {
    const d = this.device.device;
    this.tableBuffer ??= d.createBuffer({
      label: "sky.ms.table",
      size: MS_TABLE_TEXELS * MS_LUT_TEXEL_BYTES,
      usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
    });
    this.lutBuffer ??= d.createBuffer({
      label: "sky.ms.lut",
      size: MS_LUT_TEXELS * MS_LUT_TEXEL_BYTES,
      // COPY_SRC is only for `readLut` — the verification path reads the table back and compares it
      // with the CPU twin; nothing in a frame copies it.
      usage: BufferUsage.STORAGE | BufferUsage.COPY_DST | BufferUsage.COPY_SRC,
    });
    if (!this.tablePipeline) {
      const module = this.shaders.get("sky.ms.wgsl", MULTI_SCATTERING_SHADER);
      const layout = d.createBindGroupLayout({
        label: "sky.ms",
        entries: [
          { binding: MS_BINDINGS.sky.binding, visibility: ShaderStage.COMPUTE, buffer: { type: "uniform" } },
          { binding: MS_BINDINGS.transmittance.binding, visibility: ShaderStage.COMPUTE, buffer: { type: "storage" } },
          { binding: MS_BINDINGS.lut.binding, visibility: ShaderStage.COMPUTE, buffer: { type: "storage" } },
        ],
      });
      const pipelineLayout = d.createPipelineLayout({ label: "sky.ms", bindGroupLayouts: [layout] });
      this.tablePipeline = d.createComputePipeline({
        label: `sky.ms.${MS_ENTRY.transmittance}`,
        layout: pipelineLayout,
        compute: { module, entryPoint: MS_ENTRY.transmittance },
      });
      this.fieldPipeline = d.createComputePipeline({
        label: `sky.ms.${MS_ENTRY.field}`,
        layout: pipelineLayout,
        compute: { module, entryPoint: MS_ENTRY.field },
      });
    }
    if (!this.group || this.groupSky !== skyBuffer) {
      this.group = d.createBindGroup({
        label: "sky.ms",
        layout: this.tablePipeline.getBindGroupLayout(0),
        entries: [
          { binding: MS_BINDINGS.sky.binding, resource: { buffer: skyBuffer } },
          { binding: MS_BINDINGS.transmittance.binding, resource: { buffer: this.tableBuffer } },
          { binding: MS_BINDINGS.lut.binding, resource: { buffer: this.lutBuffer } },
        ],
      });
      this.groupSky = skyBuffer;
    }
  }

  /** One invocation per texel, `MS_WORKGROUP` per workgroup; both dispatches are trivial. */
  private encode(ctx: RenderGraphPassContext, entry: string, target: GPUBuffer): void {
    const pass = ctx.beginComputePass(`sky.ms.${entry === MS_ENTRY.transmittance ? "table" : "lut"}`);
    const pipeline = entry === MS_ENTRY.transmittance ? this.tablePipeline : this.fieldPipeline;
    if (!pipeline) {
      pass.end();
      return;
    }
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.group!);
    const texels = target === this.tableBuffer ? MS_TABLE_TEXELS : MS_LUT_TEXELS;
    pass.dispatchWorkgroups(Math.ceil(texels / MS_WORKGROUP));
    pass.end();
  }
}
