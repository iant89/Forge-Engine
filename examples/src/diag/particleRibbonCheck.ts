/**
 * Real-GPU ribbon pixel oracle (Phase 12.4/12.7). Two identically seeded GPU fountains — one
 * rendering trail ribbons, one not — are stepped the same fixed 30 Hz on an offscreen canvas and
 * read back. Because emission, integration and life are index-deterministic, both frames hold the
 * *same particles*: ribbons strictly add drawn area, so the lit area and mean luma of the ribbon
 * frame must exceed the plain frame's, with a margin. Draw order can still differ (the compact
 * list is atomic-filled), which is why the oracle is statistical-over-pixels and never per-pixel.
 * The animated demo scene is unusable for this (its fountain density drifts by more between
 * windows than the ribbon delta), hence the isolated re-run.
 */
import {
  BufferUsage, GraphicsDevice, GpuParticleSystem, RenderGraph, TextureUsage,
} from "@forge/engine";

export interface ParticleRibbonCheckResult {
  gpuExecuted: boolean;
  capacity: number;
  steps: number;
  litOn: number;
  litOff: number;
  meanOn: number;
  meanOff: number;
  /** Pixels the ribbon frame left darker than the plain frame — reported, never asserted. */
  darkerPixels: number;
  totalPixels: number;
  gpuErrors: number;
}

/** Identity-like perspective matrix (60° fov) for a camera at (0, 1.2, 4.5) looking down the plume axis. */
function viewProjOut(): Float32Array {
  const f = 1 / Math.tan((60 * Math.PI) / 180 / 2);
  const near = 0.1;
  const far = 100;
  // P * T(0, -1.2, -4.5), column-major (the camera sits at (0, 1.2, 4.5)).
  const p = [
    f, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0,
  ];
  const t = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1.2, -4.5, 1];
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = p[r]! * t[c * 4]! + p[4 + r]! * t[c * 4 + 1]! + p[8 + r]! * t[c * 4 + 2]! + p[12 + r]! * t[c * 4 + 3]!;
    }
  }
  return out;
}

export async function runParticleRibbonCheck(options: { size?: number; steps?: number; capacity?: number } = {}): Promise<ParticleRibbonCheckResult> {
  const extent = options.size ?? 128;
  const steps = options.steps ?? 36;
  const capacity = options.capacity ?? 256;
  const canvas = new OffscreenCanvas(extent, extent);
  const gpu = await GraphicsDevice.create({ canvas });
  if (gpu.isMock) {
    await gpu.dispose();
    throw new Error("particle ribbon pixel check requires real WebGPU");
  }
  const rowBytes = Math.ceil((extent * 4) / 256) * 256;
  const viewProj = viewProjOut();

  async function renderFountain(ribbons: boolean): Promise<Uint8Array> {
    const system = new GpuParticleSystem(gpu, {
      capacity,
      seed: 4242,
      maxEmitsPerFrame: 32,
      ribbons,
      ribbonSizeScale: 1.6,
      ribbonTailWidth: 0.6,
      softParticles: false,
      cullDistance: 1000,
      emitter: {
        // Sized so the ring never recycles a slot faster than particles die (256 slots / 6.7
        // per frame ≈ 38 frames > the 24-frame top life): every live particle carries a full
        // trail. A denser fountain would compare empty ribbon history against itself.
        rate: 200,
        lifeMin: 0.4,
        lifeMax: 0.8,
        size: 0.6,
        position: { x: 0, y: 0.6, z: 0 },
        jitter: { x: 0.15, y: 0.05, z: 0.15 },
        coneDir: { x: 0, y: 1, z: 0 },
        coneAngle: 0.5,
        // Fast enough that the 4-frame ring span (≈0.13 s) separates samples well beyond one
        // particle width — otherwise the strip hides under its own head billboard and the
        // coverage margin means nothing.
        speedMin: 7,
        speedMax: 11,
        color: { r: 0.9, g: 0.62, b: 0.2, a: 0.6 },
      },
      modules: {
        gravity: { x: 0, y: -9.81, z: 0 },
        drag: 0.2,
      },
    });
    await system.init();
    const color = gpu.device.createTexture({
      label: "ribbonCheck.color",
      size: { width: extent, height: extent },
      format: gpu.format,
      usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.COPY_SRC,
    });
    const depth = gpu.device.createTexture({
      label: "ribbonCheck.depth",
      size: { width: extent, height: extent },
      format: gpu.depthFormat,
      usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING,
    });
    const frame = {
      dt: 1 / 30,
      viewProj,
      cameraPos: { x: 0, y: 1.2, z: 4.5 },
      cameraRight: { x: 1, y: 0, z: 0 },
      cameraUp: { x: 0, y: 1, z: 0 },
    };
    const readback = gpu.device.createBuffer({
      label: "ribbonCheck.readback",
      size: rowBytes * extent,
      usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST,
    });
    try {
      for (let s = 0; s < steps; s++) {
        system.prepare(frame);
        const graph = new RenderGraph(gpu);
        graph.begin();
        const colorHandle = graph.importTexture("swapchain", color);
        const depthHandle = graph.importTexture("depth", depth);
        graph.addPass({
          name: "clear",
          color: [{ texture: colorHandle }],
          depth: { texture: depthHandle },
          execute: (ctx) => {
            ctx.beginRenderPass().end();
          },
        });
        system.enqueue(graph, {
          color: colorHandle,
          depth: depthHandle,
          colorFormat: gpu.format,
          depthFormat: gpu.depthFormat,
        });
        graph.execute();
      }
      const encoder = gpu.device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: color }, { buffer: readback, bytesPerRow: rowBytes, rowsPerImage: extent }, [extent, extent, 1]);
      gpu.device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const copy = new Uint8Array(readback.getMappedRange()).slice();
      readback.unmap();
      if (system.emitted <= 0) throw new Error("ribbon check fountain emitted nothing");
      return copy;
    } finally {
      readback.destroy();
      color.destroy();
      depth.destroy();
      system.dispose();
    }
  }

  try {
    const off = await renderFountain(false);
    const on = await renderFountain(true);
    const bgra = gpu.format.startsWith("bgra");
    let litOn = 0;
    let litOff = 0;
    let sumOn = 0;
    let sumOff = 0;
    let darker = 0;
    const pixels = extent * extent;
    for (let p = 0; p < pixels; p++) {
      const i = p * 4;
      const lOn = bgra ? on[i + 2]! * 0.299 + on[i + 1]! * 0.587 + on[i]! * 0.114 : on[i]! * 0.299 + on[i + 1]! * 0.587 + on[i + 2]! * 0.114;
      const lOff = bgra ? off[i + 2]! * 0.299 + off[i + 1]! * 0.587 + off[i]! * 0.114 : off[i]! * 0.299 + off[i + 1]! * 0.587 + off[i + 2]! * 0.114;
      if (lOn > 8) litOn++;
      if (lOff > 8) litOff++;
      if (lOn < lOff - 4) darker++;
      sumOn += lOn;
      sumOff += lOff;
    }
    return {
      gpuExecuted: true,
      capacity,
      steps,
      litOn,
      litOff,
      meanOn: sumOn / pixels,
      meanOff: sumOff / pixels,
      darkerPixels: darker,
      totalPixels: pixels,
      gpuErrors: gpu.totalErrorCount,
    };
  } finally {
    await gpu.dispose();
  }
}
